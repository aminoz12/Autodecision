-- ============================================================================
--  Devis (quote-request) workflow for garagiste orders.
--
--  A garagiste "order" starts as a DEVIS (orders.devis = true): a request the
--  magasin must answer. Lifecycle via orders.devis_status:
--    REQUESTED → garagiste sent it (magasin hasn't answered)
--    QUOTED    → magasin set prices + per-line availability (awaiting garagiste)
--    ACCEPTED  → garagiste accepted → becomes a real order (devis=false)
--    REFUSED   → declined (kept for history, stays devis=true → out of pipeline)
--
--  Per-line answer: order_lines.disponible (null = not answered, true/false).
--  Operational views filter on devis=false, so REQUESTED/QUOTED/REFUSED never
--  enter réception / tournées / stock / reports until accepted.
-- ============================================================================

alter table public.orders
  add column if not exists devis_status text;

alter table public.order_lines
  add column if not exists disponible boolean;

create index if not exists idx_orders_devis
  on public.orders (organization_id, devis, devis_status);

notify pgrst, 'reload schema';
