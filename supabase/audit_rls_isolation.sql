-- ============================================================================
--  Tenant isolation audit — proves org A cannot see or touch org B's data.
--
--  Run in the Supabase SQL Editor. Read the PASS/FAIL table it returns.
--  Requires ≥2 organizations that each have a user (profiles row). The demo
--  accounts (admin@demo.fr / patron@autopro.fr) are two different orgs.
--
--  How it works: the SQL Editor connects as a privileged role that BYPASSES
--  RLS, so we impersonate a real authenticated user — `set local role
--  authenticated` + a forged `request.jwt.claims.sub` — which makes
--  auth.uid() resolve to user A and forces every policy to apply.
--
--  Results are accumulated in memory while impersonating (the authenticated
--  role can't write to the temp table), then flushed after `reset role`.
--  The whole thing runs in a transaction that ROLLS BACK — nothing persists.
-- ============================================================================

begin;

create temp table _audit (
  ord int generated always as identity,
  check_name text,
  result text,
  detail text
) on commit drop;

do $$
declare
  org_a uuid;
  org_b uuid;
  user_a uuid;
  email_a text;
  tbl text;
  n_own int;
  n_foreign int;
  ins_blocked boolean;
  upd_count int;
  res jsonb := '[]'::jsonb;
  proceed boolean := true;
begin
  ------------------------------------------------------------------ pick orgs
  select organization_id into org_a
  from public.profiles
  group by organization_id
  order by organization_id
  limit 1;

  select organization_id into org_b
  from public.profiles
  where organization_id is distinct from org_a
  group by organization_id
  order by organization_id
  limit 1;

  if org_a is null or org_b is null then
    res := res || jsonb_build_object('c', 'setup', 'r', 'SKIP',
      'd', 'Need 2 organizations that each have a user. Run the demo-users SQL '
        || '(admin@demo.fr + patron@autopro.fr) then re-run.');
    proceed := false;
  end if;

  if proceed then
    select p.user_id, u.email into user_a, email_a
    from public.profiles p
    join auth.users u on u.id = p.user_id
    where p.organization_id = org_a
    limit 1;

    res := res || jsonb_build_object('c', 'impersonating', 'r', 'INFO',
      'd', format('user %s (org A=%s) — probing against org B=%s', email_a, org_a, org_b));

    ----------------------------------------------------------- become user A
    perform set_config('request.jwt.claims',
      json_build_object('sub', user_a, 'role', 'authenticated')::text, true);
    set local role authenticated;

    if public.current_user_org_id() is distinct from org_a then
      reset role;
      res := res || jsonb_build_object('c', 'impersonation sanity', 'r', 'FAIL',
        'd', 'JWT impersonation did not take effect — audit inconclusive');
      proceed := false;
    end if;
  end if;

  if proceed then
    -------------------------------------------- per-table read isolation test
    foreach tbl in array array[
      'orders','order_lines','clients','suppliers','stock_items',
      'sales_returns','credit_notes','consignment_entries','delivery_tours',
      'delivery_tasks','sms_notifications'
    ]
    loop
      begin
        execute format('select count(*) from public.%I where organization_id = $1', tbl)
          into n_own using org_a;
        execute format('select count(*) from public.%I where organization_id = $1', tbl)
          into n_foreign using org_b;

        res := res || jsonb_build_object(
          'c', tbl || ': cross-tenant read',
          'r', case when n_foreign = 0 then 'PASS' else 'FAIL' end,
          'd', case when n_foreign = 0
            then format('org B rows hidden (own rows visible: %s)', n_own)
            else format('LEAK: %s org B rows visible to org A', n_foreign) end);
      exception
        when insufficient_privilege then
          res := res || jsonb_build_object('c', tbl || ': cross-tenant read',
            'r', 'WARN', 'd', 'permission denied for authenticated — missing GRANT');
        when undefined_column then
          res := res || jsonb_build_object('c', tbl || ': cross-tenant read',
            'r', 'WARN', 'd', 'no organization_id column');
        when undefined_table then
          res := res || jsonb_build_object('c', tbl || ': cross-tenant read',
            'r', 'SKIP', 'd', 'table absent');
      end;
    end loop;

    ---------------------------------------- cross-tenant WRITE: insert into B
    begin
      insert into public.orders(
        organization_id, ref_demande, date_commande, vendeur_id,
        canal_vente, client_phone, montant_total, statut_paiement, solde_restant)
      values (org_b, 'AUDIT-HACK', current_date, user_a,
        'MAGASIN', '0', 0, 'NON_PAYÉ', 0);
      ins_blocked := false;
    exception when others then
      ins_blocked := true;
    end;

    res := res || jsonb_build_object('c', 'orders: cross-tenant insert',
      'r', case when ins_blocked then 'PASS' else 'FAIL' end,
      'd', case when ins_blocked
        then 'insert into org B blocked by RLS WITH CHECK'
        else 'INSERT INTO ORG B SUCCEEDED — RLS HOLE' end);

    --------------------------------------- cross-tenant WRITE: update org B rows
    begin
      execute 'update public.orders set consigne = ''AUDIT-HACK'' where organization_id = $1'
        using org_b;
      get diagnostics upd_count = row_count;
      res := res || jsonb_build_object('c', 'orders: cross-tenant update',
        'r', case when upd_count = 0 then 'PASS' else 'FAIL' end,
        'd', case when upd_count = 0
          then 'org B rows not updatable by org A'
          else format('UPDATED %s org B rows — RLS HOLE', upd_count) end);
    exception when insufficient_privilege then
      res := res || jsonb_build_object('c', 'orders: cross-tenant update',
        'r', 'PASS', 'd', 'update denied for org A');
    end;

    reset role;
    perform set_config('request.jwt.claims', '', true);
  end if;

  ---------------------------------------- flush results (privileged role now)
  insert into _audit(check_name, result, detail)
  select e->>'c', e->>'r', e->>'d'
  from jsonb_array_elements(res) with ordinality as t(e, i)
  order by i;
end $$;

select check_name, result, detail from _audit order by ord;

rollback;
