-- ============================================================================
--  Fix account provisioning: recent GoTrue inserts the auth user FIRST and
--  writes user/app metadata in a follow-up UPDATE, so the AFTER INSERT
--  trigger saw empty metadata and raised — every signup / staff / garage
--  account creation failed ("Database error creating new user").
--
--  handle_new_user now:
--    * never raises when metadata is absent (the profile simply isn't
--      created yet — a profile-less session can read nothing under RLS);
--    * also fires on UPDATE of the metadata columns and creates the profile
--      then, but ONLY if the user has no profile yet (a later metadata
--      update must never clobber roles managed from the admin space).
-- ============================================================================

drop table if exists public._trig_debug;

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
  -- Metadata can arrive after the initial insert; never touch an existing
  -- profile (roles are managed from the admin space).
  if exists (select 1 from public.profiles p where p.user_id = new.id) then
    return new;
  end if;

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
      -- Staff member added through the server-only team API (app_metadata is
      -- never writable from the browser).
      assigned_role := staff_role::public.user_role;
      target_client := null;
    elsif target_client is not null and exists (
      select 1
      from public.clients c
      where c.id = target_client
        and c.organization_id = target_org
        and c.is_garage = true
    ) then
      assigned_role := 'CAISSIER'::public.user_role;
    else
      -- Unusable provisioning metadata: leave the account profile-less
      -- (it cannot read anything) rather than breaking the auth flow.
      return new;
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
    -- No metadata (yet): the UPDATE that follows will bring it.
    return new;
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Utilisateur'
  );

  insert into public.profiles (user_id, organization_id, display_name, role, client_id)
  values (new.id, target_org, display, assigned_role, target_client)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of raw_app_meta_data, raw_user_meta_data on auth.users
  for each row execute function public.handle_new_user();

grant execute on function public.handle_new_user() to supabase_auth_admin;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

notify pgrst, 'reload schema';
