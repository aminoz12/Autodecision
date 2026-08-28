-- ============================================================================
--  Fix reference allocation.
--
--  The sequence lookups written as regexp_match(ref, '(\d+)$') contain a
--  literal double backslash (standard_conforming_strings = on), so the regex
--  never matched: every allocator returned 1 and the second order / return /
--  credit note / consigne of a year failed on the per-org unique key.
--  `ref_seq()` extracts the trailing number without any backslash escaping,
--  and the affected functions are re-created with it (bodies otherwise
--  identical to 20260828010000 / 20260829010000 / 20260829020000).
-- ============================================================================

create or replace function public.ref_seq(p_ref text)
returns integer
language sql
immutable
strict
as $$
  select nullif(substring(p_ref from '[0-9]+$'), '')::integer;
$$;

grant execute on function public.ref_seq(text) to authenticated;

create or replace function public.create_walk_in_return(
  p_order_id uuid,
  p_line_ids uuid[],
  p_reason text,
  p_compensation text,
  p_supplier_id uuid default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_line public.order_lines;
  v_total numeric := 0;
  v_count integer := 0;
  v_year integer := extract(year from current_date);
  v_return_seq integer;
  v_credit_seq integer;
  v_ref text;
  v_avoir_num text;
  v_expiry date := (current_date + interval '1 year')::date;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one line.';
  end if;
  if p_compensation not in ('REMBOURSEMENT', 'AVOIR', 'FOURNISSEUR') then
    raise exception 'Invalid return compensation.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and devis = false
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;

  if p_compensation = 'FOURNISSEUR' and (
    p_supplier_id is null or not exists (
      select 1 from public.suppliers s where s.id = p_supplier_id and s.organization_id = v_org
    )
  ) then
    raise exception 'A supplier from this organization is required.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':returns:' || v_year::text));
  select coalesce(max(public.ref_seq(ref)), 0) + 1
  into v_return_seq
  from public.sales_returns
  where organization_id = v_org and ref like format('RET-%s-%%', v_year);

  for v_line in
    select *
    from public.order_lines
    where id = any(p_line_ids)
      and order_id = v_order.id
      and organization_id = v_org
    for update
  loop
    v_count := v_count + 1;
    if v_line.retour_impossible then
      raise exception 'This order line cannot be returned.';
    end if;
    if exists (
      select 1 from public.sales_returns r where r.order_line_id = v_line.id
    ) then
      raise exception 'This order line has already been returned.';
    end if;

    v_ref := format('RET-%s-%s', v_year, lpad(v_return_seq::text, 5, '0'));
    v_return_seq := v_return_seq + 1;
    v_total := v_total + v_line.quantity * v_line.prix_vente_unitaire;

    insert into public.sales_returns (
      organization_id, client_id, order_id, order_line_id, ref, designation,
      reason, motif, type_retour, statut_traitement, decote_pct, montant, supplier_id
    ) values (
      v_org, v_order.client_id, v_order.id, v_line.id, v_ref, v_line.nom_produit,
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      'RETOURNABLE',
      case when p_compensation = 'FOURNISSEUR' then 'A_TRAITER'::public.return_treatment
           when p_compensation = 'AVOIR' then 'AVOIR'::public.return_treatment
           else 'REMBOURSE'::public.return_treatment end,
      0, v_line.quantity * v_line.prix_vente_unitaire,
      case when p_compensation = 'FOURNISSEUR' then p_supplier_id else null end
    );
  end loop;

  if v_count <> array_length(p_line_ids, 1) then
    raise exception 'One or more selected lines do not belong to this order.';
  end if;

  if p_compensation <> 'AVOIR' then
    return null;
  end if;

  select coalesce(max(public.ref_seq(num)), 0) + 1
  into v_credit_seq
  from public.credit_notes
  where organization_id = v_org and num like format('AV-%s-%%', v_year);
  v_avoir_num := format('AV-%s-%s', v_year, lpad(v_credit_seq::text, 5, '0'));

  insert into public.credit_notes (
    organization_id, client_id, order_id, num, amount, used_amount, statut,
    echeance, motif, designation
  ) values (
    v_org, v_order.client_id, v_order.id, v_avoir_num, v_total, 0, 'EN_COURS',
    v_expiry, coalesce(nullif(trim(p_reason), ''), 'Retour client'),
    (select string_agg(nom_produit, ', ') from public.order_lines where id = any(p_line_ids))
  );

  return v_avoir_num;
end;
$$;

create or replace function public.request_garage_return(
  p_order_id uuid,
  p_designation text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_year integer := extract(year from current_date);
  v_seq integer;
begin
  if v_org is null or v_client is null then
    raise exception 'Garage access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if nullif(trim(p_designation), '') is null or nullif(trim(p_reason), '') is null then
    raise exception 'Designation and reason are required.';
  end if;
  if p_order_id is not null and not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.organization_id = v_org and o.client_id = v_client
  ) then
    raise exception 'Order not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':returns:' || v_year::text));
  select coalesce(max(public.ref_seq(ref)), 0) + 1 into v_seq
  from public.sales_returns
  where organization_id = v_org and ref like format('RET-%s-%%', v_year);

  insert into public.sales_returns (
    organization_id, client_id, order_id, ref, designation, reason, motif,
    type_retour, statut_traitement, decote_pct, montant
  ) values (
    v_org, v_client, p_order_id,
    format('RET-%s-%s', v_year, lpad(v_seq::text, 5, '0')),
    trim(p_designation), trim(p_reason), trim(p_reason), 'RETOURNABLE',
    'A_TRAITER', 0, 0
  );
end;
$$;

create or replace function public.create_order_with_lines(p_payload jsonb)
returns table (
  id uuid,
  ref_demande text,
  tour_name text,
  delivery_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_is_garage boolean := v_client is not null;
  v_order_id uuid;
  v_ref text;
  v_year integer := extract(year from current_date);
  v_ref_seq integer;
  v_total numeric := 0;
  v_paid numeric := greatest(coalesce((p_payload->>'montant_paye')::numeric, 0), 0);
  v_advance numeric := greatest(coalesce((p_payload->>'avance_payee')::numeric, 0), 0);
  v_remaining numeric;
  v_order_client uuid;
  v_line jsonb;
  v_qty integer;
  v_sale numeric;
  v_purchase numeric;
  v_consigne numeric;
  v_from_stock boolean;
  v_supplier uuid;
  v_is_consigne boolean;
  v_order_is_devis boolean;
  v_send_delivery boolean;
  v_tour_name text := null;
  v_delivery_at timestamptz := null;
  v_tour_date date;
  v_tour_slot time;
  v_tour_id uuid := null;
  v_local timestamp;
  v_minutes integer;
  v_tour_number integer;
  v_credit_id uuid;
  v_credit_amount numeric;
  v_consigne_seq integer;
  v_line_id uuid;
begin
  if v_org is null or auth.uid() is null then
    raise exception 'Authenticated organization access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if jsonb_typeof(p_payload->'lines') <> 'array' or jsonb_array_length(p_payload->'lines') = 0 then
    raise exception 'At least one order line is required.';
  end if;

  v_order_is_devis := case when v_is_garage then true else coalesce((p_payload->>'devis')::boolean, false) end;
  v_send_delivery := case when v_is_garage then false else coalesce((p_payload->>'envoyer_au_livreur')::boolean, false) end;

  if v_is_garage then
    v_order_client := v_client;
    v_paid := 0;
    v_advance := 0;
  else
    begin
      v_order_client := nullif(p_payload->>'client_id', '')::uuid;
    exception when others then
      v_order_client := null;
    end;
    if v_order_client is not null and not exists (
      select 1 from public.clients c where c.id = v_order_client and c.organization_id = v_org
    ) then
      raise exception 'Client does not belong to this organization.';
    end if;
  end if;

  -- Validate every line before creating the order.
  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    if nullif(trim(v_line->>'nom_produit'), '') is null or nullif(trim(v_line->>'reference'), '') is null then
      raise exception 'Each line needs a designation and a reference.';
    end if;
    v_qty := coalesce((v_line->>'quantity')::integer, 0);
    if v_qty <= 0 then
      raise exception 'Line quantity must be positive.';
    end if;
    v_sale := greatest(coalesce((v_line->>'prix_vente_unitaire')::numeric, 0), 0);
    v_consigne := case when coalesce((v_line->>'consigne')::boolean, false)
      then greatest(coalesce((v_line->>'consigne_price')::numeric, 0), 0)
      else 0 end;
    if not v_is_garage then
      v_total := v_total + v_qty * (v_sale + v_consigne);
    end if;
  end loop;

  if v_paid + v_advance > v_total then
    raise exception 'Amounts paid cannot exceed the order total.';
  end if;
  v_remaining := greatest(0, v_total - v_paid - v_advance);

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':orders:' || v_year::text));
  select coalesce(max(public.ref_seq(o.ref_demande)), 0) + 1
  into v_ref_seq
  from public.orders o
  where o.organization_id = v_org and o.ref_demande like format('REQ-%s-%%', v_year);
  v_ref := format('REQ-%s-%s', v_year, lpad(v_ref_seq::text, 5, '0'));

  if not v_order_is_devis then
    v_local := timezone('Europe/Paris', now());
    v_minutes := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
    if v_minutes between 571 and 720 then
      v_tour_number := 2; v_tour_slot := time '13:00';
    elsif v_minutes between 721 and 870 then
      v_tour_number := 3; v_tour_slot := time '15:00';
    elsif v_minutes between 871 and 1020 then
      v_tour_number := 4; v_tour_slot := time '17:30';
    else
      v_tour_number := 1; v_tour_slot := time '10:00';
    end if;
    v_tour_date := v_local::date + case when v_tour_number = 1 and v_minutes > 1020 then 1 else 0 end;
    v_tour_name := format('Tournée %s', v_tour_number);
    v_delivery_at := (v_tour_date + v_tour_slot) at time zone 'Europe/Paris';

    select t.id into v_tour_id
    from public.delivery_tours t
    where t.organization_id = v_org and t.name = v_tour_name and t.tour_date = v_tour_date
    limit 1;
    if v_tour_id is null then
      insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
      values (v_org, v_tour_name, v_tour_date, v_tour_slot)
      returning delivery_tours.id into v_tour_id;
    end if;
  end if;

  insert into public.orders (
    organization_id, ref_demande, date_commande, vendeur_id, canal_vente,
    client_id, client_phone, client_email, immatriculation, vehicle_model,
    kilometrage, montant_total, devis, devis_status, statut_paiement,
    montant_paye, avance_payee, solde_restant, envoyer_au_livreur, date_envoi,
    statut_livreur, consigne, workflow_status, bl, date_bl
  ) values (
    v_org, v_ref,
    case when v_is_garage then timezone('Europe/Paris', now())::date
         else coalesce(nullif(p_payload->>'date_commande', '')::date, current_date) end,
    auth.uid(),
    case when v_is_garage then 'B2B'::public.orders_canal_vente_enum
         else (p_payload->>'canal_vente')::public.orders_canal_vente_enum end,
    v_order_client,
    case when v_is_garage then coalesce(nullif(trim(p_payload->>'client_phone'), ''), '-')
         else coalesce(nullif(trim(p_payload->>'client_phone'), ''), '-') end,
    nullif(trim(p_payload->>'client_email'), ''),
    nullif(trim(p_payload->>'immatriculation'), ''),
    nullif(trim(p_payload->>'vehicle_model'), ''),
    nullif(p_payload->>'kilometrage', '')::integer,
    v_total, v_order_is_devis,
    case when v_is_garage then 'REQUESTED' when v_order_is_devis then nullif(p_payload->>'devis_status', '') else null end,
    case when v_is_garage then 'NON_PAYÉ'::public.orders_statut_paiement_enum
         else (p_payload->>'statut_paiement')::public.orders_statut_paiement_enum end,
    v_paid, v_advance, v_remaining, v_send_delivery, v_delivery_at,
    'EN_ATTENTE', nullif(trim(p_payload->>'consigne'), ''),
    case when v_send_delivery then 'TO_COLLECT'::public.orders_workflow_status_enum else 'PENDING'::public.orders_workflow_status_enum end,
    coalesce((p_payload->>'bl')::boolean, false), nullif(p_payload->>'date_bl', '')::date
  ) returning orders.id into v_order_id;

  select coalesce(max(public.ref_seq(num)), 0) + 1
  into v_consigne_seq
  from public.consignment_entries
  where organization_id = v_org and num like format('CO-%s-%%', v_year);

  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    v_qty := (v_line->>'quantity')::integer;
    v_purchase := greatest(coalesce((v_line->>'prix_achat_unitaire')::numeric, 0), 0);
    v_sale := case when v_is_garage then 0 else greatest(coalesce((v_line->>'prix_vente_unitaire')::numeric, 0), 0) end;
    v_is_consigne := case when v_is_garage then false else coalesce((v_line->>'consigne')::boolean, false) end;
    v_consigne := case when v_is_consigne then greatest(coalesce((v_line->>'consigne_price')::numeric, 0), 0) else null end;
    v_from_stock := case when v_is_garage then false else coalesce((v_line->>'depuis_magasin')::boolean, false) end;
    begin
      v_supplier := nullif(v_line->>'fournisseur_id', '')::uuid;
    exception when others then
      v_supplier := null;
    end;
    if v_supplier is not null and not exists (
      select 1 from public.suppliers s where s.id = v_supplier and s.organization_id = v_org
    ) then
      raise exception 'Supplier does not belong to this organization.';
    end if;

    insert into public.order_lines (
      organization_id, order_id, nom_produit, reference, supplier_id, quantity,
      a_commander_pour_livreur, depuis_magasin, retour_stock_fait,
      retour_impossible, consigne, consigne_price, qte_remise, remise_at,
      prix_achat_unitaire, prix_vente_unitaire, tour_id, qte_recue,
      reception_status, received_at
    ) values (
      v_org, v_order_id, trim(v_line->>'nom_produit'), trim(v_line->>'reference'), v_supplier, v_qty,
      case when v_is_garage then false else coalesce((v_line->>'a_commander_pour_livreur')::boolean, false) end,
      v_from_stock, false,
      case when v_is_garage then false else coalesce((v_line->>'retour_impossible')::boolean, false) end,
      v_is_consigne, v_consigne,
      least(v_qty, greatest(0, coalesce((v_line->>'qte_remise')::integer, 0))),
      case when coalesce((v_line->>'qte_remise')::integer, 0) > 0 then now() else null end,
      v_purchase, v_sale, v_tour_id,
      case when v_from_stock and v_supplier is null then v_qty else 0 end,
      case when v_from_stock and v_supplier is null then 'RECEIVED'::public.reception_status else 'PENDING'::public.reception_status end,
      case when v_from_stock and v_supplier is null then now() else null end
    ) returning order_lines.id into v_line_id;

    if v_is_consigne then
      insert into public.consignment_entries (
        organization_id, client_id, order_id, order_line_id, num, reference,
        description, quantity, montant, motif, status
      ) values (
        v_org, v_order_client, v_order_id, v_line_id,
        format('CO-%s-%s', v_year, lpad(v_consigne_seq::text, 5, '0')),
        trim(v_line->>'reference'), trim(v_line->>'nom_produit'), v_qty,
        v_qty * v_consigne, 'Consigne pièce', 'ACTIF'
      );
      v_consigne_seq := v_consigne_seq + 1;
    end if;

    -- A shelf sale reserves/leaves stock immediately. This update is atomic
    -- and rejects a concurrent oversell when the SKU is tracked in stock.
    if not v_is_garage and v_from_stock and v_supplier is null then
      update public.stock_items
      set quantity_on_hand = quantity_on_hand - v_qty, updated_at = now()
      where organization_id = v_org
        and sku = trim(v_line->>'reference')
        and quantity_on_hand >= v_qty;
      if not found and exists (
        select 1 from public.stock_items
        where organization_id = v_org and sku = trim(v_line->>'reference')
      ) then
        raise exception 'Insufficient stock for reference %.', trim(v_line->>'reference');
      end if;
    end if;
  end loop;

  if v_send_delivery then
    insert into public.delivery_tasks (organization_id, order_id, workflow_status)
    values (v_org, v_order_id, 'TO_COLLECT');
  end if;

  if not v_is_garage then
    begin
      v_credit_id := nullif(p_payload->>'avoir_id', '')::uuid;
      v_credit_amount := coalesce((p_payload->>'avoir_applique')::numeric, 0);
    exception when others then
      v_credit_id := null;
      v_credit_amount := 0;
    end;
    if v_credit_id is not null and v_credit_amount > 0 then
      perform public.apply_credit_note(v_org, v_credit_id, v_order_id, v_credit_amount);
    end if;
  end if;

  return query select v_order_id, v_ref, v_tour_name, v_delivery_at;
