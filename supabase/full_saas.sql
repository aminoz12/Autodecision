-- ============================================================================
--  FULL SAAS SCHEMA — Pièces Auto (multi-tenant, RLS)
--  Run this whole file in the Supabase SQL Editor (one transaction).
--  It is IDEMPOTENT: safe to run on a fresh project OR on top of an existing
--  one (it only creates what's missing). It supersedes schema.sql +
--  owner_signup.sql by including everything they do, plus the SaaS layer:
--  billing, garages, vehicles, reception/reliquats, tournées, retours,
--  avoirs/consignes, SMS, and team invitations.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. ENUM TYPES
-- ----------------------------------------------------------------------------
do $$ begin create type public.user_role as enum ('CAISSIER','ADMIN','LIVREUR'); exception when duplicate_object then null; end $$;
do $$ begin create type public.canal_vente as enum ('MAGASIN','TÉLÉPHONE','INTERNET','B2B','AUTRE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.statut_paiement as enum ('NON_PAYÉ','PARTIEL','PAYÉ'); exception when duplicate_object then null; end $$;
do $$ begin create type public.statut_livreur as enum ('EN_ATTENTE','EN_COURS','LIVRÉ'); exception when duplicate_object then null; end $$;
do $$ begin create type public.workflow_status as enum ('PENDING','TO_COLLECT','IN_TRANSIT','DELIVERED'); exception when duplicate_object then null; end $$;

-- SaaS additions
do $$ begin create type public.subscription_plan as enum ('TRIAL','STARTER','PRO','ENTERPRISE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.reception_status as enum ('PENDING','RECEIVED','BACKORDER','NOT_RECEIVED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.return_type as enum ('RETOURNABLE','RETOUR_IMPOSSIBLE','CONSIGNE','DELAI_DEPASSE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.return_treatment as enum ('A_TRAITER','DEMANDE_ENVOYEE','A_RECUPERER','ACCEPTE','REFUSE','REMBOURSE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.credit_status as enum ('EN_COURS','PARTIEL','UTILISE','EXPIRE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.tour_status as enum ('PLANIFIEE','EN_COURS','TERMINEE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.sms_status as enum ('A_ENVOYER','ENVOYE','ECHEC'); exception when duplicate_object then null; end $$;
do $$ begin create type public.invitation_status as enum ('PENDING','ACCEPTED','REVOKED','EXPIRED'); exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- 2. CORE TENANT TABLES (create-if-not-exists keeps existing data intact)
-- ----------------------------------------------------------------------------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  subscription_status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  display_name text not null,
  role public.user_role not null default 'CAISSIER',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  phone text,
  email text,
  immatriculation text,
  vehicle_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  sku text not null,
  name text not null,
  quantity_on_hand integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, sku)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ref_demande text not null,
  date_commande date not null,
  vendeur_id uuid not null references auth.users (id) on delete restrict,
  canal_vente public.canal_vente not null,
  client_id uuid references public.clients (id) on delete set null,
  client_phone text not null,
  client_email text,
  immatriculation text,
  vehicle_model text,
  montant_total numeric(14,2) not null,
  devis boolean not null default false,
  statut_paiement public.statut_paiement not null,
  montant_paye numeric(14,2) not null default 0,
  avance_payee numeric(14,2) not null default 0,
  solde_restant numeric(14,2) not null,
  envoyer_au_livreur boolean not null default false,
  date_envoi timestamptz,
  statut_livreur public.statut_livreur not null default 'EN_ATTENTE',
  consigne text,
  workflow_status public.workflow_status not null default 'PENDING',
  bl boolean not null default false,
  date_bl date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, ref_demande)
);

create table if not exists public.order_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  nom_produit text not null,
  reference text not null,
  supplier_id uuid references public.suppliers (id) on delete set null,
  quantity integer not null,
  a_commander_pour_livreur boolean not null default false,
  depuis_magasin boolean not null default false,
  retour_stock_fait boolean not null default false,
  prix_achat_unitaire numeric(14,2) not null,
  prix_vente_unitaire numeric(14,2) not null
);

create table if not exists public.delivery_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  assigned_livreur_id uuid references auth.users (id) on delete set null,
  workflow_status public.workflow_status not null default 'TO_COLLECT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.supplier_receptions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  reference text not null,
  received boolean not null default false,
  received_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, reference)
);

create table if not exists public.sales_returns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid,
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null,
  amount numeric(14,2) not null,
  order_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.consignment_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null,
  description text not null,
  quantity integer not null default 1,
  status text not null default 'ACTIF',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ref text not null,
  created_by_id uuid not null references auth.users (id) on delete cascade,
  payload jsonb not null,
  converted_order_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, ref)
);

