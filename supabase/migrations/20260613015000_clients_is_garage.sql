-- ============================================================================
--  Distinguish garages from regular clients.
--
--  The clients table holds everyone (walk-in clients created at order time AND
--  garages). is_professional defaults to true for all, so it can't separate
--  them. Add an explicit is_garage flag (default false) so the Garages page
--  can show only garages, and ordinary clients stay out of it.
-- ============================================================================

alter table public.clients
  add column if not exists is_garage boolean not null default false;

create index if not exists idx_clients_garage
  on public.clients (organization_id, is_garage);
