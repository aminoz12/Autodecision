-- Comptoir (audit 2026-09-07, chantier 10).
--
--  * Remises : par ligne (remise_pct, prix brut conservé) et en pied de
--    commande (orders.remise_montant). Le prix net est calculé côté base ;
--    la facture reprend la remise (ligne négative « Remise commerciale »).
--  * Devis particulier : la table quotes reçoit client, total, statut et
--    validité ; create_quote numérote DEV-AAAA-NNNNN ; la commande créée
--    depuis un devis (quote_id) le passe en ACCEPTE.
--  * Annulation : cancel_order remet le stock, rembourse ce qui a été
--    encaissé (journal de caisse), libère l'avoir appliqué, retire la
--    livraison et marque la commande (cancelled_at). Une commande facturée
--    ou livrée ne s'annule pas (avoir / retour).
--  * Réception partielle : receive_order_line(p_line_id, p_qty) ;
--    nouveau statut reception_status PARTIAL.

alter table public.order_lines
  add column if not exists prix_brut_unitaire numeric(14,2),
  add column if not exists remise_pct numeric(5,2) not null default 0;
alter table public.order_lines drop constraint if exists order_lines_remise_pct_check;
alter table public.order_lines add constraint order_lines_remise_pct_check check (remise_pct >= 0 and remise_pct <= 100);

alter table public.orders
  add column if not exists remise_montant numeric(14,2) not null default 0,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users (id) on delete set null,
  add column if not exists cancel_reason text;
alter table public.orders drop constraint if exists orders_remise_montant_check;
alter table public.orders add constraint orders_remise_montant_check check (remise_montant >= 0);
create index if not exists orders_org_cancelled_idx on public.orders (organization_id, cancelled_at);

alter type public.reception_status add value if not exists 'PARTIAL';

alter table public.quotes
  add column if not exists client_id uuid references public.clients (id) on delete set null,
  add column if not exists client_name text,
  add column if not exists total numeric(14,2) not null default 0,
  add column if not exists status text not null default 'EN_ATTENTE',
  add column if not exists valid_until date,
  add column if not exists note text;
alter table public.quotes drop constraint if exists quotes_status_check;
alter table public.quotes add constraint quotes_status_check check (status in ('EN_ATTENTE', 'ACCEPTE', 'REFUSE', 'EXPIRE'));
create index if not exists quotes_org_status_idx on public.quotes (organization_id, status, "createdAt" desc);