-- ----------------------------------------------------------------------------
-- 3. SAAS COLUMN ADDITIONS (idempotent — add only if missing)
-- ----------------------------------------------------------------------------

-- organizations: billing + settings
alter table public.organizations add column if not exists plan public.subscription_plan not null default 'TRIAL';
alter table public.organizations add column if not exists stripe_customer_id text;
alter table public.organizations add column if not exists stripe_subscription_id text;
alter table public.organizations add column if not exists trial_ends_at timestamptz;
alter table public.organizations add column if not exists current_period_end timestamptz;
alter table public.organizations add column if not exists seat_limit integer not null default 3;
alter table public.organizations add column if not exists currency text not null default 'EUR';
alter table public.organizations add column if not exists locale text not null default 'fr-FR';
alter table public.organizations add column if not exists phone text;
alter table public.organizations add column if not exists address text;
alter table public.organizations add column if not exists city text;
alter table public.organizations add column if not exists logo_url text;
alter table public.organizations add column if not exists sms_sender text;
alter table public.organizations add column if not exists updated_at timestamptz not null default now();

-- clients (garages): CRM fields
alter table public.clients add column if not exists city text;
alter table public.clients add column if not exists is_professional boolean not null default true;
alter table public.clients add column if not exists is_active boolean not null default true;
alter table public.clients add column if not exists rating numeric(2,1);
alter table public.clients add column if not exists notes text;

-- order_lines: reception / reliquat tracking
alter table public.order_lines add column if not exists qte_recue integer not null default 0;
alter table public.order_lines add column if not exists reception_status public.reception_status not null default 'PENDING';
alter table public.order_lines add column if not exists received_at timestamptz;
alter table public.order_lines add column if not exists origine text not null default 'client'; -- client | stock | garage
alter table public.order_lines add column if not exists tour_id uuid;
alter table public.order_lines add column if not exists prevue_le timestamptz;

-- sales_returns (retours): full lifecycle
alter table public.sales_returns add column if not exists ref text;
alter table public.sales_returns add column if not exists client_id uuid;
alter table public.sales_returns add column if not exists supplier_id uuid;
alter table public.sales_returns add column if not exists type_retour public.return_type;
alter table public.sales_returns add column if not exists statut_traitement public.return_treatment;
alter table public.sales_returns add column if not exists decote_pct numeric(5,2) not null default 0;
alter table public.sales_returns add column if not exists montant numeric(14,2);
alter table public.sales_returns add column if not exists motif text;
alter table public.sales_returns add column if not exists designation text;
alter table public.sales_returns add column if not exists echeance date;
alter table public.sales_returns add column if not exists updated_at timestamptz not null default now();

-- credit_notes (avoirs): status + maturity
alter table public.credit_notes add column if not exists num text;
alter table public.credit_notes add column if not exists statut public.credit_status not null default 'EN_COURS';
alter table public.credit_notes add column if not exists echeance date;
alter table public.credit_notes add column if not exists motif text;
alter table public.credit_notes add column if not exists designation text;
alter table public.credit_notes add column if not exists updated_at timestamptz not null default now();

-- consignment_entries (consignes): amount + maturity + supplier
alter table public.consignment_entries add column if not exists num text;
alter table public.consignment_entries add column if not exists montant numeric(14,2);
alter table public.consignment_entries add column if not exists echeance date;
alter table public.consignment_entries add column if not exists supplier_id uuid references public.suppliers (id) on delete set null;
alter table public.consignment_entries add column if not exists motif text;

-- ----------------------------------------------------------------------------
-- 4. NEW TABLES
-- ----------------------------------------------------------------------------

-- Vehicles owned by a client/garage (orders still keep their inline plate/model)
create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete cascade,
  plate text,
  model text,
  vin text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Delivery tours (tournées)
create table if not exists public.delivery_tours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  livreur_id uuid references auth.users (id) on delete set null,
  vehicle_label text,
  slot_start time,
  slot_end time,
  tour_date date not null default current_date,
  status public.tour_status not null default 'PLANIFIEE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- order_lines.tour_id -> delivery_tours (added as FK now that the table exists)
do $$ begin
  alter table public.order_lines
    add constraint order_lines_tour_id_fkey
    foreign key (tour_id) references public.delivery_tours (id) on delete set null;
exception when duplicate_object then null; end $$;

