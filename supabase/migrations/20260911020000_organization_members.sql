-- Un propriétaire (ADMIN) possède plusieurs magasins avec un seul compte.
--
--  * organization_members : les magasins qu'un administrateur peut ouvrir.
--    profiles.organization_id reste « le magasin en cours » de la session ;
--    toutes les règles RLS continuent de lire current_user_org_id(), donc
--    changer de magasin = mettre à jour profiles.organization_id vers un
--    magasin où l'on est membre (fait par /api/organizations, service role).
--  * Reprise de l'existant : chaque ADMIN de magasin devient membre de son
--    magasin ; les magasins déjà rattachés par parent_organization_id sont
--    ouverts aux membres de leur racine.
--  * Un nouvel ADMIN ajouté depuis /admin devient membre de son magasin
--    (trigger), rien ne change pour caissiers, livreurs et garagistes.

create table if not exists public.organization_members (
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  role text not null default 'ADMIN' check (role in ('ADMIN')),
  created_at timestamptz not null default now(),
  primary key (user_id, organization_id)
);
create index if not exists organization_members_org_idx on public.organization_members (organization_id);
alter table public.organization_members enable row level security;
drop policy if exists organization_members_self on public.organization_members;
create policy organization_members_self on public.organization_members
  for select using (user_id = auth.uid());
revoke all on public.organization_members from anon;
grant select on public.organization_members to authenticated;

-- Existing magasin administrators own their magasin.
insert into public.organization_members (user_id, organization_id)
select p.user_id, p.organization_id
from public.profiles p
where p.role = 'ADMIN' and p.client_id is null and p.livreur_id is null and p.organization_id is not null
on conflict do nothing;

-- Magasins created with the previous « one admin per magasin » model: the
-- members of the root magasin get the child magasins too.
insert into public.organization_members (user_id, organization_id)
select m.user_id, o.id
from public.organization_members m
join public.organizations o on o.parent_organization_id = m.organization_id
on conflict do nothing;

-- A staff ADMIN (created from /admin or the signup) is a member of his magasin.
create or replace function public.ensure_admin_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'ADMIN' and new.client_id is null and new.livreur_id is null and new.organization_id is not null then
    insert into public.organization_members (user_id, organization_id)
    values (new.user_id, new.organization_id)
    on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_admin_membership on public.profiles;
create trigger profiles_admin_membership
  after insert or update of role, organization_id on public.profiles
  for each row execute function public.ensure_admin_membership();

notify pgrst, 'reload schema';
