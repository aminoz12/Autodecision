-- ============================================================================
--  Start new owner organizations on a real 14-day trial.
--
--  Before: handle_new_user inserted owner orgs with the table defaults
--  (subscription_status='active', plan='TRIAL', trial_ends_at=NULL) — so the
--  trial clock never started and billing gating had nothing to act on.
--
--  After: owner signups get subscription_status='trialing' + trial_ends_at =
--  now()+14d. Existing orgs keep subscription_status='active' (grandfathered,
--  never locked). Only the owner-signup INSERT changed; rest is identical.
-- ============================================================================

create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path to 'public'
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

  -- (2) Owner signup — create a brand-new organization on a 14-day trial.
  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
                || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

    insert into public.organizations (name, slug, plan, subscription_status, trial_ends_at)
    values (org_name, new_slug, 'TRIAL', 'trialing', now() + interval '14 days')
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
