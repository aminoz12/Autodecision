-- ============================================================================
--  auth.users → handle_new_user trigger
--
--  The baseline (20260613012023_remote_schema.sql) was produced by
--  `pg_dump --schema=public`, which captures the handle_new_user() FUNCTION
--  but not this TRIGGER, because it lives on auth.users (the `auth` schema).
--
--  This migration recreates it so a fresh rebuild from migrations alone wires
--  signup → organization + ADMIN profile correctly. Idempotent: it already
--  exists on the live DB, so re-applying is a harmless drop + create.
-- ============================================================================

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
