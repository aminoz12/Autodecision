-- Stats équipe pour l'administrateur (2026-10-19).
--
-- L'administrateur ne demande pas de congé et n'a pas « ses » ventes : il a
-- son propre tableau dans /admin (onglet « Stats équipe ») — CA, ventes,
-- devis transformés, marge estimée, retours, pointages par vendeur, et
-- livraisons / échecs / pièces récupérées / tournées par livreur, sur une
-- période. Réservé à l'ADMIN du magasin (is_org_admin, migration
-- 20261018010000). Aucune table nouvelle ; mêmes règles que report_overview
-- et my_counter_stats (devis=false, is_restock=false, non annulées).

create or replace function public.admin_team_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_len integer := (p_to - p_from) + 1;
  v_prev_from date := p_from - v_len;
  v_prev_to date := p_from - 1;
  v_team jsonb;
  v_prev jsonb;
  v_sellers jsonb;
  v_livreurs jsonb;
begin
  if v_org is null or not public.is_org_admin() then
    raise exception 'Admin access is required.';
  end if;
  if p_from is null or p_to is null or p_to < p_from or v_len > 400 then
    raise exception 'Période invalide.';
  end if;

  -- Le magasin entier (y compris les commandes passées par les garages eux-mêmes).
  select jsonb_build_object(
    'orders', count(*),
    'ca', coalesce(sum(o.montant_total), 0),
    'panier_moyen', case when count(*) > 0 then round(coalesce(sum(o.montant_total), 0) / count(*), 2) else 0 end,
    'remises', coalesce(sum(o.remise_montant), 0),
    'devis_total', (
      select count(*) from public.orders o2
      where o2.organization_id = v_org and o2.is_restock = false
        and (o2.devis or o2.devis_status is not null)
        and o2.date_commande between p_from and p_to
    ),
    'devis_accepted', (
      select count(*) from public.orders o2
      where o2.organization_id = v_org and o2.is_restock = false
        and o2.devis_status = 'ACCEPTED'
        and o2.date_commande between p_from and p_to
    ),
    'marge', coalesce((
      select sum(l.quantity * (l.prix_vente_unitaire - l.prix_achat_unitaire))
      from public.order_lines l
      join public.orders o2 on o2.id = l.order_id
      where l.organization_id = v_org and o2.organization_id = v_org
        and o2.devis = false and o2.is_restock = false and o2.cancelled_at is null
        and o2.date_commande between p_from and p_to
        and l.prix_achat_unitaire > 0 and l.prix_vente_unitaire > 0
    ), 0),
    'retours', (
      select count(*) from public.sales_returns sr
      where sr.organization_id = v_org
        and (sr.created_at at time zone 'Europe/Paris')::date between p_from and p_to
    )
  ) into v_team
  from public.orders o
  where o.organization_id = v_org
    and o.devis = false and o.is_restock = false and o.cancelled_at is null
    and o.date_commande between p_from and p_to;

  select jsonb_build_object('orders', count(*), 'ca', coalesce(sum(o.montant_total), 0))
  into v_prev
  from public.orders o
  where o.organization_id = v_org
    and o.devis = false and o.is_restock = false and o.cancelled_at is null
    and o.date_commande between v_prev_from and v_prev_to;

  -- Un rang par vendeur du comptoir (caissiers et administrateurs), même sans vente.
  select coalesce(jsonb_agg(to_jsonb(s) order by s.ca desc, s.orders desc, s.name), '[]'::jsonb)
  into v_sellers
  from (
    select
      p.user_id,
      coalesce(nullif(trim(p.display_name), ''), 'Membre') as name,
      p.role::text as role,
      coalesce(a.orders, 0) as orders,
      coalesce(a.ca, 0) as ca,
      case when coalesce(a.orders, 0) > 0 then round(a.ca / a.orders, 2) else 0 end as panier_moyen,
      coalesce(d.devis_total, 0) as devis_total,
      coalesce(d.devis_accepted, 0) as devis_accepted,
      coalesce(m.marge, 0) as marge,
      coalesce(r.retours, 0) as retours,
      coalesce(lp.n, 0) as lines_pointed,
      coalesce(lh.n, 0) as lines_handed
    from public.profiles p
    left join lateral (
      select count(*) as orders, sum(o.montant_total) as ca
      from public.orders o
      where o.organization_id = v_org and o.vendeur_id = p.user_id
        and o.devis = false and o.is_restock = false and o.cancelled_at is null
        and o.date_commande between p_from and p_to
    ) a on true
    left join lateral (
      select count(*) filter (where o.devis or o.devis_status is not null) as devis_total,
             count(*) filter (where o.devis_status = 'ACCEPTED') as devis_accepted
      from public.orders o
      where o.organization_id = v_org and o.vendeur_id = p.user_id and o.is_restock = false
        and o.date_commande between p_from and p_to
    ) d on true
    left join lateral (
      select sum(l.quantity * (l.prix_vente_unitaire - l.prix_achat_unitaire)) as marge
      from public.order_lines l
      join public.orders o on o.id = l.order_id
      where l.organization_id = v_org and o.organization_id = v_org and o.vendeur_id = p.user_id
        and o.devis = false and o.is_restock = false and o.cancelled_at is null
        and o.date_commande between p_from and p_to
        and l.prix_achat_unitaire > 0 and l.prix_vente_unitaire > 0
    ) m on true
    left join lateral (
      select count(*) as retours
      from public.sales_returns sr
      join public.orders o on o.id = sr.order_id
      where sr.organization_id = v_org and o.vendeur_id = p.user_id
        and (sr.created_at at time zone 'Europe/Paris')::date between p_from and p_to
    ) r on true
    left join lateral (
      select count(*) as n from public.order_lines l
      where l.organization_id = v_org and l.pointed_by = p.user_id
        and (l.pointed_at at time zone 'Europe/Paris')::date between p_from and p_to
    ) lp on true
    left join lateral (
      select count(*) as n from public.order_lines l
      where l.organization_id = v_org and l.handed_by = p.user_id
        and (l.handed_at at time zone 'Europe/Paris')::date between p_from and p_to
    ) lh on true
    where p.organization_id = v_org and p.client_id is null and p.livreur_id is null
      and p.role in ('ADMIN'::public.user_role, 'CAISSIER'::public.user_role)
  ) s;

  -- Un rang par livreur (avec ou sans login), même sans livraison.
  select coalesce(jsonb_agg(to_jsonb(v) order by v.delivered desc, v.name), '[]'::jsonb)
  into v_livreurs
  from (
    select
      lv.id as livreur_id,
      lv.name,
      lv.active,
      pr.user_id,
      (select count(*) from public.orders o
       where o.organization_id = v_org and o.workflow_status = 'DELIVERED'
         and (o.delivered_by = pr.user_id or (o.delivered_by is null and o.livreur_id = lv.id))
         and (o.delivered_at at time zone 'Europe/Paris')::date between p_from and p_to) as delivered,
      (select count(*) from public.orders o
       where o.organization_id = v_org and o.livreur_id = lv.id
         and (o.delivery_failed_at at time zone 'Europe/Paris')::date between p_from and p_to) as failed,
      (select count(*) from public.order_lines l
       join public.delivery_tours t on t.id = l.tour_id
       where l.organization_id = v_org and t.livreur_id = lv.id and l.pickup_status = 'PICKED_UP'
         and (l.pickup_at at time zone 'Europe/Paris')::date between p_from and p_to) as pickups,
      (select count(*) from public.delivery_tours t
       where t.organization_id = v_org and t.livreur_id = lv.id
         and t.status = 'TERMINEE' and t.tour_date between p_from and p_to) as tours
    from public.livreurs lv
    left join public.profiles pr on pr.livreur_id = lv.id
    where lv.organization_id = v_org
  ) v;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'team', v_team, 'prev', v_prev,
    'sellers', v_sellers, 'livreurs', v_livreurs
  );
end;
$$;
revoke execute on function public.admin_team_stats(date, date) from public, anon;
grant execute on function public.admin_team_stats(date, date) to authenticated;

notify pgrst, 'reload schema';