-- SMS notifications to clients (Commande SMS)
create table if not exists public.sms_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  phone text,
  message text,
  status public.sms_status not null default 'A_ENVOYER',
  traite boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

-- Team invitations (invite a cashier/livreur to an existing magasin)
create table if not exists public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email text not null,
  role public.user_role not null default 'CAISSIER',
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  status public.invitation_status not null default 'PENDING',
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 5. HELPER FUNCTIONS
-- ----------------------------------------------------------------------------

-- Current user's org (no profiles subquery in policies -> avoids RLS recursion)
create or replace function public.current_user_org_id()
returns uuid language sql stable security definer set search_path = public as $$
  select p.organization_id from public.profiles p where p.user_id = auth.uid() limit 1;
$$;
grant execute on function public.current_user_org_id() to authenticated;

create or replace function public.current_user_role()
returns public.user_role language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p where p.user_id = auth.uid() limit 1;
$$;
grant execute on function public.current_user_role() to authenticated;

-- Per-org, per-year sequential reference: PREFIX-YYYY-NNNNN
create or replace function public.next_ref_demande(p_org uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  y int := extract(year from current_date);
  prefix constant text := format('REQ-%s-', y);
  next_n int;
begin
  select coalesce(max(right(o.ref_demande, 5)::int), 0) + 1 into next_n
  from orders o
  where o.organization_id = p_org
    and o.ref_demande like prefix || '%'
    and length(o.ref_demande) >= length(prefix) + 5;
  return prefix || lpad(next_n::text, 5, '0');
end;
$$;
grant execute on function public.next_ref_demande(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. SIGNUP TRIGGER — owner gets a NEW org as ADMIN; invitee joins existing org
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_org uuid;
  r public.user_role;
  display text;
  org_name text;
  new_slug text;
begin
  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');

  -- (1) Invited member — explicit organization_id in metadata
  begin
    target_org := nullif(new.raw_user_meta_data->>'organization_id', '')::uuid;
  exception when others then target_org := null; end;

  if target_org is not null then
    begin
      r := coalesce((new.raw_user_meta_data->>'role')::public.user_role, 'CAISSIER'::public.user_role);
    exception when others then r := 'CAISSIER'::public.user_role; end;

  -- (2) Owner signup — create a new organization, become ADMIN
  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin') || '-' || substr(replace(new.id::text, '-', ''), 1, 8);
    insert into public.organizations (name, slug, plan, trial_ends_at)
    values (org_name, new_slug, 'TRIAL', now() + interval '14 days')
    returning id into target_org;
    r := 'ADMIN'::public.user_role;

  -- (3) Fallback — legacy shared default org as CAISSIER
  else
    insert into public.organizations (id, name, slug)
    values ('00000000-0000-4000-8000-000000000001', 'Magasin principal', 'default')
    on conflict (slug) do nothing;
    select id into target_org from public.organizations where slug = 'default' limit 1;
    if target_org is null then
      select id into target_org from public.organizations order by created_at limit 1;
    end if;
    r := 'CAISSIER'::public.user_role;
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Utilisateur'
  );

  insert into public.profiles (user_id, organization_id, display_name, role)
  values (new.id, target_org, display, r)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    display_name = excluded.display_name,
    role = excluded.role,
    updated_at = now();

  -- mark a matching invitation accepted (if any)
  update public.invitations
     set status = 'ACCEPTED'
   where organization_id = target_org
     and lower(email) = lower(coalesce(new.email, ''))
     and status = 'PENDING';

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 7. updated_at auto-touch
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'organizations','profiles','clients','suppliers','stock_items','orders',
    'delivery_tasks','supplier_receptions','consignment_entries','quotes',
    'sales_returns','credit_notes','vehicles','delivery_tours'
  ] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 8. INDEXES