-- ---------------------------------------------------------------------
-- Devis particulier
-- ---------------------------------------------------------------------
create or replace function public.create_quote(p_payload jsonb)
returns table (id uuid, ref text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid;
  v_client_name text;
  v_line jsonb;
  v_qty integer;
  v_sale numeric;
  v_gross numeric;
  v_pct numeric;
  v_consigne numeric;
  v_parts numeric := 0;
  v_total numeric := 0;
  v_discount numeric;
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_ref text;
  v_id uuid;
  v_days integer := greatest(1, coalesce((p_payload->>'validity_days')::integer, 30));
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if jsonb_typeof(p_payload->'lines') <> 'array' or jsonb_array_length(p_payload->'lines') = 0 then
    raise exception 'At least one quote line is required.';
  end if;

  begin
    v_client := nullif(p_payload->>'client_id', '')::uuid;
  exception when others then
    v_client := null;
  end;
  if v_client is not null then
    select c.name into v_client_name from public.clients c where c.id = v_client and c.organization_id = v_org;
    if not found then
      raise exception 'Client does not belong to this organization.';
    end if;
  end if;
  v_client_name := coalesce(nullif(trim(p_payload->>'client_name'), ''), v_client_name, 'Client comptoir');

  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    if nullif(trim(v_line->>'nom_produit'), '') is null or nullif(trim(v_line->>'reference'), '') is null then
      raise exception 'Each line needs a designation and a reference.';
    end if;
    v_qty := coalesce((v_line->>'quantity')::integer, 0);
    if v_qty <= 0 then
      raise exception 'Line quantity must be positive.';
    end if;
    v_sale := greatest(coalesce((v_line->>'prix_vente_unitaire')::numeric, 0), 0);
    v_pct := least(100, greatest(0, round(coalesce((v_line->>'remise_pct')::numeric, 0), 2)));
    v_gross := greatest(coalesce((v_line->>'prix_brut_unitaire')::numeric, v_sale), 0);
    if v_pct > 0 then
      v_sale := round(v_gross * (1 - v_pct / 100), 2);
    end if;
    v_consigne := case when coalesce((v_line->>'consigne')::boolean, false)
      then greatest(coalesce((v_line->>'consigne_price')::numeric, 0), 0) else 0 end;
    v_parts := v_parts + v_qty * v_sale;
    v_total := v_total + v_qty * (v_sale + v_consigne);
  end loop;
  v_discount := round(greatest(coalesce((p_payload->>'remise_montant')::numeric, 0), 0), 2);
  if v_discount > v_parts then
    raise exception 'La remise (% €) dépasse le montant des pièces (% €).', v_discount, round(v_parts, 2);
  end if;
  v_total := round(v_total - v_discount, 2);

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':quotes:' || v_year::text));
  select coalesce(max(public.ref_seq(q.ref)), 0) + 1 into v_seq
  from public.quotes q
  where q.organization_id = v_org and q.ref like format('DEV-%s-%%', v_year);
  v_ref := format('DEV-%s-%s', v_year, lpad(v_seq::text, 5, '0'));

  insert into public.quotes (organization_id, ref, created_by_id, payload, client_id, client_name, total, status, valid_until, note)
  values (v_org, v_ref, auth.uid(), p_payload - 'quote_id', v_client, v_client_name, v_total, 'EN_ATTENTE',
          current_date + v_days, nullif(trim(coalesce(p_payload->>'note', '')), ''))
  returning quotes.id into v_id;

  return query select v_id, v_ref;
end;
$$;
revoke execute on function public.create_quote(jsonb) from public, anon;
grant execute on function public.create_quote(jsonb) to authenticated;

