-- Réparation (2026-10-01) : sales_returns.quantity manquait en base.
--
-- La migration 20260930020000 est enregistrée comme appliquée, mais sa colonne
-- n'existe pas : toutes les fonctions qui lisent r.quantity échouaient
-- (« column r.quantity does not exist ») — tableau des tournées, demande de
-- retour du garage, réception, retour comptoir, pièce offerte.
-- Ces instructions reprennent le début de 20260930020000 ; elles sont sans
-- effet sur une base où la colonne existe déjà.

alter table public.sales_returns add column if not exists quantity integer not null default 1;
alter table public.sales_returns drop constraint if exists sales_returns_quantity_check;
alter table public.sales_returns add constraint sales_returns_quantity_check check (quantity > 0);

-- L'ancienne signature (sans frais) ne doit plus exister à côté de la nouvelle.
drop function if exists public.create_walk_in_return(uuid, uuid[], text, text, uuid);

notify pgrst, 'reload schema';
