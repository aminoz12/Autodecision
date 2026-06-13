-- ============================================================================
--  Drop orphaned TypeORM artifacts left by the abandoned apps/api (NestJS).
--
--  Verified against the baseline (20260613012023_remote_schema.sql):
--
--  * public.users      — TypeORM auth table (passwordHash, camelCase). The app
--                        uses auth.users + public.profiles instead. RLS was
--                        deny-all, so it held no accessible data.
--  * public.vehicles   — unused; no incoming FKs.
--  * Duplicate enums canal_vente / statut_livreur / statut_paiement /
--    workflow_status — created by schema.sql but the live `orders` columns
--    actually use the TypeORM `orders_*_enum` types, so these 4 are unreferenced.
--  * users_role_enum   — used only by public.users.
--
--  Two live tables FK'd to public.users (a latent bug — they should reference
--  auth.users). We drop those dead constraints; the columns remain as plain
--  uuids, to be re-pointed at auth.users when the livreur / devis features are
--  built. Idempotent.
-- ============================================================================

-- 1) Remove FK constraints pointing at the dead public.users table
alter table public.delivery_tasks
  drop constraint if exists delivery_tasks_assigned_livreur_id_fkey;

alter table public.quotes
  drop constraint if exists quotes_created_by_id_fkey;

-- 2) Drop the orphaned tables (also removes their RLS policies)
drop table if exists public.users cascade;
drop table if exists public.vehicles cascade;

-- 3) Drop the now-unreferenced enum types
drop type if exists public.users_role_enum;
drop type if exists public.canal_vente;
drop type if exists public.statut_livreur;
drop type if exists public.statut_paiement;
drop type if exists public.workflow_status;
