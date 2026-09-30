-- Retours garage (2026-09-30) : demande par article côté garage, validation et
-- réception côté magasin, récupération par le livreur ; règlement par ligne.
--
-- Flux : Garage demande (article, quantité, motif) → Magasin valide (→ « à
-- récupérer », confié au livreur sur la prochaine tournée) → Livreur récupère
-- → Magasin réceptionne (→ « retourné », remise en stock) → avoir / rembourse-
-- ment. Refus possible à la validation. Chaque étape garde qui et quand.
--
-- Côté fiche garage, le caissier qualifie chaque ligne : « À payer », « Payé »
-- (un règlement est enregistré par l'application), « Offert » (étiquette : le
-- solde dû n'est pas modifié par cette migration).

-- ---------------------------------------------------------------------
-- Colonnes
-- ---------------------------------------------------------------------
alter table public.sales_returns
  add column if not exists garage_comment text,
  add column if not exists requested_by uuid references auth.users(id) on delete set null,
  add column if not exists validated_at timestamptz,
  add column if not exists validated_by uuid references auth.users(id) on delete set null,
  add column if not exists received_at timestamptz,
  add column if not exists received_by uuid references auth.users(id) on delete set null;
alter table public.order_lines
  add column if not exists reglement text not null default 'A_PAYER',
  add column if not exists reglement_at timestamptz,
  add column if not exists reglement_by uuid references auth.users(id) on delete set null;
alter table public.order_lines drop constraint if exists order_lines_reglement_check;
alter table public.order_lines add constraint order_lines_reglement_check
  check (reglement in ('A_PAYER', 'PAYE', 'OFFERT'));

-- ---------------------------------------------------------------------
-- Garage : demande de retour sur une ligne de sa commande
-- ---------------------------------------------------------------------
create or replace function public.request_garage_line_return(
  p_line_id uuid,
  p_quantity integer,
  p_motif_code text,
  p_comment text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_line public.order_lines;
  v_order public.orders;
  v_client_name text;
  v_requested integer;
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_ref text;
  v_id uuid;
  v_motif text;
  v_qty integer := coalesce(p_quantity, 1);
  v_comment text := nullif(trim(coalesce(p_comment, '')), '');
begin
  if v_org is null or v_client is null then
    raise exception 'Garage access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if v_qty < 1 then
    raise exception 'Quantity must be at least 1.';
  end if;

  select * into v_line
  from public.order_lines
  where id = p_line_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Line not found.';
  end if;
  select * into v_order
  from public.orders
  where id = v_line.order_id and organization_id = v_org and client_id = v_client;
  if not found then
    raise exception 'Order not found.';
  end if;
  if coalesce(v_order.devis, false) or v_order.cancelled_at is not null then
    raise exception 'This order cannot be returned.';
  end if;
  if v_line.retour_impossible then
    raise exception 'This part cannot be returned.';
  end if;
  select coalesce(sum(r.quantity), 0) into v_requested
  from public.sales_returns r
  where r.order_line_id = v_line.id and r.statut_traitement <> 'REFUSE';
  if v_requested + v_qty > v_line.quantity then
    raise exception 'Only % unit(s) of this part can still be returned.', greatest(v_line.quantity - v_requested, 0);
  end if;

  v_motif := case p_motif_code
    when 'ERREUR_VENDEUR' then 'Erreur de référence du vendeur'
    when 'MAUVAISE_IDENTIFICATION' then 'Mauvaise identification du véhicule'
    when 'ERREUR_CLIENT' then 'Erreur du garage'
    when 'NON_CONFORME' then 'Pièce non conforme à la commande'
    when 'DEFECTUEUSE' then 'Pièce défectueuse à la pose'
    when 'ANNULATION' then 'Commande annulée avant retrait'
    else 'Retour garage'
  end;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':returns:' || v_year::text));
  select coalesce(max(public.ref_seq(ref)), 0) + 1 into v_seq
  from public.sales_returns
  where organization_id = v_org and ref like format('RET-%s-%%', v_year);
  v_ref := format('RET-%s-%s', v_year, lpad(v_seq::text, 5, '0'));

  insert into public.sales_returns (
    organization_id, client_id, order_id, order_line_id, ref, designation, reason, motif,
    type_retour, statut_traitement, decote_pct, montant, quantity, motif_code, garage_comment, requested_by
  ) values (
    v_org, v_client, v_order.id, v_line.id, v_ref, v_line.nom_produit,
    v_motif || case when v_comment is null then '' else ' — ' || v_comment end,
    v_motif, 'RETOURNABLE', 'A_TRAITER', 0,
    round(v_qty * v_line.prix_vente_unitaire, 2), v_qty,
    case when p_motif_code in ('ERREUR_VENDEUR', 'MAUVAISE_IDENTIFICATION', 'ERREUR_CLIENT', 'NON_CONFORME', 'DEFECTUEUSE', 'ANNULATION')
         then p_motif_code end,
    v_comment, auth.uid()
  ) returning id into v_id;

  select c.name into v_client_name from public.clients c where c.id = v_client;
  perform public.notify(
    v_org, 'STAFF', 'RETURN_REQUESTED',
    'Demande de retour ' || v_ref || ' à valider',
    coalesce(v_client_name, 'Garage') || ' · ' || v_qty || ' × ' || v_line.nom_produit || ' (' || v_line.reference || ') · ' || v_motif,
    '/dashboard/retours?filter=A_VALIDER', 'sales_return', v_id
  );
  return v_ref;
