-- Security hardening (audit 2026-09-07, section 2).
--
--  1. Every counter RPC now requires is_counter_staff(): the LIVREUR role used
--     to pass the old "client_id is null" guard and could refund, mint avoirs,
--     zero the stock or create orders.
--  2. dispatch_order_to_livreur is counter-staff only (a driver could self-assign
--     any order and read the whole client list through RLS).
--  3. settle_client_return caps the amount to the returned value.
--  4. create_order_with_lines refuses non-garage, non-staff callers, and takes
--     is_restock from the payload (no more direct UPDATE from the browser).
--  5. respond_garage_quote: one atomic RPC instead of N browser updates on
--     order_lines prices.
--  6. Column-level grants: money / workflow columns of orders and order_lines,
--     stock quantities, financial documents and profiles can no longer be
--     written directly through PostgREST — only through the RPCs.
--  7. Garagistes read their lines through the garage_order_lines view (no
--     purchase price, no supplier); organizations are counter-staff only.
--  8. audit_log table + row triggers on the financial tables.
--  9. platform_owners table (SaaS owner bound to a user id, not an email).
-- 10. next_ref_demande no longer callable by anon/authenticated.
-- 11. handle_new_user only self-provisions an organization for a fresh signup.

create or replace function public.assert_counter_staff()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.current_user_org_id() is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
end;
$$;
revoke execute on function public.assert_counter_staff() from public, anon;
grant execute on function public.assert_counter_staff() to authenticated;

-- ---------------------------------------------------------------------
-- 1 + 2. Guards
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.adjust_loyalty_points(p_client_id uuid, p_points integer, p_kind text, p_reason text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_balance integer;
  v_delta integer;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_kind not in ('REDEEM', 'BONUS', 'ADJUST') then
    raise exception 'Invalid loyalty transaction kind.';
  end if;
  if coalesce(p_points, 0) = 0 then
    raise exception 'Points must be non-zero.';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.organization_id = v_org and c.is_garage = false
  ) then
    raise exception 'Client not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext('loyalty:' || p_client_id::text));
  select coalesce(sum(points), 0) into v_balance
  from public.loyalty_transactions where client_id = p_client_id;

  v_delta := case
    when p_kind = 'REDEEM' then -abs(p_points)
    when p_kind = 'BONUS' then abs(p_points)
    else p_points end;
  if v_balance + v_delta < 0 then
    raise exception 'Insufficient points (balance %).', v_balance;
  end if;

  insert into public.loyalty_transactions (organization_id, client_id, kind, points, reason, created_by)
  values (v_org, p_client_id, p_kind, v_delta, nullif(trim(coalesce(p_reason, '')), ''), auth.uid());
  return v_balance + v_delta;
end;
$function$;