create or replace function public.set_quote_status(p_quote_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_quote public.quotes;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if p_status not in ('EN_ATTENTE', 'REFUSE') then
    raise exception 'Un devis passe en ACCEPTE uniquement par sa transformation en commande.';
  end if;
  select * into v_quote from public.quotes where id = p_quote_id and organization_id = v_org for update;
  if not found then
    raise exception 'Quote not found.';
  end if;
  if v_quote.converted_order_id is not null or v_quote.status = 'ACCEPTE' then
    raise exception 'Ce devis a déjà été transformé en commande.';
  end if;
  update public.quotes set status = p_status, updated_at = now() where id = v_quote.id;
end;
$$;
revoke execute on function public.set_quote_status(uuid, text) from public, anon;
grant execute on function public.set_quote_status(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Annulation de commande
-- ---------------------------------------------------------------------
create or replace function public.cancel_order(p_order_id uuid, p_reason text, p_refund_mode text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_paid numeric;
  v_l record;
  v_qty integer;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if v_reason is null then
    raise exception 'Un motif d''annulation est requis.';
  end if;

  select * into v_order from public.orders
  where id = p_order_id and organization_id = v_org for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'Cette commande est déjà annulée.';
  end if;
  if v_order.workflow_status = 'DELIVERED' then
    raise exception 'Commande livrée : passez par un retour client.';
  end if;
  if exists (select 1 from public.invoices i where i.order_id = v_order.id and i.kind = 'FACTURE') then
    raise exception 'Une facture a été émise : établissez un avoir plutôt qu''une annulation.';
  end if;
  if exists (select 1 from public.order_lines l where l.order_id = v_order.id and l.qte_remise > 0) then
    raise exception 'Des pièces ont déjà été remises au client : passez par un retour.';
  end if;
  if exists (select 1 from public.sales_returns r where r.order_id = v_order.id) then
    raise exception 'Un retour existe déjà sur cette commande.';
  end if;

  -- Money already cashed goes back to the client, through the cash journal.
  v_paid := round(coalesce(v_order.montant_paye, 0) + coalesce(v_order.avance_payee, 0), 2);
  if v_paid > 0 then
    if p_refund_mode is null or p_refund_mode not in ('ESPECES', 'CARTE', 'VIREMENT', 'CHEQUE') then
      raise exception 'Le client a réglé % € : choisissez un mode de remboursement.', v_paid;
    end if;
    insert into public.payments (organization_id, client_id, order_id, session_id, kind, mode, amount, note, received_by)
    values (v_org, v_order.client_id, v_order.id, public.current_cash_session(v_org),
            'REMBOURSEMENT', p_refund_mode, v_paid,
            format('Annulation %s — %s', v_order.ref_demande, v_reason), auth.uid());
  end if;

  -- A credit note used as payment becomes available again.
  if coalesce(v_order.avoir_applique, 0) > 0 and v_order.avoir_id is not null then
    update public.credit_notes
    set used_amount = greatest(0, used_amount - v_order.avoir_applique),
        statut = case when greatest(0, used_amount - v_order.avoir_applique) = 0
                      then 'EN_COURS'::public.credit_status else 'PARTIEL'::public.credit_status end,
        updated_at = now()
    where id = v_order.avoir_id and organization_id = v_org;
  end if;

  -- Parts go back on the shelf: shelf sales taken at creation, and supplier
  -- parts already received for this client (now unassigned).
  perform set_config('app.stock_reason', 'ANNULATION', true);
  perform set_config('app.stock_ref', v_order.ref_demande, true);
  perform set_config('app.stock_order_id', v_order.id::text, true);
  perform set_config('app.stock_note', v_reason, true);
  for v_l in select * from public.order_lines l where l.order_id = v_order.id and l.organization_id = v_org loop
    if v_l.depuis_magasin and v_l.supplier_id is null then
      update public.stock_items
      set quantity_on_hand = quantity_on_hand + v_l.quantity, updated_at = now()
      where organization_id = v_org and sku = v_l.reference;
    elsif not v_l.depuis_magasin and coalesce(v_l.qte_recue, 0) > 0 then
      v_qty := v_l.qte_recue;
      insert into public.stock_items (organization_id, sku, name, quantity_on_hand, cost_price, supplier_id)
      values (v_org, v_l.reference, v_l.nom_produit, v_qty, nullif(v_l.prix_achat_unitaire, 0), v_l.supplier_id)
      on conflict (organization_id, sku) do update
        set quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
            name = coalesce(public.stock_items.name, excluded.name),
            cost_price = coalesce(public.stock_items.cost_price, excluded.cost_price),
            updated_at = now();
    end if;
  end loop;

  -- Deposits never took effect; the delivery is withdrawn.
  delete from public.consignment_entries where order_id = v_order.id and organization_id = v_org and status = 'ACTIF';
  delete from public.delivery_tasks where order_id = v_order.id and organization_id = v_org;

  update public.orders
  set cancelled_at = now(),
      cancelled_by = auth.uid(),
      cancel_reason = v_reason,
      montant_paye = 0,
      avance_payee = 0,
      solde_restant = 0,
      statut_paiement = 'NON_PAYÉ'::public.orders_statut_paiement_enum,
      envoyer_au_livreur = false,
      livreur_id = null,
      statut_livreur = 'EN_ATTENTE'::public.orders_statut_livreur_enum,
      updated_at = now()
  where id = v_order.id;

  if v_order.client_id is not null then
    perform public.notify(v_org, 'CLIENT', 'ORDER_CANCELLED',
      format('Commande %s annulée', v_order.ref_demande), v_reason,
      '/garagiste/dashboard', 'orders', v_order.id, v_order.client_id);
  end if;
end;
$$;
revoke execute on function public.cancel_order(uuid, text, text) from public, anon;
grant execute on function public.cancel_order(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Réception partielle
-- ---------------------------------------------------------------------
drop function if exists public.receive_order_line(uuid);
CREATE OR REPLACE FUNCTION public.receive_order_line(p_line_id uuid, p_qty integer default null)
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
  -- Partial reception: p_qty units now, the rest stays expected.
  if p_qty is not null then
    if p_qty <= 0 or p_qty > v_qty then
      raise exception 'Quantité reçue invalide : il reste % pièce(s) à recevoir.', v_qty;
    end if;
    v_qty := p_qty;
  end if;
  update public.order_lines
  set qte_recue = qte_recue + v_qty,
      reception_status = case when qte_recue + v_qty >= quantity
                              then 'RECEIVED'::public.reception_status
                              else 'PARTIAL'::public.reception_status end,
      received_at = now(),
      retour_stock_fait = case when v_line.depuis_magasin and v_line.qte_recue + v_qty >= v_line.quantity
                               then true else retour_stock_fait end
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

revoke execute on function public.receive_order_line(uuid, integer) from public, anon;
grant execute on function public.receive_order_line(uuid, integer) to authenticated;

-- ---------------------------------------------------------------------
-- Commande + facture : remises et devis
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
  v_gross numeric;
  v_pct numeric;
  v_parts numeric := 0;
  v_discount numeric := 0;
  v_quote uuid;
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
    -- Line discount: the net unit price is derived server-side from the gross price.
    v_pct := least(100, greatest(0, round(coalesce((v_line->>'remise_pct')::numeric, 0), 2)));
    v_gross := greatest(coalesce((v_line->>'prix_brut_unitaire')::numeric, v_sale), 0);
    if v_pct > 0 then
      v_sale := round(v_gross * (1 - v_pct / 100), 2);
    end if;
    v_consigne := case when coalesce((v_line->>'consigne')::boolean, false)
      then greatest(coalesce((v_line->>'consigne_price')::numeric, 0), 0)
      else 0 end;
    if not v_is_garage then
      v_parts := v_parts + v_qty * v_sale;
      v_total := v_total + v_qty * (v_sale + v_consigne);
    end if;
  end loop;

  -- Order-level discount (remise en pied), capped by the parts subtotal.
  v_discount := case when v_is_garage then 0
                     else round(greatest(coalesce((p_payload->>'remise_montant')::numeric, 0), 0), 2) end;
  if v_discount > v_parts then
    raise exception 'La remise (% €) dépasse le montant des pièces (% €).', v_discount, round(v_parts, 2);
  end if;
  v_total := round(v_total - v_discount, 2);

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
    statut_livreur, consigne, workflow_status, bl, date_bl, mode_paiement, is_restock, remise_montant
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
    case when v_is_garage then false else coalesce((p_payload->>'is_restock')::boolean, false) end,
    v_discount
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
    v_pct := case when v_is_garage then 0 else least(100, greatest(0, round(coalesce((v_line->>'remise_pct')::numeric, 0), 2))) end;
    v_gross := greatest(coalesce((v_line->>'prix_brut_unitaire')::numeric, v_sale), 0);
    if v_pct > 0 then
      v_sale := round(v_gross * (1 - v_pct / 100), 2);
    end if;
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
      reception_status, received_at, prix_brut_unitaire, remise_pct
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
      case when v_from_stock and v_supplier is null then now() else null end,
      v_gross, v_pct
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

  -- Order created from a walk-in quote: close the quote.
  if not v_is_garage then
    begin
      v_quote := nullif(p_payload->>'quote_id', '')::uuid;
    exception when others then
      v_quote := null;
    end;
    if v_quote is not null then
      update public.quotes
      set converted_order_id = v_order_id, status = 'ACCEPTE', updated_at = now()
      where id = v_quote and organization_id = v_org and converted_order_id is null;
    end if;
  end if;

  return query select v_order_id, v_ref, v_tour_name, v_delivery_at;
end;
$$;

create or replace function public.emit_invoice(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_org_row public.organizations;
  v_client public.clients;
  v_existing uuid;
  v_lines jsonb := '[]'::jsonb;
  v_l record;
  v_rate numeric;
  v_unit_ttc numeric;
  v_total_ttc numeric;
  v_total_ht numeric;
  v_ht numeric := 0;
  v_tva numeric := 0;
  v_ttc numeric := 0;
  v_by_rate jsonb := '{}'::jsonb;
  v_rate_key text;
  v_totals jsonb;
  v_buyer jsonb;
  v_number text;
  v_issued timestamptz := now();
  v_prev text;
  v_id uuid;
  v_terms text;
  v_due date;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);

  select * into v_order from public.orders
  where id = p_order_id and organization_id = v_org for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.devis or v_order.is_restock then
    raise exception 'Only a confirmed client order can be invoiced.';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'Cette commande est annulée : elle ne peut pas être facturée.';
  end if;
  select id into v_existing from public.invoices where order_id = v_order.id and kind = 'FACTURE';
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_org_row from public.organizations where id = v_org;
  if v_order.client_id is not null then
    select * into v_client from public.clients where id = v_order.client_id;
  end if;

  for v_l in
    select l.* from public.order_lines l
    where l.order_id = v_order.id and l.organization_id = v_org
      and l.reception_status <> 'NOT_RECEIVED'
    order by l.id
  loop
    v_rate := coalesce(v_l.tva_rate, v_org_row.tva_rate, 20);
    v_unit_ttc := round(v_l.prix_vente_unitaire, 2);
    v_total_ttc := round(v_l.quantity * v_unit_ttc, 2);
    v_total_ht := round(v_total_ttc / (1 + v_rate / 100), 2);
    v_lines := v_lines || jsonb_build_object(
      'reference', v_l.reference, 'designation', v_l.nom_produit, 'quantity', v_l.quantity,
      'unit_ttc', v_unit_ttc, 'unit_ht', round(v_unit_ttc / (1 + v_rate / 100), 2),
      'tva_rate', v_rate, 'total_ht', v_total_ht, 'total_tva', round(v_total_ttc - v_total_ht, 2), 'total_ttc', v_total_ttc,
      'remise_pct', coalesce(v_l.remise_pct, 0), 'unit_brut_ttc', round(coalesce(v_l.prix_brut_unitaire, v_l.prix_vente_unitaire), 2)
    );
    v_ht := v_ht + v_total_ht;
    v_tva := v_tva + (v_total_ttc - v_total_ht);
    v_ttc := v_ttc + v_total_ttc;
    v_rate_key := trim(trailing '.' from trim(trailing '0' from v_rate::text));
    v_by_rate := jsonb_set(
      v_by_rate, array[v_rate_key],
      jsonb_build_object(
        'ht', round(coalesce((v_by_rate #>> array[v_rate_key, 'ht'])::numeric, 0) + v_total_ht, 2),
        'tva', round(coalesce((v_by_rate #>> array[v_rate_key, 'tva'])::numeric, 0) + (v_total_ttc - v_total_ht), 2)
      ), true);

    -- Consigne (deposit): separate line, outside the VAT base.
    if v_l.consigne and coalesce(v_l.consigne_price, 0) > 0 then
      v_total_ttc := round(v_l.quantity * v_l.consigne_price, 2);
      v_lines := v_lines || jsonb_build_object(
        'reference', v_l.reference, 'designation', 'Consigne — ' || v_l.nom_produit, 'quantity', v_l.quantity,
        'unit_ttc', round(v_l.consigne_price, 2), 'unit_ht', round(v_l.consigne_price, 2),
        'tva_rate', 0, 'total_ht', v_total_ttc, 'total_tva', 0, 'total_ttc', v_total_ttc
      );
      v_ht := v_ht + v_total_ttc;
      v_ttc := v_ttc + v_total_ttc;
      v_by_rate := jsonb_set(v_by_rate, array['0'], jsonb_build_object(
        'ht', round(coalesce((v_by_rate #>> array['0', 'ht'])::numeric, 0) + v_total_ttc, 2),
        'tva', round(coalesce((v_by_rate #>> array['0', 'tva'])::numeric, 0), 2)), true);
    end if;
  end loop;

  -- Remise en pied de commande : ligne négative au taux par défaut.
  if coalesce(v_order.remise_montant, 0) > 0 and jsonb_array_length(v_lines) > 0 then
    v_rate := coalesce(v_org_row.tva_rate, 20);
    v_total_ttc := -round(v_order.remise_montant, 2);
    v_total_ht := round(v_total_ttc / (1 + v_rate / 100), 2);
    v_lines := v_lines || jsonb_build_object(
      'reference', '', 'designation', 'Remise commerciale', 'quantity', 1,
      'unit_ttc', v_total_ttc, 'unit_ht', v_total_ht,
      'tva_rate', v_rate, 'total_ht', v_total_ht, 'total_tva', round(v_total_ttc - v_total_ht, 2), 'total_ttc', v_total_ttc
    );
    v_ht := v_ht + v_total_ht;
    v_tva := v_tva + (v_total_ttc - v_total_ht);
    v_ttc := v_ttc + v_total_ttc;
    v_rate_key := trim(trailing '.' from trim(trailing '0' from v_rate::text));
    v_by_rate := jsonb_set(
      v_by_rate, array[v_rate_key],
      jsonb_build_object(
        'ht', round(coalesce((v_by_rate #>> array[v_rate_key, 'ht'])::numeric, 0) + v_total_ht, 2),
        'tva', round(coalesce((v_by_rate #>> array[v_rate_key, 'tva'])::numeric, 0) + (v_total_ttc - v_total_ht), 2)
      ), true);
  end if;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'This order has no invoiceable line.';
  end if;

  v_totals := jsonb_build_object(
    'ht', round(v_ht, 2), 'tva', round(v_tva, 2), 'ttc', round(v_ttc, 2),
    'by_rate', v_by_rate,
    'order_total', v_order.montant_total,
    'avoir_applique', v_order.avoir_applique,
    'paid', v_order.montant_paye + v_order.avance_payee,
    'due', v_order.solde_restant
  );
  v_buyer := jsonb_build_object(
    'name', coalesce(v_client.name, 'Client comptoir'),
    'address', v_client.address, 'city', v_client.city,
    'phone', coalesce(v_client.phone, v_order.client_phone), 'email', coalesce(v_client.email, v_order.client_email),
    'siret', v_client.siret, 'tva_intra', v_client.tva_intra, 'is_garage', coalesce(v_client.is_garage, false),
    'immatriculation', v_order.immatriculation, 'vehicle_model', v_order.vehicle_model
  );
  if v_order.mode_paiement = 'EN_COMPTE' then
    v_due := coalesce(v_order.echeance, (v_issued at time zone 'Europe/Paris')::date + coalesce(v_client.payment_terms_days, 30));
    v_terms := coalesce(v_org_row.payment_terms_text, format('Paiement à %s jours, échéance le %s.', coalesce(v_client.payment_terms_days, 30), to_char(v_due, 'DD/MM/YYYY')));
  else
    v_due := (v_issued at time zone 'Europe/Paris')::date;
    v_terms := coalesce(v_org_row.payment_terms_text, 'Paiement comptant à réception.');
  end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':invoices'));
  select content_hash into v_prev from public.invoices
  where organization_id = v_org order by created_at desc, number desc limit 1;
  v_number := public.next_invoice_number(v_org, 'FACTURE', coalesce(nullif(trim(v_org_row.invoice_prefix), ''), 'FA'));

  insert into public.invoices (
    organization_id, number, kind, issued_at, issued_by, order_id, client_id,
    seller, buyer, lines, totals, due_date, payment_terms, mode_paiement, prev_hash, content_hash
  ) values (
    v_org, v_number, 'FACTURE', v_issued, auth.uid(), v_order.id, v_order.client_id,
    public.seller_snapshot(v_org), v_buyer, v_lines, v_totals, v_due, v_terms, v_order.mode_paiement,
    v_prev, public.invoice_hash(v_number, v_issued, v_lines, v_totals, v_prev)
  ) returning id into v_id;

  return v_id;
end;
$$;

notify pgrst, 'reload schema';
