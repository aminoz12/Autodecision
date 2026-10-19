-- Annuler un règlement (2026-10-19, user : « dans commandes à régler, pouvoir
-- annuler un paiement »).
--
--  1. payments.cancelled_at / cancelled_by / cancel_reason : un règlement saisi
--     par erreur est annulé, jamais effacé (il reste dans l'historique, barré).
--  2. cancel_payment(p_payment_id, p_reason) : comptoir uniquement ; refusé pour
--     un remboursement, un règlement déjà annulé, ou un règlement en espèces
--     d'une caisse déjà clôturée (le comptage est fait : passer par un
--     remboursement). Chaque commande réglée redevient due du montant alloué
--     (montant_paye / solde_restant / statut_paiement recalculés).
--  3. close_cash_session et report_overview (encaissements par mode) ignorent
--     les règlements annulés — corps repris des migrations 20260908020000 et
--     20260908080000, seule la clause « cancelled_at is null » est ajoutée —
--     et la colonne sales_returns."createdAt" (inexistante : c'est created_at),
--     qui faisait échouer report_overview en production, est corrigée.

alter table public.payments
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users (id) on delete set null,
  add column if not exists cancel_reason text;
create index if not exists payments_org_active_idx on public.payments (organization_id, received_at desc) where cancelled_at is null;

create or replace function public.cancel_payment(p_payment_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_p public.payments;
  v_a record;
  v_order public.orders;
  v_new_paye numeric;
  v_new_solde numeric;
  v_reversed jsonb := '[]'::jsonb;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);

  select * into v_p from public.payments where id = p_payment_id and organization_id = v_org for update;
  if not found then
    raise exception 'Règlement introuvable.';
  end if;
  if v_p.cancelled_at is not null then
    raise exception 'Ce règlement est déjà annulé.';
  end if;
  if v_p.kind = 'REMBOURSEMENT' then
    raise exception 'Un remboursement ne s''annule pas : enregistrez un nouvel encaissement.';
  end if;
  if v_p.mode = 'ESPECES' and v_p.session_id is not null
     and exists (select 1 from public.cash_sessions s where s.id = v_p.session_id and s.closed_at is not null) then
    raise exception 'La caisse de ce règlement en espèces est déjà clôturée : passez par un remboursement.';
  end if;

  for v_a in
    select pa.order_id, pa.amount from public.payment_allocations pa where pa.payment_id = v_p.id
    union all
    select v_p.order_id, v_p.amount
    where v_p.order_id is not null
      and not exists (select 1 from public.payment_allocations pa where pa.payment_id = v_p.id)
  loop
    select * into v_order from public.orders where id = v_a.order_id and organization_id = v_org for update;
    if found then
      v_new_paye := greatest(0, round(v_order.montant_paye - v_a.amount, 2));
      v_new_solde := round(v_order.solde_restant + v_a.amount, 2);
      update public.orders
      set montant_paye = v_new_paye,
          solde_restant = v_new_solde,
          statut_paiement = case
            when v_new_solde <= 0 then 'PAYÉ'::public.orders_statut_paiement_enum
            when v_new_paye + avance_payee > 0 then 'PARTIEL'::public.orders_statut_paiement_enum
            else 'NON_PAYÉ'::public.orders_statut_paiement_enum end,
          updated_at = now()
      where id = v_order.id;
      v_reversed := v_reversed || jsonb_build_object('order_id', v_order.id, 'ref', v_order.ref_demande, 'amount', v_a.amount);
    end if;
  end loop;

  update public.payments
  set cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancel_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = v_p.id;

  return jsonb_build_object('payment_id', v_p.id, 'amount', v_p.amount, 'reversed', v_reversed);
end;
$$;
revoke execute on function public.cancel_payment(uuid, text) from public, anon;
grant execute on function public.cancel_payment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- close_cash_session : espèces attendues hors règlements annulés
-- ---------------------------------------------------------------------
create or replace function public.close_cash_session(p_counted_cash numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_session public.cash_sessions;
  v_in numeric := 0;
  v_out numeric := 0;
  v_expected numeric;
  v_counted numeric := round(coalesce(p_counted_cash, 0), 2);
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  select * into v_session
  from public.cash_sessions
  where organization_id = v_org and closed_at is null
  for update;
  if not found then
    raise exception 'No open cash session.';
  end if;

  select coalesce(sum(case when kind <> 'REMBOURSEMENT' then amount else 0 end), 0),
         coalesce(sum(case when kind = 'REMBOURSEMENT' then amount else 0 end), 0)
  into v_in, v_out
  from public.payments
  where session_id = v_session.id and mode = 'ESPECES' and cancelled_at is null;

  v_expected := round(v_session.opening_float + v_in - v_out, 2);
  update public.cash_sessions
  set closed_at = now(),
      closed_by = auth.uid(),
      expected_cash = v_expected,
      counted_cash = v_counted,
      difference = round(v_counted - v_expected, 2),
      note = nullif(trim(coalesce(p_note, '')), '')
  where id = v_session.id;

  return jsonb_build_object(
    'id', v_session.id, 'opening_float', v_session.opening_float,
    'cash_in', v_in, 'cash_out', v_out, 'expected', v_expected,
    'counted', v_counted, 'difference', round(v_counted - v_expected, 2)
  );
end;
$$;
revoke execute on function public.close_cash_session(numeric, text) from public, anon;
grant execute on function public.close_cash_session(numeric, text) to authenticated;

-- ---------------------------------------------------------------------
-- report_overview : encaissements par mode hors règlements annulés
-- ---------------------------------------------------------------------
create or replace function public.report_overview(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_from date := coalesce(p_from, date '1900-01-01');
  v_to date := coalesce(p_to, date '2999-12-31');
  v_totals jsonb;
  v_months jsonb;
  v_clients jsonb;
  v_suppliers jsonb;
  v_returns jsonb;
  v_credits jsonb;
  v_modes jsonb;
begin
  perform public.assert_counter_staff();
  if v_org is null then
    raise exception 'Authenticated organization access is required.';
  end if;

  select jsonb_build_object(
    'orders', count(*),
    'ca', coalesce(sum(o.montant_total), 0),
    'encaisse', coalesce(sum(o.montant_paye + o.avance_payee), 0),
    'solde', coalesce(sum(greatest(o.solde_restant, 0)), 0),
    'remises', coalesce(sum(o.remise_montant), 0),
    'panier_moyen', case when count(*) > 0 then round(coalesce(sum(o.montant_total), 0) / count(*), 2) else 0 end,
    'marge', coalesce((
      select sum(l.quantity * (l.prix_vente_unitaire - l.prix_achat_unitaire))
      from public.order_lines l
      join public.orders o2 on o2.id = l.order_id
      where l.organization_id = v_org and o2.organization_id = v_org
        and o2.devis = false and o2.is_restock = false and o2.cancelled_at is null
        and o2.date_commande between v_from and v_to
        and l.prix_achat_unitaire > 0 and l.prix_vente_unitaire > 0
    ), 0)
  ) into v_totals
  from public.orders o
  where o.organization_id = v_org
    and o.devis = false and o.is_restock = false and o.cancelled_at is null
    and o.date_commande between v_from and v_to;

  select coalesce(jsonb_agg(jsonb_build_object('key', m.key, 'ca', m.ca, 'orders', m.orders) order by m.key), '[]'::jsonb)
  into v_months
  from (
    select to_char(o.date_commande, 'YYYY-MM') as key,
           coalesce(sum(o.montant_total), 0) as ca,
           count(*) as orders
    from public.orders o
    where o.organization_id = v_org
      and o.devis = false and o.is_restock = false and o.cancelled_at is null
      and o.date_commande between v_from and v_to
    group by 1
  ) m;

  select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'is_garage', c.is_garage, 'amount', c.amount, 'count', c.count) order by c.amount desc), '[]'::jsonb)
  into v_clients
  from (
    select coalesce(cl.name, 'Client comptoir') as name,
           coalesce(cl.is_garage, false) as is_garage,
           sum(o.montant_total) as amount,
           count(*) as count
    from public.orders o
    left join public.clients cl on cl.id = o.client_id
    where o.organization_id = v_org
      and o.devis = false and o.is_restock = false and o.cancelled_at is null
      and o.date_commande between v_from and v_to
    group by 1, 2
    order by 3 desc
    limit 8
  ) c;

  select coalesce(jsonb_agg(jsonb_build_object('name', s.name, 'amount', s.amount, 'count', s.count) order by s.count desc), '[]'::jsonb)
  into v_suppliers
  from (
    select sp.name,
           sum(l.quantity * l.prix_vente_unitaire) as amount,
           sum(l.quantity) as count
    from public.order_lines l
    join public.orders o on o.id = l.order_id
    join public.suppliers sp on sp.id = l.supplier_id
    where l.organization_id = v_org and o.organization_id = v_org
      and o.devis = false and o.cancelled_at is null
      and o.date_commande between v_from and v_to
    group by 1
    order by 3 desc
    limit 8
  ) s;

  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(r.montant), 0))
  into v_returns
  from public.sales_returns r
  where r.organization_id = v_org
    and (r.created_at at time zone 'Europe/Paris')::date between v_from and v_to;

  select jsonb_build_object(
    'emis', coalesce(sum(cn.amount), 0),
    'restant', coalesce(sum(greatest(cn.amount - cn.used_amount, 0)), 0))
  into v_credits
  from public.credit_notes cn
  where cn.organization_id = v_org
    and (cn.created_at at time zone 'Europe/Paris')::date between v_from and v_to;

  select coalesce(jsonb_object_agg(p.mode, p.amount), '{}'::jsonb)
  into v_modes
  from (
    select mode,
           sum(case when kind = 'REMBOURSEMENT' then -amount else amount end) as amount
    from public.payments
    where organization_id = v_org
      and cancelled_at is null
      and (received_at at time zone 'Europe/Paris')::date between v_from and v_to
    group by mode
  ) p;

  return jsonb_build_object(
    'totals', v_totals,
    'months', v_months,
    'top_clients', v_clients,
    'top_suppliers', v_suppliers,
    'returns', v_returns,
    'credits', v_credits,
    'payments_by_mode', v_modes
  );
end;
$$;
revoke execute on function public.report_overview(date, date) from public, anon;
grant execute on function public.report_overview(date, date) to authenticated;

notify pgrst, 'reload schema';
