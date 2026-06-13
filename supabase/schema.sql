-- Supabase-only: multi-tenant + RLS. Run in SQL Editor (single transaction recommended).

create extension if not exists "pgcrypto";

do $$ begin
  create type public.user_role as enum ('CAISSIER', 'ADMIN', 'LIVREUR');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.canal_vente as enum ('MAGASIN', 'TÉLÉPHONE', 'INTERNET', 'B2B', 'AUTRE');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.statut_paiement as enum ('NON_PAYÉ', 'PARTIEL', 'PAYÉ');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.statut_livreur as enum ('EN_ATTENTE', 'EN_COURS', 'LIVRÉ');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.workflow_status as enum ('PENDING', 'TO_COLLECT', 'IN_TRANSIT', 'DELIVERED');
exception when duplicate_object then null;
end $$;

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

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000000001',
  'Magasin principal',
  'default'
)
on conflict (slug) do nothing;

-- Existing databases: tables created by an older schema have no organization_id.
-- CREATE TABLE IF NOT EXISTS does not add new columns, so functions and RLS would fail.
do $$
declare
  def_org uuid := '00000000-0000-4000-8000-000000000001';
begin
  if exists (select 1 from public.organizations o where o.id = def_org) then
    null;
  else
    select id into def_org from public.organizations order by created_at limit 1;
  end if;

  if def_org is null then
    raise exception 'No organization row; run the organizations insert above first';
  end if;

  -- profiles: restrict on delete (matches create table)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'profiles')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'organization_id') then
    alter table public.profiles add column organization_id uuid;
    update public.profiles set organization_id = def_org where organization_id is null;
    alter table public.profiles alter column organization_id set not null;
    begin
      alter table public.profiles
        add constraint profiles_organization_id_fkey
        foreign key (organization_id) references public.organizations (id) on delete restrict;
    exception when duplicate_object then null;
    end;
  end if;

  -- Tenant tables (cascade on org delete, same as create table)
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'clients')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'clients' and column_name = 'organization_id') then
    alter table public.clients add column organization_id uuid;
    update public.clients set organization_id = def_org where organization_id is null;
    alter table public.clients alter column organization_id set not null;
    begin
      alter table public.clients add constraint clients_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'suppliers')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'suppliers' and column_name = 'organization_id') then
    alter table public.suppliers add column organization_id uuid;
    update public.suppliers set organization_id = def_org where organization_id is null;
    alter table public.suppliers alter column organization_id set not null;
    begin
      alter table public.suppliers add constraint suppliers_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'stock_items')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stock_items' and column_name = 'organization_id') then
    alter table public.stock_items add column organization_id uuid;
    update public.stock_items set organization_id = def_org where organization_id is null;
    alter table public.stock_items alter column organization_id set not null;
    begin
      alter table public.stock_items add constraint stock_items_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'orders')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'organization_id') then
    alter table public.orders add column organization_id uuid;
    update public.orders set organization_id = def_org where organization_id is null;
    alter table public.orders alter column organization_id set not null;
    begin
      alter table public.orders add constraint orders_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'order_lines')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'order_lines' and column_name = 'organization_id') then
    alter table public.order_lines add column organization_id uuid;
    update public.order_lines ol
    set organization_id = o.organization_id
    from public.orders o
    where ol.order_id = o.id;
    update public.order_lines set organization_id = def_org where organization_id is null;
    alter table public.order_lines alter column organization_id set not null;
    begin
      alter table public.order_lines add constraint order_lines_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'delivery_tasks')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'delivery_tasks' and column_name = 'organization_id') then
    alter table public.delivery_tasks add column organization_id uuid;
    update public.delivery_tasks dt
    set organization_id = o.organization_id
    from public.orders o
    where dt.order_id = o.id;
    update public.delivery_tasks set organization_id = def_org where organization_id is null;
    alter table public.delivery_tasks alter column organization_id set not null;
    begin
      alter table public.delivery_tasks add constraint delivery_tasks_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'supplier_receptions')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'supplier_receptions' and column_name = 'organization_id') then
    alter table public.supplier_receptions add column organization_id uuid;
    update public.supplier_receptions set organization_id = def_org where organization_id is null;
    alter table public.supplier_receptions alter column organization_id set not null;
    begin
      alter table public.supplier_receptions add constraint supplier_receptions_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'sales_returns')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sales_returns' and column_name = 'organization_id') then
    alter table public.sales_returns add column organization_id uuid;
    update public.sales_returns set organization_id = def_org where organization_id is null;
    alter table public.sales_returns alter column organization_id set not null;
    begin
      alter table public.sales_returns add constraint sales_returns_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'credit_notes')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'credit_notes' and column_name = 'organization_id') then
    alter table public.credit_notes add column organization_id uuid;
    update public.credit_notes set organization_id = def_org where organization_id is null;
    alter table public.credit_notes alter column organization_id set not null;
    begin
      alter table public.credit_notes add constraint credit_notes_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'consignment_entries')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consignment_entries' and column_name = 'organization_id') then
    alter table public.consignment_entries add column organization_id uuid;
    update public.consignment_entries set organization_id = def_org where organization_id is null;
    alter table public.consignment_entries alter column organization_id set not null;
    begin
      alter table public.consignment_entries add constraint consignment_entries_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;

  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'quotes')
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'organization_id') then
    alter table public.quotes add column organization_id uuid;
    update public.quotes set organization_id = def_org where organization_id is null;
    alter table public.quotes alter column organization_id set not null;
    begin
      alter table public.quotes add constraint quotes_organization_id_fkey foreign key (organization_id) references public.organizations (id) on delete cascade;
    exception when duplicate_object then null;
    end;
  end if;
