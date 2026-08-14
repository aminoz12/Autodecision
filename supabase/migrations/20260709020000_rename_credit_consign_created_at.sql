-- ============================================================================
--  credit_notes."createdAt" / consignment_entries."createdAt" -> created_at
--
--  Same drift as sales_returns (20260709010000): the original remote tables
--  were created with camelCase "createdAt" while schema.sql and the app code
--  use snake_case created_at. The Avoirs page fails with
--  « column credit_notes.created_at does not exist » — rename both to align.
-- ============================================================================

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'credit_notes'
      and column_name = 'createdAt'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'credit_notes'
      and column_name = 'created_at'
  ) then
    alter table public.credit_notes rename column "createdAt" to created_at;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'consignment_entries'
      and column_name = 'createdAt'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'consignment_entries'
      and column_name = 'created_at'
  ) then
    alter table public.consignment_entries rename column "createdAt" to created_at;
  end if;
end $$;

notify pgrst, 'reload schema';
