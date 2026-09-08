-- Stock (audit 2026-09-07, chantier 8).
--
--  * stock_items: seuil de réappro (min_qty), emplacement, prix moyen pondéré
--    (cost_price, mis à jour à la réception), fournisseur habituel.
--  * stock_movements: journal de chaque variation (qui, quand, pourquoi,
--    quelle commande) écrit par trigger — la quantité n'est plus mutée en
--    silence à quatre endroits.
--  * Les retours client (comptoir et garage) remettent la pièce en stock
--    dès qu'ils sont réglés (remboursement ou avoir), sauf retour fournisseur.
--  * adjust_stock_item(sku, name, delta, reason, note), set_stock_quantity
--    (inventaire) et update_stock_item (seuil / emplacement / PMP).
--  * Alerte STAFF « stock bas » quand une référence passe sous son seuil.

alter table public.stock_items
  add column if not exists min_qty integer not null default 0,
  add column if not exists location text,
  add column if not exists cost_price numeric(14,2),
  add column if not exists supplier_id uuid references public.suppliers (id) on delete set null;
alter table public.stock_items drop constraint if exists stock_items_min_qty_check;
alter table public.stock_items add constraint stock_items_min_qty_check check (min_qty >= 0);

create table if not exists public.stock_movements (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  stock_item_id uuid references public.stock_items (id) on delete set null,
  sku text not null,
  delta integer not null,
  quantity_after integer not null,
  reason text not null,
  ref text,
  order_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists stock_movements_org_created_idx on public.stock_movements (organization_id, created_at desc);
create index if not exists stock_movements_sku_idx on public.stock_movements (organization_id, sku, created_at desc);
alter table public.stock_movements enable row level security;
drop policy if exists stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements for select
  using (organization_id = public.current_user_org_id() and public.has_operational_access(organization_id) and public.is_counter_staff());
revoke all on public.stock_movements from public, anon, authenticated;
grant select on public.stock_movements to authenticated;

create or replace function public.stock_items_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delta integer := new.quantity_on_hand - coalesce(old.quantity_on_hand, 0);
  v_reason text := coalesce(nullif(current_setting('app.stock_reason', true), ''), 'AJUSTEMENT');
  v_ref text := nullif(current_setting('app.stock_ref', true), '');
  v_order uuid;
begin
  if tg_op = 'UPDATE' and v_delta = 0 then
    return null;
  end if;
  begin
    v_order := nullif(current_setting('app.stock_order_id', true), '')::uuid;
  exception when others then
    v_order := null;
  end;
  insert into public.stock_movements (organization_id, stock_item_id, sku, delta, quantity_after, reason, ref, order_id, note, created_by)
  values (new.organization_id, new.id, new.sku, v_delta, new.quantity_on_hand, v_reason, v_ref, v_order,
          nullif(current_setting('app.stock_note', true), ''), auth.uid());
  -- Sous le seuil : une alerte par référence et par semaine.
  if new.min_qty > 0 and new.quantity_on_hand <= new.min_qty
     and (tg_op = 'INSERT' or old.quantity_on_hand > old.min_qty or old.min_qty <> new.min_qty) then
    perform public.notify(new.organization_id, 'STAFF', 'LOW_STOCK',
      format('Stock bas : %s', new.sku), format('%s — %s en stock (seuil %s).', coalesce(new.name, new.sku), new.quantity_on_hand, new.min_qty),
      '/dashboard/stock', 'stock_items', new.id, null, null,
      'LOW_STOCK:' || new.id::text || ':' || to_char(timezone('Europe/Paris', now())::date, 'IYYY-IW'));
  end if;
  return null;
end;
$$;
drop trigger if exists stock_items_log on public.stock_items;
create trigger stock_items_log after insert or update of quantity_on_hand, min_qty on public.stock_items
  for each row execute function public.stock_items_log();

/* Put a returned line back on the shelf, once. */
create or replace function public.restock_returned_line(p_line_id uuid, p_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.order_lines;
begin
  select * into v_line from public.order_lines where id = p_line_id for update;
  if not found or v_line.retour_stock_fait then
    return;
  end if;
  perform set_config('app.stock_reason', 'RETOUR_CLIENT', true);
  perform set_config('app.stock_ref', coalesce(p_ref, ''), true);
  perform set_config('app.stock_order_id', v_line.order_id::text, true);
  insert into public.stock_items (organization_id, sku, name, quantity_on_hand, cost_price)
  values (v_line.organization_id, v_line.reference, v_line.nom_produit, v_line.quantity, nullif(v_line.prix_achat_unitaire, 0))
  on conflict (organization_id, sku) do update
    set quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
        name = coalesce(public.stock_items.name, excluded.name),
        updated_at = now();
  update public.order_lines set retour_stock_fait = true where id = v_line.id;
end;
$$;
revoke execute on function public.restock_returned_line(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Adjust / inventory / metadata
-- ---------------------------------------------------------------------
drop function if exists public.adjust_stock_item(text, text, integer);
create or replace function public.adjust_stock_item(
  p_sku text, p_name text, p_delta integer, p_reason text default 'AJUSTEMENT', p_note text default null
)
returns public.stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_result public.stock_items;
  v_sku text := nullif(trim(p_sku), '');
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if v_sku is null then
    raise exception 'SKU is required.';
  end if;
  if p_reason not in ('AJUSTEMENT', 'INVENTAIRE', 'CASSE', 'RETOUR_CLIENT', 'RECEPTION') then
    raise exception 'Invalid stock reason.';
  end if;
  perform set_config('app.stock_reason', p_reason, true);
  perform set_config('app.stock_ref', '', true);
  perform set_config('app.stock_order_id', '', true);
  perform set_config('app.stock_note', coalesce(p_note, ''), true);

  insert into public.stock_items (organization_id, sku, name, quantity_on_hand)
  values (v_org, v_sku, coalesce(nullif(trim(p_name), ''), v_sku), greatest(coalesce(p_delta, 0), 0))
  on conflict (organization_id, sku) do update
    set quantity_on_hand = greatest(0, public.stock_items.quantity_on_hand + coalesce(p_delta, 0)),
        name = coalesce(nullif(trim(p_name), ''), public.stock_items.name),
        updated_at = now()
  returning * into v_result;
  return v_result;
end;
$$;
revoke execute on function public.adjust_stock_item(text, text, integer, text, text) from public, anon;
grant execute on function public.adjust_stock_item(text, text, integer, text, text) to authenticated;

create or replace function public.set_stock_quantity(p_sku text, p_quantity integer, p_reason text default 'INVENTAIRE', p_note text default null)
returns public.stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_result public.stock_items;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if p_quantity is null or p_quantity < 0 then
    raise exception 'Quantity must be zero or positive.';
  end if;
  perform set_config('app.stock_reason', coalesce(p_reason, 'INVENTAIRE'), true);
  perform set_config('app.stock_ref', '', true);
  perform set_config('app.stock_order_id', '', true);
  perform set_config('app.stock_note', coalesce(p_note, ''), true);
  update public.stock_items
  set quantity_on_hand = p_quantity, updated_at = now()
  where organization_id = v_org and sku = trim(p_sku)
  returning * into v_result;
  if not found then
    raise exception 'Stock item not found.';
  end if;
  return v_result;
end;
$$;
revoke execute on function public.set_stock_quantity(text, integer, text, text) from public, anon;
grant execute on function public.set_stock_quantity(text, integer, text, text) to authenticated;

create or replace function public.update_stock_item(
  p_sku text, p_min_qty integer default null, p_location text default null,
  p_cost_price numeric default null, p_supplier_id uuid default null, p_name text default null
)
returns public.stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_result public.stock_items;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if p_supplier_id is not null and not exists (select 1 from public.suppliers s where s.id = p_supplier_id and s.organization_id = v_org) then
    raise exception 'Supplier does not belong to this organization.';
  end if;
  update public.stock_items
  set min_qty = coalesce(p_min_qty, min_qty),
      location = case when p_location is null then location else nullif(trim(p_location), '') end,
      cost_price = coalesce(p_cost_price, cost_price),
      supplier_id = coalesce(p_supplier_id, supplier_id),
      name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
      updated_at = now()
  where organization_id = v_org and sku = trim(p_sku)
  returning * into v_result;
  if not found then
    raise exception 'Stock item not found.';
  end if;
  return v_result;
end;
$$;
revoke execute on function public.update_stock_item(text, integer, text, numeric, uuid, text) from public, anon;
grant execute on function public.update_stock_item(text, integer, text, numeric, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- RPCs that move stock now tag the movement (and returns restock)
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
  perform set_config('app.stock_reason', 'VENTE', true);
  perform set_config('app.stock_ref', v_ref, true);
  perform set_config('app.stock_order_id', v_order_id::text, true);

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
    perform set_config('app.stock_reason', 'RECEPTION', true);
    perform set_config('app.stock_ref', (select o.ref_demande from public.orders o where o.id = v_line.order_id), true);
    perform set_config('app.stock_order_id', v_line.order_id::text, true);
    insert into public.stock_items (organization_id, sku, name, quantity_on_hand, cost_price)
    values (v_org, v_line.reference, v_line.nom_produit, v_qty, nullif(v_line.prix_achat_unitaire, 0))
    on conflict (organization_id, sku) do update
      set quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
          name = coalesce(public.stock_items.name, excluded.name),
          -- prix moyen pondéré
          cost_price = case
            when excluded.cost_price is null then public.stock_items.cost_price
            when public.stock_items.cost_price is null or public.stock_items.quantity_on_hand <= 0 then excluded.cost_price
            else round((public.stock_items.cost_price * public.stock_items.quantity_on_hand + excluded.cost_price * excluded.quantity_on_hand)
                       / (public.stock_items.quantity_on_hand + excluded.quantity_on_hand), 2) end,
          supplier_id = coalesce(public.stock_items.supplier_id, v_line.supplier_id),
          updated_at = now();
  end if;

  return v_result;
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
      perform set_config('app.stock_reason', 'DEVIS_ACCEPTE', true);
      perform set_config('app.stock_ref', v_order.ref_demande, true);
      perform set_config('app.stock_order_id', v_order.id::text, true);
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
    if p_compensation <> 'FOURNISSEUR' then
      perform public.restock_returned_line(v_line.id, v_order.ref_demande);
    end if;
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

CREATE OR REPLACE FUNCTION public.settle_client_return(p_return_id uuid, p_mode text, p_amount numeric, p_reason text DEFAULT NULL::text, p_refund_mode text DEFAULT 'ESPECES'::text)
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
    if p_refund_mode not in ('ESPECES', 'CARTE', 'VIREMENT', 'CHEQUE') then
      raise exception 'Invalid refund mode.';
    end if;
    update public.sales_returns
    set statut_traitement = 'REMBOURSE'::public.return_treatment,
        montant = v_amount,
        motif = coalesce(nullif(trim(coalesce(p_reason, '')), ''), motif),
        updated_at = now()
    where id = v_return.id;
    if v_return.order_line_id is not null then
      perform public.restock_returned_line(v_return.order_line_id, v_return.ref);
    end if;
    -- Money leaves the till: recorded as a refund in the cash journal.
    insert into public.payments (
      organization_id, client_id, order_id, return_id, session_id, kind, mode, amount,
      note, received_by
    ) values (
      v_org, v_return.client_id, v_return.order_id, v_return.id, public.current_cash_session(v_org),
      'REMBOURSEMENT', p_refund_mode, v_amount,
      coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Remboursement retour ' || coalesce(v_return.ref, '')),
      auth.uid()
    );
    return null;
  end if;

  if v_return.order_line_id is not null then
    perform public.restock_returned_line(v_return.order_line_id, v_return.ref);
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

notify pgrst, 'reload schema';
