-- ============================================================================
--  Units handed over to the client (remise)
--
--  A client may take the units available on the shelf today and come back
--  for the rest when the supplier delivers. qte_remise tracks how many units
--  of a line the client has actually taken; remise_at is the last hand-over.
-- ============================================================================

alter table public.order_lines
  add column if not exists qte_remise integer not null default 0,
  add column if not exists remise_at timestamptz;
