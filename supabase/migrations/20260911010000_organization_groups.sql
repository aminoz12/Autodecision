-- Groupes de magasins : un propriétaire crée d'autres magasins depuis /admin.
--
--  * organizations.parent_organization_id : le magasin « racine » du groupe
--    (null pour un magasin isolé ou la racine elle-même). Un magasin créé
--    depuis /admin pointe vers la racine du groupe de son créateur, si bien
--    que tous les magasins d'un groupe partagent la même racine.
--  * Chaque magasin garde son propre abonnement, ses équipes et ses données ;
--    la liaison sert à lister « Mes magasins » et à copier les réglages.

alter table public.organizations
  add column if not exists parent_organization_id uuid references public.organizations (id) on delete set null;
create index if not exists organizations_parent_idx on public.organizations (parent_organization_id);

notify pgrst, 'reload schema';