end;
$$;

create or replace function public.reorder_stock_lines(
  p_line_ids uuid[],
  p_supplier_id uuid,
  p_reference_commandes jsonb default '{}'::jsonb
)
returns table (
  order_id uuid,
  ref_demande text,
  tour_name text,
  delivery_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_ref text;
  v_order_id uuid;
  v_line public.order_lines;
  v_new_id uuid;
  v_count integer := 0;
  v_t record;
  v_tour_id uuid;
  v_ref_cmd text;
begin
  if v_org is null or auth.uid() is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one line.';
  end if;
  if p_supplier_id is null or not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.organization_id = v_org
  ) then
    raise exception 'A supplier from this organization is required.';
  end if;

  select * into v_t from public.next_tournee();

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':orders:' || v_year::text));

  select t.id into v_tour_id
  from public.delivery_tours t
  where t.organization_id = v_org and t.name = v_t.tour_name and t.tour_date = v_t.tour_date
  limit 1;
  if v_tour_id is null then
    insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
    values (v_org, v_t.tour_name, v_t.tour_date, v_t.tour_slot)
    returning delivery_tours.id into v_tour_id;
  end if;

  select coalesce(max(public.ref_seq(o.ref_demande)), 0) + 1
  into v_seq
  from public.orders o
  where o.organization_id = v_org and o.ref_demande like format('REQ-%s-%%', v_year);
  v_ref := format('REQ-%s-%s', v_year, lpad(v_seq::text, 5, '0'));

  insert into public.orders (
    organization_id, ref_demande, date_commande, vendeur_id, canal_vente,
    client_id, client_phone, montant_total, devis, statut_paiement,
    montant_paye, avance_payee, solde_restant, envoyer_au_livreur,
    statut_livreur, workflow_status, is_restock
  ) values (
    v_org, v_ref, timezone('Europe/Paris', now())::date, auth.uid(),
    'MAGASIN'::public.orders_canal_vente_enum,
    null, '-', 0, false, 'PAYÉ'::public.orders_statut_paiement_enum,
    0, 0, 0, false,
    'EN_ATTENTE', 'PENDING'::public.orders_workflow_status_enum, true
  ) returning orders.id into v_order_id;

  for v_line in
    select *
    from public.order_lines l
    where l.id = any(p_line_ids) and l.organization_id = v_org
    for update
  loop
    v_count := v_count + 1;
    if not v_line.depuis_magasin or v_line.supplier_id is not null then
      raise exception 'Reference % is not a stock sale.', v_line.reference;
    end if;
    if v_line.restock_line_id is not null then
      raise exception 'Reference % has already been re-ordered.', v_line.reference;
    end if;

    v_ref_cmd := nullif(trim(coalesce(p_reference_commandes ->> (v_line.id::text), '')), '');

    insert into public.order_lines (
      organization_id, order_id, nom_produit, reference, reference_commande,
      supplier_id, quantity, a_commander_pour_livreur, depuis_magasin,
      retour_stock_fait, retour_impossible, consigne, consigne_price,
      qte_remise, prix_achat_unitaire, prix_vente_unitaire, tour_id,
      qte_recue, reception_status, prevue_le, origine
    ) values (
      v_org, v_order_id, v_line.nom_produit, v_line.reference, v_ref_cmd,
      p_supplier_id, v_line.quantity, true, true,
      false, false, false, null,
      0, v_line.prix_achat_unitaire, v_line.prix_vente_unitaire, v_tour_id,
      0, 'PENDING'::public.reception_status, v_t.delivery_at, 'stock'
    ) returning order_lines.id into v_new_id;

    update public.order_lines set restock_line_id = v_new_id where id = v_line.id;
  end loop;

  if v_count <> array_length(p_line_ids, 1) then
    raise exception 'One or more selected lines were not found.';
  end if;

  return query select v_order_id, v_ref, v_t.tour_name, v_t.delivery_at;
end;
$$;

notify pgrst, 'reload schema';
