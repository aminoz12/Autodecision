-- ============================================================================
--  Garagiste portal foundation.
--
--  A "garagiste" is an external customer of a magasin who logs in to order /
--  request returns. Model: a profiles row whose client_id points at their
--  garage (a clients row with is_garage=true). profiles.client_id IS NULL for
--  staff (admins/cashiers). RLS then restricts a garagiste to their own data.
-- ============================================================================

-- 1) Link a profile to its garage
alter table public.profiles
  add column if not exists client_id uuid references public.clients (id) on delete cascade;

-- 2) Helper: the garage (client) of the current user, NULL for staff
create or replace function public.current_user_client_id()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public
as $$
  select client_id from public.profiles where user_id = auth.uid() limit 1;
$$;

-- 3) Signup trigger also stores client_id (passed in metadata for garagistes)
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
as $$
declare
  target_org uuid;
  target_client uuid;
  r public.user_role;
  display text;
  org_name text;
  new_slug text;
begin
  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');

  begin
    target_org := nullif(new.raw_user_meta_data->>'organization_id', '')::uuid;
  exception when others then target_org := null; end;

  begin
    target_client := nullif(new.raw_user_meta_data->>'client_id', '')::uuid;
  exception when others then target_client := null; end;

  if target_org is not null then
    begin
      r := coalesce(
        (new.raw_user_meta_data->>'role')::public.user_role,
        'CAISSIER'::public.user_role
      );
    exception when others then r := 'CAISSIER'::public.user_role; end;

  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
                || '-' || substr(replace(new.id::text, '-', ''), 1, 8);
    insert into public.organizations (name, slug, plan, subscription_status, trial_ends_at)
    values (org_name, new_slug, 'TRIAL', 'trialing', now() + interval '14 days')
    returning id into target_org;
    r := 'ADMIN'::public.user_role;

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

  insert into public.profiles (user_id, organization_id, display_name, role, client_id)
  values (new.id, target_org, display, r, target_client)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    display_name = excluded.display_name,
    role = excluded.role,
    client_id = excluded.client_id,
    updated_at = now();

  return new;
end;
$$;

-- 4) RLS — staff (client_id NULL) keep full org access; garagistes are scoped
--    to their own garage's rows.

-- clients: a garagiste only sees/touches their own garage record
drop policy if exists clients_all on public.clients;
create policy clients_all on public.clients
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or id = public.current_user_client_id())
  )
  with check (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or id = public.current_user_client_id())
  );

-- orders
drop policy if exists orders_select on public.orders;
create policy orders_select on public.orders for select
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
  );

drop policy if exists orders_insert on public.orders;
create policy orders_insert on public.orders for insert
  with check (
    organization_id = public.current_user_org_id()
    and vendeur_id = auth.uid()
    and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
  );

drop policy if exists orders_update on public.orders;
create policy orders_update on public.orders for update
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
  );

drop policy if exists orders_delete on public.orders;
create policy orders_delete on public.orders for delete
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
  );

-- order_lines: scope via the parent order's client_id
drop policy if exists order_lines_all on public.order_lines;
create policy order_lines_all on public.order_lines
  using (
    organization_id = public.current_user_org_id()
    and (
      public.current_user_client_id() is null
      or order_id in (
        select o.id from public.orders o
        where o.organization_id = public.current_user_org_id()
          and o.client_id = public.current_user_client_id()
      )
    )
  )
  with check (
    organization_id = public.current_user_org_id()
    and (
      public.current_user_client_id() is null
      or order_id in (
        select o.id from public.orders o
        where o.organization_id = public.current_user_org_id()
          and o.client_id = public.current_user_client_id()
      )
    )
  );

-- sales_returns
drop policy if exists sales_returns_all on public.sales_returns;
create policy sales_returns_all on public.sales_returns
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
  )
  with check (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
  );

notify pgrst, 'reload schema';