end;
$$;
revoke execute on function public.request_garage_line_return(uuid, integer, text, text) from public, anon;
grant execute on function public.request_garage_line_return(uuid, integer, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Magasin : valider (→ à récupérer, confié au livreur) ou refuser
-- ---------------------------------------------------------------------
create or replace function public.validate_garage_return(
  p_return_id uuid,
  p_accept boolean,
  p_tour_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_ret public.sales_returns;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  select * into v_ret
  from public.sales_returns
  where id = p_return_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Return not found.';
  end if;
  if v_ret.client_id is null then
    raise exception 'Only a client return can be validated.';
  end if;
  if v_ret.statut_traitement <> 'A_TRAITER' then
    raise exception 'This return is not waiting for validation.';
  end if;

  if coalesce(p_accept, false) then
    update public.sales_returns
    set statut_traitement = 'A_RECUPERER', validated_at = now(), validated_by = auth.uid()
    where id = v_ret.id;
    if p_tour_id is not null then
      perform public.assign_return_leg(v_ret.id, 'GARAGE_TO_STORE', p_tour_id, null, null);
    end if;
    perform public.notify(
      v_org, 'CLIENT', 'RETURN_VALIDATED',
      'Retour ' || v_ret.ref || ' validé',
      'Le livreur passera récupérer ' || v_ret.quantity || ' × ' || v_ret.designation || '.',
      '/garagiste/dashboard/retours', 'sales_return', v_ret.id, v_ret.client_id
    );
  else
    update public.sales_returns
    set statut_traitement = 'REFUSE', validated_at = now(), validated_by = auth.uid()
    where id = v_ret.id;
    perform public.notify(
      v_org, 'CLIENT', 'RETURN_REFUSED',
      'Retour ' || v_ret.ref || ' refusé',
      v_ret.quantity || ' × ' || v_ret.designation || ' : le magasin ne reprend pas cette pièce.',
      '/garagiste/dashboard/retours', 'sales_return', v_ret.id, v_ret.client_id
    );
  end if;
end;
$$;
revoke execute on function public.validate_garage_return(uuid, boolean, uuid) from public, anon;
grant execute on function public.validate_garage_return(uuid, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Magasin : réceptionner la pièce revenue avec le livreur (→ retourné, en stock)
-- ---------------------------------------------------------------------
create or replace function public.receive_garage_return(p_return_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_ret public.sales_returns;
  v_line public.order_lines;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  select * into v_ret
  from public.sales_returns
  where id = p_return_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Return not found.';
  end if;
  if v_ret.statut_traitement <> 'A_RECUPERER' then
    raise exception 'This return is not waiting to be received.';
  end if;

  update public.sales_returns
  set statut_traitement = 'ACCEPTE',
      received_at = now(),
      received_by = auth.uid(),
      leg_status = case when livreur_leg is not null then 'FAIT' else leg_status end,
      leg_done_at = case when livreur_leg is not null then coalesce(leg_done_at, now()) else leg_done_at end
  where id = v_ret.id;

  -- La pièce est de retour en rayon.
  if v_ret.order_line_id is not null then
    select * into v_line from public.order_lines where id = v_ret.order_line_id;
    if found and nullif(trim(coalesce(v_line.reference, '')), '') is not null then
      perform public.adjust_stock_item(v_line.reference, v_line.nom_produit, v_ret.quantity, 'RETOUR_CLIENT', 'Retour ' || v_ret.ref);
    end if;
    -- The whole line is back on the shelf: it leaves « Pièces à recommander ».
    if found and not coalesce(v_line.retour_stock_fait, false) then
      if (select coalesce(sum(r.quantity), 0) from public.sales_returns r
          where r.order_line_id = v_line.id and r.statut_traitement in ('ACCEPTE', 'REMBOURSE', 'AVOIR')) >= v_line.quantity then
        update public.order_lines set retour_stock_fait = true where id = v_line.id;
      end if;
    end if;
  end if;

  perform public.notify(
    v_org, 'CLIENT', 'RETURN_RECEIVED',
    'Retour ' || v_ret.ref || ' réceptionné',
    v_ret.quantity || ' × ' || v_ret.designation || ' est revenu au magasin.',
    '/garagiste/dashboard/retours', 'sales_return', v_ret.id, v_ret.client_id
  );
end;
$$;
revoke execute on function public.receive_garage_return(uuid) from public, anon;
grant execute on function public.receive_garage_return(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Fiche garage : règlement d'une ligne (étiquette)
-- ---------------------------------------------------------------------
create or replace function public.set_line_reglement(p_line_id uuid, p_reglement text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_reglement not in ('A_PAYER', 'PAYE', 'OFFERT') then
    raise exception 'Invalid line settlement.';
  end if;
  update public.order_lines
  set reglement = p_reglement, reglement_at = now(), reglement_by = auth.uid()
  where id = p_line_id and organization_id = v_org;
  if not found then
    raise exception 'Line not found.';
  end if;
end;
$$;
revoke execute on function public.set_line_reglement(uuid, text) from public, anon;
grant execute on function public.set_line_reglement(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Livreur : la quantité à récupérer apparaît sur la carte du retour
-- (même fonction que 20260919010000, un champ de plus dans « returns »).
-- ---------------------------------------------------------------------
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
          -- La caisse où ranger la pièce : réappro stock, commande d'un garage, ou client comptoir.
          'kind', case
            when coalesce(o.is_restock, false) then 'STOCK'
            when coalesce(c.is_garage, false) then 'GARAGE'
            else 'COMPTOIR'
          end,
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
    ), '[]'::jsonb),
    -- Retours confiés aux tournées du jour : chez le garage (récupérer) ou chez le fournisseur (déposer).
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id,
          'tour_id', r.leg_tour_id,
          'leg', r.livreur_leg,
          'status', r.leg_status,
          'ref', r.ref,
          'designation', r.designation,
          'quantity', r.quantity,
          'reference', ol.reference,
          'order_ref', o.ref_demande,
          'destination', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.name else s.name end,
          'address', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.address end,
          'city', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.city end,
          'phone', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.phone end,
          'slip', r.leg_slip,
          'note', r.leg_note,
          'done_at', r.leg_done_at,
          'done_by', (select pr.display_name from public.profiles pr where pr.user_id = r.leg_done_by limit 1)
        ) order by t.slot_start nulls last, r.livreur_leg, coalesce(c.name, s.name), r.created_at)
      from public.sales_returns r
      join public.delivery_tours t on t.id = r.leg_tour_id
      left join public.clients c on c.id = r.client_id
      left join public.suppliers s on s.id = r.supplier_id
      left join public.order_lines ol on ol.id = r.order_line_id
      left join public.orders o on o.id = r.order_id
      where r.organization_id = v_org
        and t.organization_id = v_org
        and t.tour_date = v_date
        and r.livreur_leg is not null
        and (v_staff or t.livreur_id is null or t.livreur_id = v_livreur)
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.supplier_tour_board(date) from public, anon;
grant execute on function public.supplier_tour_board(date) to authenticated;

notify pgrst, 'reload schema';
