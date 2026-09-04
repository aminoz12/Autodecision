-- ============================================================================
--  Admin space for the magasin.
--
--  * Suppliers and livreurs become ADMIN-managed: every staff member can
--    still READ them (order form, dispatch), but insert/update/delete now
--    require the ADMIN role. Garagistes keep no access at all.
--  * handle_new_user learns a STAFF branch: the server-side team API creates
--    auth users with app_metadata { organization_id, staff_role } and the
--    trigger writes the profile with that role (CAISSIER or ADMIN) — until
--    now only garage accounts (client_id) could join an existing org.
--  Groundwork for the upcoming super-admin (SaaS owner) console.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Suppliers: staff read, admin write
-- ---------------------------------------------------------------------------

drop policy if exists suppliers_staff on public.suppliers;
drop policy if exists suppliers_select on public.suppliers;
drop policy if exists suppliers_admin_insert on public.suppliers;
drop policy if exists suppliers_admin_update on public.suppliers;
drop policy if exists suppliers_admin_delete on public.suppliers;

create policy suppliers_select on public.suppliers for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
  );
create policy suppliers_admin_insert on public.suppliers for insert
  with check (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
    and public.current_user_role() = 'ADMIN'::public.user_role
  );
create policy suppliers_admin_update on public.suppliers for update
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
    and public.current_user_role() = 'ADMIN'::public.user_role
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_role() = 'ADMIN'::public.user_role
  );
create policy suppliers_admin_delete on public.suppliers for delete
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
    and public.current_user_role() = 'ADMIN'::public.user_role
  );

-- ---------------------------------------------------------------------------
-- Livreurs: staff read, admin write (dispatch stays via SECURITY DEFINER RPC)
-- ---------------------------------------------------------------------------

drop policy if exists livreurs_staff on public.livreurs;
drop policy if exists livreurs_select on public.livreurs;
drop policy if exists livreurs_admin_insert on public.livreurs;
drop policy if exists livreurs_admin_update on public.livreurs;
drop policy if exists livreurs_admin_delete on public.livreurs;

create policy livreurs_select on public.livreurs for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
  );
create policy livreurs_admin_insert on public.livreurs for insert
  with check (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
    and public.current_user_role() = 'ADMIN'::public.user_role
  );
create policy livreurs_admin_update on public.livreurs for update
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
    and public.current_user_role() = 'ADMIN'::public.user_role
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_role() = 'ADMIN'::public.user_role
  );
create policy livreurs_admin_delete on public.livreurs for delete
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
    and public.current_user_role() = 'ADMIN'::public.user_role
  );

-- ---------------------------------------------------------------------------
-- handle_new_user: + staff provisioning via app_metadata.staff_role
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org uuid;
  target_client uuid;
  assigned_role public.user_role;
  display text;
  org_name text;
  new_slug text;
  staff_role text;
begin
  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');
  staff_role := nullif(trim(new.raw_app_meta_data->>'staff_role'), '');

  begin
    target_org := nullif(new.raw_app_meta_data->>'organization_id', '')::uuid;
  exception when others then
    target_org := null;
  end;

  begin
    target_client := nullif(new.raw_app_meta_data->>'client_id', '')::uuid;
  exception when others then
    target_client := null;
  end;

  if target_org is not null then
    if staff_role in ('CAISSIER', 'ADMIN') then
      -- Staff member added by the org admin through the server-only team API.
      -- app_metadata cannot be set from the browser, so this path is trusted.
      assigned_role := staff_role::public.user_role;
      target_client := null;
    elsif target_client is not null and exists (
      select 1
      from public.clients c
      where c.id = target_client
        and c.organization_id = target_org
        and c.is_garage = true
    ) then
      -- Garagiste accounts are always external cashiers.
      assigned_role := 'CAISSIER'::public.user_role;
    else
      raise exception 'Invalid provisioning metadata.';
    end if;
  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
      || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

    insert into public.organizations (name, slug, plan, subscription_status, trial_ends_at)
    values (org_name, new_slug, 'TRIAL', 'trialing', now() + interval '14 days')
    returning id into target_org;
    assigned_role := 'ADMIN'::public.user_role;
  else
    -- There is no safe shared/default organization. A normal sign-up must
    -- create its own organization; staff and garage accounts are provisioned
    -- via app_metadata by server-only routes.
    raise exception 'Organization name is required for sign-up.';
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Utilisateur'
  );

  insert into public.profiles (user_id, organization_id, display_name, role, client_id)
  values (new.id, target_org, display, assigned_role, target_client)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    display_name = excluded.display_name,
    role = excluded.role,
    client_id = excluded.client_id,
    updated_at = now();

  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

notify pgrst, 'reload schema';
