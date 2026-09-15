-- Tournée fournisseurs, suite (2026-09-15, premier essai du comptoir).
--
--  1. Une tournée sans commande n'a pas encore de ligne delivery_tours : le
--     comptoir ne pouvait pas lui affecter un livreur. ensure_supplier_tour()
--     crée la ligne du jour (le livreur attitré s'applique par le trigger).
--  2. Après 17 h, une commande part sur la Tournée 1 du lendemain (et plus
--     loin avec un délai fournisseur) : le tableau du jour restait vide sans
--     rien dire. supplier_tour_board() renvoie maintenant `upcoming`, le
--     nombre de pièces par jour sur les 7 jours suivants.

create or replace function public.ensure_supplier_tour(p_date date, p_name text, p_slot time default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_id uuid;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_date is null or v_name is null then
    raise exception 'A date and a tour name are required.';
  end if;

  select t.id into v_id
  from public.delivery_tours t
  where t.organization_id = v_org and t.name = v_name and t.tour_date = p_date
  order by t.slot_start nulls last
  limit 1;
  if v_id is null then
    insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
    values (v_org, v_name, p_date, p_slot)
    returning delivery_tours.id into v_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.ensure_supplier_tour(date, text, time) from public, anon;
grant execute on function public.ensure_supplier_tour(date, text, time) to authenticated;

create or replace function public.supplier_tour_board(p_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := public.supplier_tour_actor();
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_staff boolean;
  v_today date := timezone('Europe/Paris', now())::date;
  v_date date := coalesce(p_date, timezone('Europe/Paris', now())::date);
begin
  v_staff := v_actor = 'STAFF';
  if not v_staff and (v_date < v_today or v_date > v_today + 6) then
    raise exception 'This tour date is not available.';
  end if;

  return jsonb_build_object(
    'date', v_date,
    'defaults', case when v_staff then coalesce((
      select jsonb_agg(jsonb_build_object('tour_name', d.tour_name, 'livreur_id', d.livreur_id, 'livreur_name', l.name))
      from public.tour_livreur_defaults d
      join public.livreurs l on l.id = d.livreur_id
      where d.organization_id = v_org
    ), '[]'::jsonb) else '[]'::jsonb end,
    -- Pièces à récupérer les jours suivants (7 jours), pour ne pas rester sur un tableau vide.
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object('date', u.tour_date, 'count', u.n) order by u.tour_date)
      from (
        select t.tour_date, count(*) as n
        from public.order_lines ol
        join public.delivery_tours t on t.id = ol.tour_id
        join public.orders o on o.id = ol.order_id
        join public.suppliers s on s.id = ol.supplier_id
        where ol.organization_id = v_org
          and t.organization_id = v_org
          and t.tour_date > v_date
          and t.tour_date <= greatest(v_date, v_today) + 7
          and (v_staff or ((t.livreur_id is null or t.livreur_id = v_livreur) and t.tour_date <= v_today + 6))
          and coalesce(o.devis, false) = false
          and o.cancelled_at is null
          and coalesce(s.own_delivery, false) = false
        group by t.tour_date
      ) u
    ), '[]'::jsonb),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id,
          'name', t.name,
          'slot', to_char(t.slot_start, 'HH24:MI'),
          'status', t.status,
          'started_at', t.started_at,
          'completed_at', t.completed_at,
          'note', t.note,
          'livreur_id', t.livreur_id,
          'livreur_name', l.name
        ) order by t.slot_start nulls last, t.name)
      from public.delivery_tours t
      left join public.livreurs l on l.id = t.livreur_id
      where t.organization_id = v_org
        and t.tour_date = v_date
        and (v_staff or t.livreur_id is null or t.livreur_id = v_livreur)
    ), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', ol.id,
          'tour_id', ol.tour_id,
          'order_id', o.id,
          'order_ref', o.ref_demande,
          'supplier_id', s.id,
          'supplier', s.name,
          'vendeur_id', o.vendeur_id,
          'vendeur', coalesce((
            select nullif(trim(pr.display_name), '') from public.profiles pr where pr.user_id = o.vendeur_id limit 1
          ), 'Vendeur'),
          'reference', ol.reference,
          'reference_commande', ol.reference_commande,
          'designation', ol.nom_produit,
          'quantity', ol.quantity,
          'received', ol.qte_recue,
          'reception_status', ol.reception_status,
          'pickup_status', ol.pickup_status,
          'pickup_at', ol.pickup_at,
          'pickup_by', (select pr.display_name from public.profiles pr where pr.user_id = ol.pickup_by limit 1),
          'is_restock', coalesce(o.is_restock, false),
          'client', case when v_staff then coalesce(
            c.name,
            case when coalesce(o.is_restock, false) then 'Réappro stock' end,
            nullif(o.client_phone, '-'),
            'Client comptoir'
          ) end
        ) order by t.slot_start nulls last, s.name, o.ref_demande, ol.reference)
      from public.order_lines ol
      join public.delivery_tours t on t.id = ol.tour_id
      join public.orders o on o.id = ol.order_id
      join public.suppliers s on s.id = ol.supplier_id
      left join public.clients c on c.id = o.client_id
      where ol.organization_id = v_org
        and t.organization_id = v_org
        and t.tour_date = v_date
        and (v_staff or t.livreur_id is null or t.livreur_id = v_livreur)
        and coalesce(o.devis, false) = false
        and o.cancelled_at is null
        and coalesce(s.own_delivery, false) = false
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.supplier_tour_board(date) from public, anon;
grant execute on function public.supplier_tour_board(date) to authenticated;

notify pgrst, 'reload schema';
