-- ============================================================================
--  Stock re-orders: supplier reference
--
--  When a part served from the magasin stock is re-ordered from a supplier,
--  the supplier's own reference ("Référence commandée") is kept NEXT TO the
--  original reference, never in its place, so both can be searched.
-- ============================================================================

alter table public.order_lines
  add column if not exists reference_commande text;

create index if not exists idx_order_lines_org_reference_commande
  on public.order_lines (organization_id, reference_commande);
