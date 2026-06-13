-- ============================================================================
--  FIX: missing `updated_at` columns vs the set_updated_at() trigger.
--
--  Your live DB has a BEFORE UPDATE trigger that runs `new.updated_at = now()`,
--  but some tables (built via the Supabase dashboard) never got the column.
--  Result: EVERY update to those tables fails with
--      ERROR: record "new" has no field "updated_at"
--  i.e. in the app: "Marquer DELIVERED", change workflow, "Enregistrer
--  modifications", edit line modes, etc. all break.
--
--  This finds every table whose update-trigger calls set_updated_at() and adds
--  the column where it's missing. Idempotent — safe to run multiple times.
--  Run in the Supabase SQL Editor.
-- ============================================================================
do $$
declare
  r record;
  fixed int := 0;
begin
  for r in
    select distinct c.relname as tbl
    from pg_trigger  t
    join pg_class    c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc     p on p.oid = t.tgfoid
    where p.proname = 'set_updated_at'
      and n.nspname = 'public'
      and not t.tgisinternal
    order by c.relname
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = r.tbl
        and column_name = 'updated_at'
    ) then
      execute format(
        'alter table public.%I add column updated_at timestamptz not null default now()',
        r.tbl);
      raise notice 'added updated_at -> public.%', r.tbl;
      fixed := fixed + 1;
    else
      raise notice 'ok (already present) -> public.%', r.tbl;
    end if;
  end loop;

  if fixed = 0 then
    raise notice 'Nothing to add: all trigger-managed tables already have updated_at.';
  else
    raise notice 'Done: added updated_at to % table(s).', fixed;
  end if;
end $$;
