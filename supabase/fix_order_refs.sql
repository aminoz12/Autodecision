-- ============================================================================
--  Fix 409 Conflict on order creation (duplicate ref_demande)
--
--  Root cause: the live DB can hold a GLOBAL unique constraint/index on
--  orders.ref_demande (seed_orders.sql assumed site-wide uniqueness), while
--  next_ref_demande() numbers orders PER ORGANIZATION. A new magasin's first
--  order gets REQ-YYYY-00001, which another org already owns -> 409.
--
--  This script makes the DB match the intended multi-tenant design:
--    1. drop any unique constraint/index on ref_demande ALONE
--    2. ensure the per-org unique (organization_id, ref_demande) exists
--    3. harden next_ref_demande (tolerates any digit-suffix length)
--    4. bonus: add the suppliers timestamps the app expects (schema drift)
--
--  Run in the Supabase SQL Editor. Idempotent.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Drop any GLOBAL unique on orders(ref_demande) alone
-- ----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select i.indexname,
           con.conname
    from pg_indexes i
    left join pg_constraint con
      on con.conrelid = 'public.orders'::regclass
     and con.conindid = (quote_ident(i.schemaname) || '.' || quote_ident(i.indexname))::regclass
    where i.schemaname = 'public'
      and i.tablename  = 'orders'
      and i.indexdef ilike 'create unique index%'
      and i.indexdef like '%(ref_demande)'
  loop
    if r.conname is not null then
      execute format('alter table public.orders drop constraint %I', r.conname);
      raise notice 'Dropped global unique constraint % on orders(ref_demande)', r.conname;
    else
      execute format('drop index public.%I', r.indexname);
      raise notice 'Dropped global unique index % on orders(ref_demande)', r.indexname;
    end if;
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- 2) Ensure the per-organization unique exists
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename  = 'orders'
      and indexdef ilike 'create unique index%'
      and indexdef like '%(organization_id, ref_demande)'
  ) then
    alter table public.orders
      add constraint orders_org_ref_demande_key unique (organization_id, ref_demande);
    raise notice 'Added unique (organization_id, ref_demande)';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 3) Hardened per-org ref generator
--    - regex extracts the WHOLE trailing number (old version read exactly the
--      last 5 chars and silently mis-parsed longer/shorter suffixes)
--    - refs without a trailing number are ignored instead of erroring
-- ----------------------------------------------------------------------------
create or replace function public.next_ref_demande(p_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  y int := extract(year from current_date);
  prefix constant text := format('REQ-%s-', y);
  next_n int;
begin
  select coalesce(max((regexp_match(o.ref_demande, '(\d+)$'))[1]::int), 0) + 1
  into next_n
  from orders o
  where o.organization_id = p_org
    and o.ref_demande like prefix || '%';

  return prefix || lpad(next_n::text, 5, '0');
end;
$$;

grant execute on function public.next_ref_demande(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 4) Bonus: schema drift seen earlier — suppliers timestamps used by the app
-- ----------------------------------------------------------------------------
alter table public.suppliers add column if not exists created_at timestamptz not null default now();
alter table public.suppliers add column if not exists updated_at timestamptz not null default now();

-- ----------------------------------------------------------------------------
-- Verify
-- ----------------------------------------------------------------------------
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'orders' and indexdef ilike '%unique%';
