# Autodecision — SaaS gestion pièces auto

Multi-tenant SaaS for auto-parts shops (magasins). Each shop subscribes, gets its own
organization, and manages orders, réceptions, stock, retours, avoirs, caisse, tournées
and rapports from a single dashboard. Garages get a B2B portal, drivers a mobile page.

## Stack

- **Next.js 16** (App Router, webpack build) + **React 19**
- **Supabase** — Postgres + Auth, multi-tenancy via `organization_id` + **Row-Level Security**;
  every write that moves money or stock goes through a `security definer` RPC
- **Tailwind CSS v4** + custom design system in `apps/web/src/app/globals.css`
- npm workspaces monorepo — the only app is `apps/web`. Node 22 (`.nvmrc`).

## Local setup

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # fill in every variable listed there
npm run dev                                     # http://localhost:3000
```

Checks: `npm run typecheck`, `npm run lint --workspace=web`, `npm test` (Vitest: money
maths, tournées, relevés). The same steps run in CI (`.github/workflows/ci.yml`).

## Database

`supabase/migrations/` is the **single source of truth**. Never run the files in
`supabase/legacy/` on a migrated project: they predate the RLS hardening and would
re-open permissive policies.

```bash
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push            # applies pending migrations
```

Create each database change as a new `supabase/migrations/<timestamp>_<slug>.sql`.
Diagnostics that are safe to run any time: `supabase/check_app_schema.sql` (columns the
app expects) and `supabase/audit_rls_isolation.sql` (cross-tenant isolation, rolled back).

Signup flow: `/admin/signup` (`/signup` redirects there) creates the owner's organization via the `handle_new_user`
trigger (owner becomes ADMIN, 14-day trial). Spaces: `/admin` (org admin), `/dashboard`
(counter staff), `/garagiste` (B2B portal), `/livreur` (drivers), `/superadmin` (SaaS
owner, bound to `platform_owners`).

Supabase → Authentication → URL configuration must list `<site>/auth/callback`
(password reset and invitation links land there).

## Deployment (Netlify)

`netlify.toml` builds from the repo root (`npm --workspace web run build`, publish
`apps/web/.next`, `@netlify/plugin-nextjs`). Set every variable of
`apps/web/.env.example` in the Netlify site environment (server-only ones without
`NEXT_PUBLIC_`). Health check: `GET /api/health`.

## Project layout

```
apps/web/src/
  app/dashboard/        # counter pages (commandes, réception, caisse, stock, retours, …)
  app/garagiste/        # B2B portal      app/livreur/   # driver mobile page
  app/admin/ app/superadmin/ app/*/login   # admin spaces and per-space login doors
  app/api/              # server routes (service role): team, accesses, sms, superadmin, health
  components/auth/      # client gates (DashboardGate, AdminGate, GarageGate)
  lib/data/             # Supabase data layer (one module per domain) + unit tests
  middleware.ts         # anonymous visitors are sent to the right login door
supabase/migrations/    # schema, RLS, RPCs (source of truth)
supabase/legacy/        # historical scripts — do not run
```

## Abonnement Stripe (optionnel)

Le paiement en ligne est activé par les variables `STRIPE_*` de `apps/web/.env.example`.
Sans elles, `/tarifs` propose de vous contacter et `/api/billing/*` répond 503.

1. Créez un produit avec un prix mensuel (et un prix annuel si besoin) dans Stripe ;
   copiez les `price_…` dans `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_YEARLY`.
2. Ajoutez un webhook vers `https://<votre-app>/api/billing/webhook` avec les événements
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`, puis copiez le secret
   dans `STRIPE_WEBHOOK_SECRET`.
3. Le webhook écrit `subscription_status`, `plan`, `current_period_end` et les identifiants Stripe
   sur `organizations` ; l'application verrouille le tableau de bord sur `past_due`, `unpaid`,
   `canceled` (voir `lib/data/billing.ts`). Le superadmin peut toujours suspendre / activer à la main.
