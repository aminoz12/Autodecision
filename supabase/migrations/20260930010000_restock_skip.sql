-- Stock (2026-09-30) : « Déjà en stock » sur les pièces à recommander.
--
-- Une ligne vendue depuis le rayon reste dans « Pièces à recommander » tant
-- qu'aucune commande de réapprovisionnement ne lui est liée (restock_line_id).
-- Quand la pièce est en fait déjà en rayon, le comptoir écarte l'alerte : la
-- ligne garde tout son historique, elle sort simplement de la liste.
-- Écriture directe depuis le comptoir : la politique order_lines_write_staff
-- (20260828010000) couvre déjà la mise à jour.

alter table public.order_lines
  add column if not exists restock_skipped_at timestamptz;

comment on column public.order_lines.restock_skipped_at is
  'Alerte de réapprovisionnement écartée au comptoir (« Déjà en stock »).';

create index if not exists order_lines_restock_pending_idx
  on public.order_lines (organization_id)
  where depuis_magasin
    and supplier_id is null
    and restock_line_id is null
    and restock_skipped_at is null;
