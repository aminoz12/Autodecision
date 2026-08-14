-- ============================================================================
--  sales_returns."createdAt" -> created_at
--
--  The remote table was originally created with a camelCase "createdAt"
--  column, while schema.sql, every other table and the app code all use
--  snake_case created_at. The Retours page fails with
--  « column sales_returns.created_at does not exist » — rename to align.
-- ============================================================================

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sales_returns'
      and column_name = 'createdAt'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sales_returns'
      and column_name = 'created_at'
  ) then
    alter table public.sales_returns rename column "createdAt" to created_at;
  end if;
end $$;

notify pgrst, 'reload schema';
