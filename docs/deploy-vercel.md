# Deploying to Vercel

The app runs on Vercel (Pro plan) at `https://app.autodecision.pro`; the database
is on Supabase. Every push to `main` deploys. The app moved there from Netlify in
October 2026; the Netlify configuration is no longer in the repo (section 8).

What is in the repo:

- `apps/web/vercel.json` — server code runs in Frankfurt (`fra1`, the closest Vercel
  region to the database in Zurich) and a job calls `/api/notifications/dispatch`
  every 10 minutes (section 7).
- `apps/web/package.json` — Node 22.

The steps below are how the project was set up; follow them again to rebuild it.

## 1. Create the project

1. On vercel.com, **Add New → Project** and import the GitHub repository
   `aminoz12/Autodecision`.
2. **Root Directory**: `apps/web`. Leave "Include files outside the root directory"
   enabled (the dependencies are installed from the repo root).
3. **Framework Preset**: Next.js (detected). Leave the build, install and output
   settings on their defaults.
4. Do not deploy yet: add the environment variables first (step 2).

The plan must be **Pro**: Vercel's free plan does not allow commercial use.

## 2. Environment variables

Set them in Vercel (**Settings → Environment Variables**), for the **Production**
environment.
Names and meaning are documented in `apps/web/.env.example`.

| Variable | Needed | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | same page |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | same page — secret, server only |
| `NEXT_PUBLIC_APP_URL` | yes | the final address, `https://…`, no trailing slash |
| `CRON_SECRET` | yes | any long random string; the cron job is refused without it |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | for real SMS | empty = SMS are simulated |
| `SMS_DEFAULT_COUNTRY_CODE` | for SMS | `33` |
| `TWILIO_WHATSAPP_FROM` | optional | WhatsApp sender |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional | e-mail notifications |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` | optional | subscriptions |
| `NEXT_PUBLIC_PRICE_MONTHLY_EUR`, `NEXT_PUBLIC_PRICE_YEARLY_EUR` | optional | prices shown on `/tarifs` |
| `SUPERADMIN_EMAILS` | optional | extra owner accounts |

Only set them for **Production** unless you want preview deployments (one per
branch) to work too — a preview with these values talks to the real database.

A variable starting with `NEXT_PUBLIC_` is baked in at build time: after changing
one, redeploy.

## 3. Deploy and check

1. Press **Deploy**. The first build takes a few minutes.
2. Open `https://<the-vercel-address>/api/health` — it must answer
   `{"ok":true,"db":"up",…}`.
3. Open `/caissier/login`; signing in will only work after step 4.

## 4. Tell the other services about the new address

- **Supabase → Authentication → URL Configuration**: add
  `https://<new-address>/auth/callback` to *Redirect URLs* and set *Site URL* to
  the new address.
  Without this, password-reset and invitation links land on an error page.
- **Stripe** (only if subscriptions are on): add a webhook endpoint
  `https://<new-address>/api/billing/webhook`, put its signing secret in
  `STRIPE_WEBHOOK_SECRET` on Vercel, redeploy.
- **Twilio**: nothing to change, the app only sends.

## 5. Your own domain (recommended before telling the team)

**Settings → Domains** on Vercel, add for example `app.autodecision.fr` and create
the DNS record Vercel shows. Then use that address everywhere in step 4 and in
`NEXT_PUBLIC_APP_URL`. Doing this now means the team changes address once, not twice.

## 6. What changes for the team

- A new address means a new sign-in for everyone: sessions do not follow.
- Livreurs who installed the app on their phone must open the new address and
  install it again; the old icon keeps pointing to Netlify.
- SMS already sent keep their old links (`/avis/…`, `/stop/…`): leave the Netlify
  site running for a few weeks so they still open.

## 7. The cron job

`vercel.json` calls `/api/notifications/dispatch` every 10 minutes (`*/10 * * * *`,
Pro plan; the free plan only allows a daily job). Each run sends the queued e-mails
and SMS, even when nobody has the dashboard open; the scheduled reminders (due
dates, unpaid accounts, after-sales reminders), which scan every order, run at most
about once an hour. SMS to clients only leave between 8h and 20h Paris time,
whatever the hour of the run. During the day the notification bell of any signed-in
user triggers the same route.

Check it under **Settings → Cron Jobs**: a run answers 200. A 401 means
`CRON_SECRET` is missing or was changed without a redeploy.

## 8. The old Netlify site

`netlify.toml` and the `@netlify/plugin-nextjs` dev dependency were removed from
the repo on 2026-10-05. On Netlify, **Site configuration → Build & deploy → Stop
builds**: the last successful deploy stays online, so links in SMS sent before the
move (`/avis/…`, `/stop/…` on `autodecision.netlify.app`) keep opening. Delete the
site once those links no longer matter (a few weeks).

To go back to Netlify one day, revert the commit that removed `netlify.toml`.
