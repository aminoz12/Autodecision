-- Rapports en SQL + abonnement Stripe (audit 2026-09-07, chantiers 4 et 10).
--
--  * report_overview(p_from, p_to) : indicateurs du magasin calculés en base
--    (plus de pagination PostgREST côté navigateur) — commandes, CA, encaissé,
--    reste dû, marge, panier, retours, avoirs, CA par mois, meilleurs clients
--    et fournisseurs, encaissements par mode. Commandes annulées et devis
--    exclus.
--  * report_sales_rows(p_from, p_to) : une ligne par commande pour l'export
--    CSV ; report_line_rows(p_from, p_to) : une ligne par pièce.
--  * organizations : identifiants Stripe (abonnement, prix) écrits par le
--    webhook /api/billing/webhook (service role).

alter table public.organizations
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_price_id text,
  add column if not exists billing_email text;
create index if not exists organizations_stripe_customer_idx on public.organizations (stripe_customer_id);
create index if not exists organizations_stripe_subscription_idx on public.organizations (stripe_subscription_id);

-- ---------------------------------------------------------------------
-- Vue d'ensemble
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
    and (r."createdAt" at time zone 'Europe/Paris')::date between v_from and v_to;

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

-- ---------------------------------------------------------------------
-- Exports CSV
-- ---------------------------------------------------------------------
create or replace function public.report_sales_rows(p_from date default null, p_to date default null)
returns table (
  ref text,
  date_commande date,
  client text,
  is_garage boolean,
  canal text,
  mode_paiement text,
  statut_paiement text,
  montant_total numeric,
  remise_montant numeric,
  montant_paye numeric,
  solde_restant numeric,
  avoir_applique numeric,
  workflow_status text,
  cancelled_at timestamptz,
  facture text
)
language sql
security definer
set search_path = public
stable
as $$
  select o.ref_demande,
         o.date_commande,
         coalesce(cl.name, 'Client comptoir'),
         coalesce(cl.is_garage, false),
         o.canal_vente::text,
         o.mode_paiement,
         o.statut_paiement::text,
         o.montant_total,
         o.remise_montant,
         o.montant_paye + o.avance_payee,
         o.solde_restant,
         o.avoir_applique,
         o.workflow_status::text,
         o.cancelled_at,
         (select i.number from public.invoices i where i.order_id = o.id and i.kind = 'FACTURE' limit 1)
  from public.orders o
  left join public.clients cl on cl.id = o.client_id
  where public.is_counter_staff()
    and o.organization_id = public.current_user_org_id()
    and o.devis = false and o.is_restock = false
    and o.date_commande between coalesce(p_from, date '1900-01-01') and coalesce(p_to, date '2999-12-31')
  order by o.date_commande, o.ref_demande;
$$;
revoke execute on function public.report_sales_rows(date, date) from public, anon;
grant execute on function public.report_sales_rows(date, date) to authenticated;

create or replace function public.report_line_rows(p_from date default null, p_to date default null)
returns table (
  ref text,
  date_commande date,
  client text,
  reference text,
  designation text,
  fournisseur text,
  depuis_magasin boolean,
  quantity integer,
  prix_achat_unitaire numeric,
  prix_brut_unitaire numeric,
  remise_pct numeric,
  prix_vente_unitaire numeric,
  total_ligne numeric,
  reception_status text,
  cancelled boolean
)
language sql
security definer
set search_path = public
stable
as $$
  select o.ref_demande,
         o.date_commande,
         coalesce(cl.name, 'Client comptoir'),
         l.reference,
         l.nom_produit,
         sp.name,
         l.depuis_magasin,
         l.quantity,
         l.prix_achat_unitaire,
         coalesce(l.prix_brut_unitaire, l.prix_vente_unitaire),
         l.remise_pct,
         l.prix_vente_unitaire,
         l.quantity * l.prix_vente_unitaire,
         l.reception_status::text,
         o.cancelled_at is not null
  from public.order_lines l
  join public.orders o on o.id = l.order_id
  left join public.clients cl on cl.id = o.client_id
  left join public.suppliers sp on sp.id = l.supplier_id
  where public.is_counter_staff()
    and l.organization_id = public.current_user_org_id()
    and o.organization_id = public.current_user_org_id()
    and o.devis = false and o.is_restock = false
    and o.date_commande between coalesce(p_from, date '1900-01-01') and coalesce(p_to, date '2999-12-31')
  order by o.date_commande, o.ref_demande, l.id;
$$;
revoke execute on function public.report_line_rows(date, date) from public, anon;
grant execute on function public.report_line_rows(date, date) to authenticated;

notify pgrst, 'reload schema';
