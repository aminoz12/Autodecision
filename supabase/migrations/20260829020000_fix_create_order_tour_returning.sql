-- ============================================================================
--  Fix: create_order_with_lines failed with `column reference "id" is
--  ambiguous` whenever the tournée of the day did not exist yet — the
--  `insert into delivery_tours … returning id` clashed with the function's
--  OUT parameter `id`. Same body as 20260828010000, with the RETURNING
--  clause qualified.
-- ============================================================================

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
  select coalesce(max((regexp_match(o.ref_demande, '(\\d+)$'))[1]::int), 0) + 1
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

  select coalesce(max((regexp_match(num, '(\\d+)$'))[1]::int), 0) + 1
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

notify pgrst, 'reload schema';