-- ----------------------------------------------------------------------------
create index if not exists idx_profiles_org      on public.profiles (organization_id);
create index if not exists idx_clients_org        on public.clients (organization_id);
create index if not exists idx_suppliers_org      on public.suppliers (organization_id);
create index if not exists idx_stock_org          on public.stock_items (organization_id);
create index if not exists idx_orders_org         on public.orders (organization_id);
create index if not exists idx_orders_client      on public.orders (client_id);
create index if not exists idx_order_lines_org    on public.order_lines (organization_id);
create index if not exists idx_order_lines_order  on public.order_lines (order_id);
create index if not exists idx_order_lines_tour   on public.order_lines (tour_id);
create index if not exists idx_order_lines_recep  on public.order_lines (reception_status);
create index if not exists idx_delivery_tasks_org on public.delivery_tasks (organization_id);
create index if not exists idx_receptions_org     on public.supplier_receptions (organization_id);
create index if not exists idx_returns_org        on public.sales_returns (organization_id);
create index if not exists idx_credits_org        on public.credit_notes (organization_id);
create index if not exists idx_consign_org        on public.consignment_entries (organization_id);
create index if not exists idx_quotes_org         on public.quotes (organization_id);
create index if not exists idx_vehicles_org       on public.vehicles (organization_id);
create index if not exists idx_vehicles_client    on public.vehicles (client_id);
create index if not exists idx_tours_org          on public.delivery_tours (organization_id);
create index if not exists idx_sms_org            on public.sms_notifications (organization_id);
create index if not exists idx_sms_order          on public.sms_notifications (order_id);
create index if not exists idx_invitations_org    on public.invitations (organization_id);
create index if not exists idx_invitations_email  on public.invitations (lower(email));

-- ----------------------------------------------------------------------------
-- 9. ROW-LEVEL SECURITY
-- ----------------------------------------------------------------------------
alter table public.organizations      enable row level security;
alter table public.profiles           enable row level security;
alter table public.clients            enable row level security;
alter table public.suppliers          enable row level security;
alter table public.stock_items        enable row level security;
alter table public.orders             enable row level security;
alter table public.order_lines        enable row level security;
alter table public.delivery_tasks     enable row level security;
alter table public.supplier_receptions enable row level security;
alter table public.sales_returns      enable row level security;
alter table public.credit_notes       enable row level security;
alter table public.consignment_entries enable row level security;
alter table public.quotes             enable row level security;
alter table public.vehicles           enable row level security;
alter table public.delivery_tours     enable row level security;
alter table public.sms_notifications  enable row level security;
alter table public.invitations        enable row level security;

-- organizations: members read; admins update settings/billing
drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations for select
  using (id = public.current_user_org_id());
drop policy if exists org_update on public.organizations;
create policy org_update on public.organizations for update
  using (id = public.current_user_org_id() and public.current_user_role() = 'ADMIN')
  with check (id = public.current_user_org_id());

-- profiles: read self + org mates; update self; admins manage org members
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (user_id = auth.uid() or organization_id = public.current_user_org_id());
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (user_id = auth.uid() or (organization_id = public.current_user_org_id() and public.current_user_role() = 'ADMIN'));
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete
  using (organization_id = public.current_user_org_id() and public.current_user_role() = 'ADMIN' and user_id <> auth.uid());

-- Generic per-tenant "all" policy for straightforward tenant tables
do $$
declare t text;
begin
  foreach t in array array[
    'clients','suppliers','stock_items','order_lines','delivery_tasks',
    'supplier_receptions','sales_returns','credit_notes','consignment_entries',
    'vehicles','delivery_tours','sms_notifications'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_all', t);
    execute format(
      'create policy %I on public.%I for all
         using (organization_id = public.current_user_org_id())
         with check (organization_id = public.current_user_org_id())',
      t || '_all', t);
  end loop;
end $$;

-- orders: split policies (insert must be the logged-in vendeur)
drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select using (organization_id = public.current_user_org_id());
drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders for insert with check (organization_id = public.current_user_org_id() and vendeur_id = auth.uid());
drop policy if exists orders_update on public.orders;
create policy orders_update on public.orders for update using (organization_id = public.current_user_org_id());
drop policy if exists orders_delete on public.orders;
create policy orders_delete on public.orders for delete using (organization_id = public.current_user_org_id());

-- quotes: creator-scoped insert
drop policy if exists quotes_all on public.quotes;
create policy quotes_all on public.quotes for all
  using (organization_id = public.current_user_org_id())
  with check (organization_id = public.current_user_org_id() and created_by_id = auth.uid());

-- invitations: admin-only
drop policy if exists invitations_admin on public.invitations;
create policy invitations_admin on public.invitations for all
  using (organization_id = public.current_user_org_id() and public.current_user_role() = 'ADMIN')
  with check (organization_id = public.current_user_org_id() and public.current_user_role() = 'ADMIN');

-- ----------------------------------------------------------------------------
-- 10. LEGACY DATA FIX — force orders.vendeur_id FK to auth.users
-- ----------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='orders' and column_name='vendeur_id') then
    alter table public.orders drop constraint if exists orders_vendeur_id_fkey;
    alter table public.orders add constraint orders_vendeur_id_fkey
      foreign key (vendeur_id) references auth.users (id) on delete restrict;
  end if;
end $$;