end $$;

create index if not exists idx_profiles_org on public.profiles (organization_id);
create index if not exists idx_orders_org on public.orders (organization_id);

-- Legacy DB fix: force vendeur_id FK to auth.users (old schemas referenced other users tables).
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'orders'
      and column_name = 'vendeur_id'
  ) then
    alter table public.orders drop constraint if exists orders_vendeur_id_fkey;
    alter table public.orders
      add constraint orders_vendeur_id_fkey
      foreign key (vendeur_id) references auth.users (id) on delete restrict;
  end if;
end $$;

-- Legacy DB fix: ensure order_lines has magasin/retour flags.
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'order_lines'
  ) then
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'order_lines'
        and column_name = 'depuis_magasin'
    ) then
      alter table public.order_lines
        add column depuis_magasin boolean not null default false;
    end if;

    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'order_lines'
        and column_name = 'retour_stock_fait'
    ) then
      alter table public.order_lines
        add column retour_stock_fait boolean not null default false;
    end if;
  end if;
end $$;

create or replace function public.next_ref_demande(p_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  y int := extract(year from current_date);
  prefix constant text := format('REQ-%s-', y);
  next_n int;
begin
  select coalesce(max(right(o.ref_demande, 5)::int), 0) + 1
  into next_n
  from orders o
  where o.organization_id = p_org
    and o.ref_demande like prefix || '%'
    and length(o.ref_demande) >= length(prefix) + 5;

  return prefix || lpad(next_n::text, 5, '0');
end;
$$;

grant execute on function public.next_ref_demande(uuid) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org uuid;
  r public.user_role;
  display text;
  org_name text;
  new_slug text;
begin
  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');

  -- (1) Invited member — an explicit organization_id was passed in metadata.
  begin
    target_org := nullif(new.raw_user_meta_data->>'organization_id', '')::uuid;
  exception when others then
    target_org := null;
  end;

  if target_org is not null then
    begin
      r := coalesce(
        (new.raw_user_meta_data->>'role')::public.user_role,
        'CAISSIER'::public.user_role
      );
    exception when others then
      r := 'CAISSIER'::public.user_role;
    end;

  -- (2) Owner signup — create a brand-new organization, become ADMIN.
  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
                || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

    insert into public.organizations (name, slug)
    values (org_name, new_slug)
    returning id into target_org;

    r := 'ADMIN'::public.user_role;

  -- (3) Fallback — no org info: legacy shared default org as CAISSIER.
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

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
-- PostgreSQL 14+ / Supabase : préférer FUNCTION. Si le SQL Editor refuse la syntaxe, essayez :
-- for each row execute procedure public.handle_new_user();
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Org courante sans sous-requête profiles dans les policies (sinon : récursion RLS infinie sur profiles).
create or replace function public.current_user_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.organization_id
  from public.profiles p
  where p.user_id = auth.uid()
  limit 1;
$$;

grant execute on function public.current_user_org_id() to authenticated;

-- RLS
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.suppliers enable row level security;
alter table public.stock_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_lines enable row level security;
alter table public.delivery_tasks enable row level security;
alter table public.supplier_receptions enable row level security;
alter table public.sales_returns enable row level security;
alter table public.credit_notes enable row level security;
alter table public.consignment_entries enable row level security;
alter table public.quotes enable row level security;

drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations
  for select using (
    id = public.current_user_org_id()
  );

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (
    user_id = auth.uid()
    or organization_id = public.current_user_org_id()
  );

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update using (user_id = auth.uid());

-- Tenant tables
drop policy if exists clients_all on public.clients;
create policy clients_all on public.clients
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists suppliers_all on public.suppliers;
create policy suppliers_all on public.suppliers
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists stock_all on public.stock_items;
create policy stock_all on public.stock_items
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders
  for select using (
    organization_id = public.current_user_org_id()
  );

drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders
  for insert with check (
    organization_id = public.current_user_org_id()
    and vendeur_id = auth.uid()
  );

drop policy if exists orders_update on public.orders;
create policy orders_update on public.orders
  for update using (
    organization_id = public.current_user_org_id()
  );

drop policy if exists orders_delete on public.orders;
create policy orders_delete on public.orders
  for delete using (
    organization_id = public.current_user_org_id()
  );

drop policy if exists order_lines_all on public.order_lines;
create policy order_lines_all on public.order_lines
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists delivery_all on public.delivery_tasks;
create policy delivery_all on public.delivery_tasks
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists receptions_all on public.supplier_receptions;
create policy receptions_all on public.supplier_receptions
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists returns_all on public.sales_returns;
create policy returns_all on public.sales_returns
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists credits_all on public.credit_notes;
create policy credits_all on public.credit_notes
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists consign_all on public.consignment_entries;
create policy consign_all on public.consignment_entries
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
  );

drop policy if exists quotes_all on public.quotes;
create policy quotes_all on public.quotes
  for all using (
    organization_id = public.current_user_org_id()
  )
  with check (
    organization_id = public.current_user_org_id()
    and created_by_id = auth.uid()
  );
