# Autodecision — SaaS gestion pièces auto

Multi-tenant SaaS for auto-parts shops (magasins). Each shop subscribes, gets its own
organization, and manages orders, réceptions, stock, retours, avoirs, tournées and
rapports from a single dashboard.

## Stack

- **Next.js 16** (App Router, webpack build) + **React 19**
- **Supabase** — Postgres + Auth, multi-tenancy via `organization_id` + **Row-Level Security**
- **Tailwind CSS v4** + custom design system in `apps/web/src/app/globals.css`
- npm workspaces monorepo — the only app is `apps/web`

## Local setup

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # fill in your Supabase URL + anon key
npm run dev                                     # http://localhost:3000
```

## Database setup (Supabase SQL Editor, in order)

1. `supabase/full_saas.sql` — full schema: tables, enums, RLS policies, signup trigger, RPCs
2. `supabase/operational_rpc.sql` — `receive_order_line`, `adjust_stock_item`
3. `supabase/fix_order_refs.sql` — per-org order refs + hardened `next_ref_demande`
4. `supabase/check_app_schema.sql` — audit: returns the columns the app needs that are missing (0 rows = healthy)
5. Optional: `supabase/seed_orders.sql`, `supabase/enrich_seed.sql` — demo data

Signup flow: `/signup` creates the owner's organization via the `handle_new_user`
trigger (owner becomes ADMIN, 14-day TRIAL). All roles log into `/dashboard`.

## Deployment (Vercel)

1. Import the GitHub repo in Vercel.
2. **Root Directory:** `apps/web` (enable "Include source files outside of the Root Directory").
3. Framework preset: Next.js (build command comes from `apps/web/package.json`).
4. Environment variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
5. In Supabase → Authentication → URL Configuration, add the Vercel URL to
   Site URL / Redirect URLs.

## Schema migrations (recommended next step)

Adopt the Supabase CLI so the database is version-controlled instead of ad-hoc SQL files:

```bash
npm install -g supabase
supabase login
supabase init                       # creates supabase/config.toml
supabase link --project-ref <your-project-ref>
supabase db pull                    # baseline migration from the live DB
```

After that, every schema change is a new file in `supabase/migrations/` applied with
`supabase db push`.

## Project layout

```
apps/web/src/
  app/dashboard/        # all pages (commandes, réception, stock, retours, …)
  app/login, signup     # auth pages
  components/auth/      # DashboardGate (client-side session/role gate)
  lib/data/             # Supabase data layer (orders, saas, commandes, dashboard)
  lib/pdf/order-pdf.ts  # PDF → order form auto-fill parser
  proxy.ts              # Next middleware: server-side session redirect
supabase/               # SQL: schema, RPCs, fixes, seeds, audits
```