CREATE OR REPLACE FUNCTION public.adjust_stock_item(p_sku text, p_name text, p_delta integer)
 RETURNS stock_items
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_result public.stock_items;
  v_sku text := nullif(trim(p_sku), '');
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if v_sku is null then
    raise exception 'SKU is required.';
  end if;

  insert into public.stock_items (organization_id, sku, name, quantity_on_hand)
  values (v_org, v_sku, coalesce(nullif(trim(p_name), ''), v_sku), greatest(coalesce(p_delta, 0), 0))
  on conflict (organization_id, sku) do update
    set quantity_on_hand = greatest(0, public.stock_items.quantity_on_hand + coalesce(p_delta, 0)),
        name = coalesce(nullif(trim(p_name), ''), public.stock_items.name),
        updated_at = now()
  returning * into v_result;
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.apply_credit_note(p_org uuid, p_credit uuid, p_order uuid, p_amount numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_credit public.credit_notes;
  v_order public.orders;
  v_remaining numeric;
begin
  if v_org is null or p_org is distinct from v_org or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_amount is null or p_amount <= 0 then
    raise exception 'Invalid credit amount.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order and organization_id = v_org and devis = false
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if coalesce(v_order.avoir_applique, 0) <> 0 then
    raise exception 'A credit note has already been applied to this order.';
  end if;

  select * into v_credit
  from public.credit_notes
  where id = p_credit and organization_id = v_org
  for update;
  if not found then
    raise exception 'Credit note not found.';
  end if;
  if v_credit.client_id is distinct from v_order.client_id then
    raise exception 'This credit note belongs to another client.';
  end if;
  if v_credit.echeance is not null and v_credit.echeance < current_date then
    raise exception 'Credit note has expired.';
  end if;

  v_remaining := v_credit.amount - v_credit.used_amount;
  if p_amount > v_remaining then
    raise exception 'Insufficient credit-note balance.';
  end if;
  if p_amount > v_order.solde_restant then
    raise exception 'Credit amount exceeds the order balance.';
  end if;

  update public.credit_notes
  set used_amount = used_amount + p_amount,
      statut = case when used_amount + p_amount >= amount
        then 'UTILISE'::public.credit_status
        else 'PARTIEL'::public.credit_status
      end,
      updated_at = now()
  where id = v_credit.id;

  update public.orders
  set avoir_id = v_credit.id,
      avoir_applique = p_amount,
      solde_restant = solde_restant - p_amount,
      statut_paiement = case
        when solde_restant - p_amount <= 0 then 'PAYÉ'::public.orders_statut_paiement_enum
        when coalesce(montant_paye, 0) + coalesce(avance_payee, 0) + p_amount > 0 then 'PARTIEL'::public.orders_statut_paiement_enum
        else statut_paiement end,
      updated_at = now()
  where id = v_order.id;

  return v_remaining - p_amount;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_walk_in_return(p_order_id uuid, p_line_ids uuid[], p_reason text, p_compensation text, p_supplier_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if v_org is null or not public.is_counter_staff() then
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
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_order_to_livreur(p_order_id uuid, p_livreur_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_livreur_id is null or not exists (
    select 1 from public.livreurs l
    where l.id = p_livreur_id and l.organization_id = v_org and l.active
  ) then
    raise exception 'An active livreur from this organization is required.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and devis = false
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.workflow_status = 'DELIVERED'::public.orders_workflow_status_enum then
    raise exception 'This order has already been delivered.';
  end if;

  update public.orders
  set livreur_id = p_livreur_id,
      envoyer_au_livreur = true,
      workflow_status = 'IN_TRANSIT'::public.orders_workflow_status_enum,
      statut_livreur = 'EN_COURS'::public.orders_statut_livreur_enum,
      date_envoi = coalesce(date_envoi, now()),
      updated_at = now()
  where id = v_order.id;

  if exists (select 1 from public.delivery_tasks t where t.order_id = v_order.id) then
    update public.delivery_tasks
    set livreur_id = p_livreur_id,
        workflow_status = 'IN_TRANSIT'::public.delivery_tasks_workflow_status_enum,
        updated_at = now()
    where order_id = v_order.id;
  else
    insert into public.delivery_tasks (organization_id, order_id, workflow_status, livreur_id)
    values (v_org, v_order.id, 'IN_TRANSIT'::public.delivery_tasks_workflow_status_enum, p_livreur_id);
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.receive_order_line(p_line_id uuid)
 RETURNS order_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
  v_result public.order_lines;
  v_qty integer;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_line
  from public.order_lines
  where id = p_line_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order line not found.';
  end if;

  v_qty := greatest(v_line.quantity - v_line.qte_recue, 0);
  update public.order_lines
  set qte_recue = quantity,
      reception_status = 'RECEIVED',
      received_at = now(),
      retour_stock_fait = case when v_line.depuis_magasin then true else retour_stock_fait end
  where id = v_line.id
  returning * into v_result;

  -- Only replenishment lines belong in stock. A supplier delivery made for a
  -- named customer is fulfilled to that customer, not added to inventory.
  if v_qty > 0 and v_line.depuis_magasin then
    insert into public.stock_items (organization_id, sku, name, quantity_on_hand)
    values (v_org, v_line.reference, v_line.nom_produit, v_qty)
    on conflict (organization_id, sku) do update
      set quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
          name = coalesce(public.stock_items.name, excluded.name),
          updated_at = now();
  end if;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reorder_stock_lines(p_line_ids uuid[], p_supplier_id uuid, p_reference_commandes jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(order_id uuid, ref_demande text, tour_name text, delivery_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if v_org is null or auth.uid() is null or not public.is_counter_staff() then
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
$function$;

CREATE OR REPLACE FUNCTION public.set_consignment_status(p_entry_id uuid, p_status text)
 RETURNS consignment_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_entry public.consignment_entries;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_status not in ('ACTIF', 'RENDUE') then
    raise exception 'Invalid consignment status.';
  end if;

  update public.consignment_entries
  set status = p_status
  where id = p_entry_id and organization_id = v_org
  returning * into v_entry;
  if not found then
    raise exception 'Consignment entry not found.';
  end if;
  return v_entry;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_order_line_handed_over(p_line_id uuid, p_quantity integer)
 RETURNS order_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_line
  from public.order_lines
  where id = p_line_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order line not found.';
  end if;

  update public.order_lines
  set qte_remise = least(quantity, greatest(0, coalesce(p_quantity, 0))),
      remise_at = case when greatest(0, coalesce(p_quantity, 0)) > 0 then now() else null end
  where id = v_line.id
  returning * into v_line;
  return v_line;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_order_line_reception_status(p_line_id uuid, p_status reception_status)
 RETURNS order_lines
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_status not in ('BACKORDER'::public.reception_status, 'NOT_RECEIVED'::public.reception_status) then
    raise exception 'Use receive_order_line to mark a line as received.';
  end if;

  update public.order_lines
  set reception_status = p_status
  where id = p_line_id and organization_id = v_org
  returning * into v_line;
  if not found then
    raise exception 'Order line not found.';
  end if;
  return v_line;
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_return_treatment(p_return_id uuid, p_treatment return_treatment)
 RETURNS sales_returns
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_return public.sales_returns;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_return
  from public.sales_returns
  where id = p_return_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Return not found.';
  end if;

  if not (
    (v_return.statut_traitement = 'A_TRAITER'::public.return_treatment
      and p_treatment = 'DEMANDE_ENVOYEE'::public.return_treatment)
    or (v_return.statut_traitement = 'DEMANDE_ENVOYEE'::public.return_treatment
      and p_treatment = 'A_RECUPERER'::public.return_treatment)
    or (v_return.statut_traitement = 'A_RECUPERER'::public.return_treatment
      and p_treatment in ('ACCEPTE'::public.return_treatment, 'REFUSE'::public.return_treatment))
    or (v_return.statut_traitement = 'ACCEPTE'::public.return_treatment
      and p_treatment = 'REMBOURSE'::public.return_treatment)
  ) then
    raise exception 'Invalid return treatment transition.';
  end if;

  update public.sales_returns
  set statut_traitement = p_treatment
  where id = v_return.id
  returning * into v_return;
  return v_return;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_organization_settings(p_name text, p_phone text, p_address text, p_city text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
begin
  if v_org is null or public.current_user_role() <> 'ADMIN'::public.user_role
    or not public.is_counter_staff() then
    raise exception 'Only an organization administrator may update settings.';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Organization name is required.';
  end if;

  update public.organizations
  set name = trim(p_name),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      address = nullif(trim(coalesce(p_address, '')), ''),
      city = nullif(trim(coalesce(p_city, '')), '')
  where id = v_org;
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_order_delivered(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_order public.orders;
begin
  if v_org is null or (v_livreur is null and not public.is_counter_staff()) then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_livreur is not null and v_order.livreur_id is distinct from v_livreur then
    raise exception 'This delivery is assigned to another livreur.';
  end if;

  update public.orders
  set workflow_status = 'DELIVERED'::public.orders_workflow_status_enum,
      statut_livreur = 'LIVRÉ'::public.orders_statut_livreur_enum,
      updated_at = now()
  where id = v_order.id;

  update public.delivery_tasks
  set workflow_status = 'DELIVERED'::public.delivery_tasks_workflow_status_enum,
      updated_at = now()
  where order_id = v_order.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.settle_client_return(p_return_id uuid, p_mode text, p_amount numeric, p_reason text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_return public.sales_returns;
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_num text;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_cap numeric;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_mode not in ('REMBOURSEMENT', 'AVOIR') then
    raise exception 'Invalid settlement mode.';
  end if;
  if v_amount <= 0 then
    raise exception 'Amount must be positive.';
  end if;

  select * into v_return
  from public.sales_returns
  where id = p_return_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Return not found.';
  end if;
  if v_return.statut_traitement in ('REMBOURSE', 'AVOIR', 'REFUSE') then
    raise exception 'This return is already settled.';
  end if;
  if v_return.client_id is null then
    raise exception 'This return has no client to refund.';
  end if;

  -- The settlement can never exceed the value that was returned: the return's
  -- own amount, else the originating line, else the whole order.
  v_cap := nullif(v_return.montant, 0);
  if v_cap is null and v_return.order_line_id is not null then
    select l.quantity * l.prix_vente_unitaire into v_cap
    from public.order_lines l where l.id = v_return.order_line_id;
  end if;
  if v_cap is null and v_return.order_id is not null then
    select o.montant_total into v_cap from public.orders o where o.id = v_return.order_id;
  end if;
  if v_cap is not null and v_amount > round(v_cap, 2) then
    raise exception 'Amount exceeds the returned value (max % EUR).', round(v_cap, 2);
  end if;

  if p_mode = 'REMBOURSEMENT' then
    update public.sales_returns
    set statut_traitement = 'REMBOURSE'::public.return_treatment,
        montant = v_amount,
        motif = coalesce(nullif(trim(coalesce(p_reason, '')), ''), motif),
        updated_at = now()
    where id = v_return.id;
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':credits:' || v_year::text));
  select coalesce(max(public.ref_seq(num)), 0) + 1 into v_seq
  from public.credit_notes
  where organization_id = v_org and num like format('AV-%s-%%', v_year);
  v_num := format('AV-%s-%s', v_year, lpad(v_seq::text, 5, '0'));

  insert into public.credit_notes (
    organization_id, client_id, order_id, num, amount, used_amount, statut,
    echeance, motif, designation
  ) values (
    v_org, v_return.client_id, v_return.order_id, v_num, v_amount, 0, 'EN_COURS',
    (current_date + interval '1 year')::date,
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), v_return.motif, 'Retour client'),
    coalesce(v_return.designation, v_return.ref)
  );

  update public.sales_returns
  set statut_traitement = 'AVOIR'::public.return_treatment,
      montant = v_amount,
      motif = coalesce(nullif(trim(coalesce(p_reason, '')), ''), motif),
      updated_at = now()
  where id = v_return.id;

  return v_num;
end;
$function$;

CREATE OR REPLACE FUNCTION public.resolve_garage_quote(p_order_id uuid, p_action text)
 RETURNS TABLE(tour_name text, delivery_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_order public.orders;
  v_line public.order_lines;
  v_total numeric := 0;
  v_local timestamp;
  v_minutes integer;
  v_number integer;
  v_date date;
  v_slot time;
  v_name text;
  v_delivery timestamptz;
  v_tour_id uuid;
begin
  if v_org is null or v_client is null then
    raise exception 'Garage access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_action not in ('ACCEPT', 'REFUSE') then
    raise exception 'Invalid quote action.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and client_id = v_client and devis = true
  for update;
  if not found then
    raise exception 'Quote not found.';
  end if;
  if v_order.devis_status <> 'QUOTED' then
    raise exception 'Only a quoted quote may be accepted or refused.';
  end if;

  if p_action = 'REFUSE' then
    update public.orders set devis_status = 'REFUSED' where id = v_order.id;
    return;
  end if;

  if exists (
    select 1 from public.order_lines l where l.order_id = v_order.id and l.disponible is null
  ) then
    raise exception 'The magasin must answer every requested line first.';
  end if;
  if p_action = 'ACCEPT' and not exists (
    select 1 from public.order_lines l where l.order_id = v_order.id and l.disponible = true
  ) then
    raise exception 'No available line to accept on this quote.';
  end if;
  if not exists (
    select 1 from public.order_lines l where l.order_id = v_order.id and l.disponible = true
  ) then
    raise exception 'No line is available to accept.';
  end if;

  v_local := timezone('Europe/Paris', now());
  v_minutes := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if v_minutes between 571 and 720 then
    v_number := 2; v_slot := time '13:00';
  elsif v_minutes between 721 and 870 then
    v_number := 3; v_slot := time '15:00';
  elsif v_minutes between 871 and 1020 then
    v_number := 4; v_slot := time '17:30';
  else
    v_number := 1; v_slot := time '10:00';
  end if;
  v_date := v_local::date + case when v_number = 1 and v_minutes > 1020 then 1 else 0 end;
  v_name := format('Tournée %s', v_number);
  v_delivery := (v_date + v_slot) at time zone 'Europe/Paris';

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':orders:' || extract(year from v_date)::text));
  select id into v_tour_id from public.delivery_tours
  where organization_id = v_org and name = v_name and tour_date = v_date limit 1;
  if v_tour_id is null then
    insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
    values (v_org, v_name, v_date, v_slot)
    returning id into v_tour_id;
  end if;

  for v_line in select * from public.order_lines where order_id = v_order.id for update loop
    if v_line.disponible then
      v_total := v_total + v_line.quantity * v_line.prix_vente_unitaire;
      -- An available quoted part is reserved from the magasin shelf. It is
      -- immediately ready for the garage and must not re-enter stock later.
      update public.order_lines
      set depuis_magasin = true,
          qte_recue = quantity,
          reception_status = 'RECEIVED',
          received_at = now(),
          tour_id = v_tour_id
      where id = v_line.id;
      update public.stock_items
      set quantity_on_hand = quantity_on_hand - v_line.quantity, updated_at = now()
      where organization_id = v_org
        and sku = v_line.reference
        and quantity_on_hand >= v_line.quantity;
      if not found and exists (
        select 1 from public.stock_items
        where organization_id = v_org and sku = v_line.reference
      ) then
        raise exception 'Insufficient stock for reference %.', v_line.reference;
      end if;
    else
      update public.order_lines
      set reception_status = 'NOT_RECEIVED', tour_id = v_tour_id
      where id = v_line.id;
    end if;
  end loop;

  update public.orders
  set devis = false,
      devis_status = 'ACCEPTED',
      montant_total = v_total,
      montant_paye = 0,
      avance_payee = 0,
      solde_restant = v_total,
      envoyer_au_livreur = true,
      workflow_status = 'TO_COLLECT',
      date_envoi = v_delivery
  where id = v_order.id;

  insert into public.delivery_tasks (organization_id, order_id, workflow_status)
  values (v_org, v_order.id, 'TO_COLLECT');

  return query select v_name, v_delivery;
end;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  target_org uuid;
  target_client uuid;
  target_livreur uuid;
  assigned_role public.user_role;
  display text;
  org_name text;
  new_slug text;
  staff_role text;
begin
  if exists (select 1 from public.profiles p where p.user_id = new.id) then
    return new;
  end if;

  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');
  staff_role := nullif(trim(new.raw_app_meta_data->>'staff_role'), '');

  begin
    target_org := nullif(new.raw_app_meta_data->>'organization_id', '')::uuid;
  exception when others then
    target_org := null;
  end;
  begin
    target_client := nullif(new.raw_app_meta_data->>'client_id', '')::uuid;
  exception when others then
    target_client := null;
  end;
  begin
    target_livreur := nullif(new.raw_app_meta_data->>'livreur_id', '')::uuid;
  exception when others then
    target_livreur := null;
  end;

  if target_org is not null then
    if staff_role in ('CAISSIER', 'ADMIN') then
      assigned_role := staff_role::public.user_role;
      target_client := null;
      target_livreur := null;
    elsif staff_role = 'LIVREUR' and target_livreur is not null and exists (
      select 1 from public.livreurs l
      where l.id = target_livreur and l.organization_id = target_org
    ) then
      assigned_role := 'LIVREUR'::public.user_role;
      target_client := null;
    elsif target_client is not null and exists (
      select 1
      from public.clients c
      where c.id = target_client
        and c.organization_id = target_org
        and c.is_garage = true
    ) then
      assigned_role := 'CAISSIER'::public.user_role;
      target_livreur := null;
    else
      return new;
    end if;
  elsif org_name is not null
    and (tg_op = 'INSERT' or coalesce(new.created_at, now()) > now() - interval '15 minutes') then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
      || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

    insert into public.organizations (name, slug, plan, subscription_status, trial_ends_at)
    values (org_name, new_slug, 'TRIAL', 'trialing', now() + interval '14 days')
    returning id into target_org;
    assigned_role := 'ADMIN'::public.user_role;
    target_livreur := null;
  else
    return new;
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Utilisateur'
  );

  insert into public.profiles (user_id, organization_id, display_name, role, client_id, livreur_id)
  values (new.id, target_org, display, assigned_role, target_client, target_livreur)
  on conflict (user_id) do nothing;

  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- 4. create_order_with_lines (on top of 20260907010000)
-- ---------------------------------------------------------------------
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
  v_mode text;
begin
  if v_org is null or auth.uid() is null then
    raise exception 'Authenticated organization access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if not v_is_garage and not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
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

  -- Payment mode. Garagiste portal orders always go to the garage account.
  v_mode := case when v_is_garage then 'EN_COMPTE'
                 else nullif(upper(trim(p_payload->>'mode_paiement')), '') end;
  if v_mode is not null and v_mode not in ('ESPECES', 'CARTE', 'VIREMENT', 'CHEQUE', 'EN_COMPTE') then
    raise exception 'Unknown payment mode %.', v_mode;
  end if;
  if v_mode = 'EN_COMPTE' and not v_is_garage then
    if v_order_client is null or not exists (
      select 1 from public.clients c
      where c.id = v_order_client and c.organization_id = v_org and c.is_garage
    ) then
      raise exception 'Le paiement en compte est réservé aux garages.';
    end if;
    -- Nothing is cashed now: the whole amount is carried by the account.
    v_paid := 0;
    v_advance := 0;
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
    statut_livreur, consigne, workflow_status, bl, date_bl, mode_paiement, is_restock
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
    coalesce((p_payload->>'bl')::boolean, false), nullif(p_payload->>'date_bl', '')::date,
    v_mode,
    case when v_is_garage then false else coalesce((p_payload->>'is_restock')::boolean, false) end
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

-- ---------------------------------------------------------------------
-- 5. respond_garage_quote: atomic per-line answer
-- ---------------------------------------------------------------------
create or replace function public.respond_garage_quote(p_order_id uuid, p_responses jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_r jsonb;
  v_line_id uuid;
  v_disp boolean;
  v_price numeric;
  v_count integer := 0;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if jsonb_typeof(p_responses) <> 'array' or jsonb_array_length(p_responses) = 0 then
    raise exception 'At least one line response is required.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and devis = true
  for update;
  if not found then
    raise exception 'Quote not found.';
  end if;
  if coalesce(v_order.devis_status, 'REQUESTED') not in ('REQUESTED', 'QUOTED') then
    raise exception 'This quote is already resolved.';
  end if;

  for v_r in select value from jsonb_array_elements(p_responses) loop
    begin
      v_line_id := (v_r->>'line_id')::uuid;
    exception when others then
      raise exception 'Invalid line id.';
    end;
    v_disp := coalesce((v_r->>'disponible')::boolean, false);
    v_price := case when v_disp then greatest(coalesce((v_r->>'unit_price')::numeric, 0), 0) else 0 end;
    update public.order_lines
    set disponible = v_disp, prix_vente_unitaire = v_price
    where id = v_line_id and order_id = v_order.id and organization_id = v_org;
    if found then
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count = 0 then
    raise exception 'No matching quote line.';
  end if;

  update public.orders
  set devis_status = 'QUOTED', updated_at = now()
  where id = v_order.id;
end;
$$;
revoke execute on function public.respond_garage_quote(uuid, jsonb) from public, anon;
grant execute on function public.respond_garage_quote(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Column-level grants: RPC-only writes on the financial tables
-- ---------------------------------------------------------------------
revoke insert, update, delete on public.orders from anon, authenticated;
grant update (client_phone, client_email, immatriculation, vehicle_model, kilometrage, consigne, updated_at)
  on public.orders to authenticated;

revoke insert, update, delete on public.order_lines from anon, authenticated;
grant update (retour_stock_fait, reference_commande) on public.order_lines to authenticated;

revoke delete on public.clients from anon, authenticated;
revoke insert, update, delete on public.stock_items from anon, authenticated;
revoke insert, update, delete on public.credit_notes from anon, authenticated;
revoke insert, update, delete on public.sales_returns from anon, authenticated;
revoke insert, update, delete on public.consignment_entries from anon, authenticated;
revoke insert, update, delete on public.profiles from anon, authenticated;
revoke insert, update, delete on public.loyalty_transactions from anon, authenticated;

-- ---------------------------------------------------------------------
-- 7. Garagiste reads: no purchase price, no supplier; organizations staff-only
-- ---------------------------------------------------------------------
drop policy if exists order_lines_select on public.order_lines;
create policy order_lines_select on public.order_lines for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and (
      public.is_counter_staff()
      or (
        public.current_user_livreur_id() is not null
        and exists (
          select 1 from public.orders o
          where o.id = order_lines.order_id
            and o.organization_id = public.current_user_org_id()
            and o.livreur_id = public.current_user_livreur_id()
        )
      )
    )
  );

create or replace view public.garage_order_lines as
select
  l.id, l.organization_id, l.order_id, l.reference, l.nom_produit, l.quantity,
  l.reception_status, l.disponible, l.retour_impossible, l.prix_vente_unitaire,
  l.consigne, l.consigne_price, l.qte_remise
from public.order_lines l
join public.orders o on o.id = l.order_id
where public.current_user_client_id() is not null
  and l.organization_id = public.current_user_org_id()
  and o.client_id = public.current_user_client_id()
  and public.has_operational_access(l.organization_id);
revoke all on public.garage_order_lines from public, anon;
grant select on public.garage_order_lines to authenticated;

drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations for select
  using (id = public.current_user_org_id() and public.is_counter_staff());

-- ---------------------------------------------------------------------
-- 8. Audit log
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  organization_id uuid,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_org_created_idx on public.audit_log (organization_id, created_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (organization_id, entity, entity_id);
alter table public.audit_log enable row level security;
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select
  using (
    organization_id = public.current_user_org_id()
    and public.is_counter_staff()
    and public.current_user_role() = 'ADMIN'::public.user_role
  );
revoke all on public.audit_log from public, anon, authenticated;
grant select on public.audit_log to authenticated;

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before jsonb;
  v_after jsonb;
  v_diff jsonb;
  v_org uuid;
  v_id text;
begin
  if tg_op = 'INSERT' then
    v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
    select jsonb_object_agg(a.key, a.value) into v_diff
    from jsonb_each(v_after) a
    where a.key not in ('updated_at', 'updatedAt')
      and v_before -> a.key is distinct from a.value;
    if v_diff is null then
      return null;
    end if;
    -- keep only the changed keys on both sides
    select jsonb_object_agg(b.key, b.value) into v_before
    from jsonb_each(v_before) b where v_diff ? b.key;
    v_after := v_diff;
  else
    v_before := to_jsonb(old);
  end if;

  begin
    v_org := coalesce(v_after->>'organization_id', v_before->>'organization_id')::uuid;
  exception when others then
    v_org := null;
  end;
  v_id := coalesce(v_after->>'id', v_before->>'id', v_after->>'user_id', v_before->>'user_id');

  insert into public.audit_log (organization_id, actor_id, action, entity, entity_id, before, after)
  values (v_org, auth.uid(), tg_op, tg_table_name, v_id, v_before, v_after);
  return null;
end;
$$;
revoke execute on function public.audit_row() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['orders','order_lines','credit_notes','sales_returns','consignment_entries','stock_items','clients','profiles','organizations','loyalty_transactions'] loop
    execute format('drop trigger if exists audit_%s on public.%I', t, t);
    execute format('create trigger audit_%s after insert or update or delete on public.%I for each row execute function public.audit_row()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 9. Platform owners (SaaS superadmin bound to a user id)
-- ---------------------------------------------------------------------
create table if not exists public.platform_owners (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);
alter table public.platform_owners enable row level security;
revoke all on public.platform_owners from public, anon, authenticated;
insert into public.platform_owners (user_id, email)
select u.id, u.email from auth.users u where lower(u.email) = 'admin@autodecision.fr'
on conflict (user_id) do nothing;

create or replace function public.find_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select u.id from auth.users u where lower(u.email) = lower(trim(p_email)) limit 1;
$$;
revoke execute on function public.find_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.find_user_id_by_email(text) to service_role;

-- SMS relay accountability
alter table public.sms_notifications add column if not exists sent_by uuid;
create index if not exists sms_notifications_org_created_idx on public.sms_notifications (organization_id, created_at desc);

-- ---------------------------------------------------------------------
-- 10. next_ref_demande: security definer cross-tenant oracle
-- ---------------------------------------------------------------------
revoke execute on function public.next_ref_demande(uuid) from public, anon, authenticated;

-- seat_limit is now enforced by /api/team: never lock an organization out of
-- the staff it already has.
update public.organizations o
set seat_limit = greatest(
  coalesce(o.seat_limit, 0),
  (select count(*) from public.profiles p
   where p.organization_id = o.id and p.client_id is null and p.livreur_id is null)
);

notify pgrst, 'reload schema';
