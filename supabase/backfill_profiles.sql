-- Utilisateurs Auth sans ligne dans public.profiles (compte créé avant le trigger,
-- trigger en erreur, ou import utilisateurs). À exécuter dans le SQL Editor après schema.sql.

insert into public.organizations (id, name, slug)
values (
  '00000000-0000-4000-8000-000000000001',
  'Magasin principal',
  'default'
)
on conflict (slug) do nothing;

insert into public.profiles (user_id, organization_id, display_name, role)
select
  u.id,
  coalesce(
    (select id from public.organizations where slug = 'default' limit 1),
    (select id from public.organizations order by created_at limit 1)
  ),
  coalesce(
    nullif(trim(u.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
    'Utilisateur'
  ),
  'CAISSIER'::public.user_role
from auth.users u
where not exists (select 1 from public.profiles p where p.user_id = u.id)
on conflict (user_id) do nothing;
