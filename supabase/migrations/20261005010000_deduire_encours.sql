-- Garage / client PRO : déduire un règlement ou un retour de l'encours (2026-10-05).
--
-- Demande du magasin : « le garage vient payer une commande ou retourner une
-- commande… il faut pouvoir la déduire de son encours ».
--
-- Jusqu'ici un retour ne touchait jamais ce que le client doit : un avoir était
-- créé à côté (déduit du « Solde du compte » du relevé, mais pas des commandes à
-- régler, de l'encours de la liste ni des relances d'impayés), un remboursement
-- rendait de l'argent sur une commande jamais payée, et la réception d'un retour
-- demandé depuis le portail garage ne faisait rien côté argent.
--
--  1. credit_allocations : imputation d'un avoir sur une commande (montant,
--     qui, quand ; reversed_at quand la commande est annulée).
--  2. impute_credit_note(avoir, commandes?) : impute le reste d'un avoir sur
--     les commandes à régler du client — sa propre commande d'abord, puis par
--     échéance (même ordre que settle_client_account). solde_restant baisse,
--     l'avoir passe PARTIEL / UTILISE. Rien n'entre en caisse.
--  3. Nouvelle compensation de retour « DEDUCTION » (Déduire de l'encours) :
--     un avoir est émis (pièce comptable, comme AVOIR) puis imputé aussitôt.
--     Ce qui dépasse ce que le client doit reste en avoir.
--       - create_walk_in_return (retour au comptoir)
--       - settle_client_return (traitement d'un retour en attente)
--       - receive_garage_return(p_return_id, p_compensation, p_amount) : la
--         réception d'un retour demandé par le garage peut maintenant le
--         déduire, en faire un avoir ou noter un remplacement.
--  4. settle_client_return ne remet plus en stock une pièce déjà rentrée à la
--     réception du retour garage (received_at) : elle était comptée deux fois.
--  5. cancel_order rend disponibles les avoirs imputés sur la commande annulée.
--  6. Numéro d'avoir : un seul générateur (next_credit_note_num) sous le même
--     verrou que settle_client_return, aussi pour les retours comptoir.
--  7. Verrous : lock_client_open_orders verrouille les commandes ouvertes d'un
--     client dans l'ordre de settle_client_account ; toute déduction l'appelle
--     AVANT les verrous de ligne, de stock et les verrous consultatifs, et
--     settle_client_account aussi (plus de règlement partiellement non affecté).
--  8. settle_client_return refuse : un retour déjà compensé par un remplacement,
--     une demande du portail garage pas encore réceptionnée, un retour sans
--     valeur connue (avant : montant libre).
--  9. set_line_reglement : une commande payée en partie par un avoir imputé
--     reste « Acompte » (PARTIEL) quand on change l'étiquette d'une ligne.
-- 10. create_walk_in_return refuse une commande annulée, et ne remet en stock
--     que les unités reprises (restock_returned_units) quand une partie de la
--     ligne était déjà revenue.
-- 11. Un avoir aussitôt déduit n'est pas annoncé « Avoir de X € » au garage :
--     notify_credit_deduction dit ce qui a été déduit et ce qui reste.
-- 12. emit_invoice : « Avoir déduit » inclut les avoirs imputés après la vente.
--
-- Laissés tels quels (signalés) : la remise de pied de commande n'est pas
-- proratisée sur la valeur d'un retour ; offrir une ligne après une imputation
-- ne rend pas à l'avoir la part déjà imputée sur cette ligne.
--
-- Les corps de create_walk_in_return, settle_client_return, receive_garage_return,
-- cancel_order, settle_client_account, set_line_reglement, credit_notes_notify et
-- emit_invoice reprennent la définition EN BASE (pg_get_functiondef du
-- 2026-10-05), modifiée seulement aux endroits marqués « 20261005 ».
--
-- ---------------------------------------------------------------------
-- 1. Compensation « DEDUCTION »
-- ---------------------------------------------------------------------
alter table public.sales_returns drop constraint if exists sales_returns_compensation_check;
alter table public.sales_returns add constraint sales_returns_compensation_check
  check (compensation is null or compensation in ('REMBOURSEMENT', 'AVOIR', 'REMPLACEMENT', 'FOURNISSEUR', 'DEDUCTION'));

-- ---------------------------------------------------------------------
-- 2. Imputations d'avoirs sur les commandes
-- ---------------------------------------------------------------------
create table if not exists public.credit_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  credit_note_id uuid not null references public.credit_notes(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  -- Set when the order is cancelled: the amount went back to the credit note.
  reversed_at timestamptz
);
create index if not exists credit_allocations_order_idx on public.credit_allocations (organization_id, order_id);
create index if not exists credit_allocations_credit_idx on public.credit_allocations (credit_note_id);

alter table public.credit_allocations enable row level security;
revoke all on table public.credit_allocations from public, anon, authenticated;
grant select on table public.credit_allocations to authenticated;
drop policy if exists credit_allocations_select_staff on public.credit_allocations;
create policy credit_allocations_select_staff on public.credit_allocations
  for select to authenticated
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.is_counter_staff()
  );
-- Same audit trail as payment_allocations: which credit paid which order, and when it was undone.
drop trigger if exists audit_credit_allocations on public.credit_allocations;
create trigger audit_credit_allocations
  after insert or update or delete on public.credit_allocations
  for each row execute function public.audit_row();

-- Next AV-YYYY-NNNNN number, under the lock settle_client_return already used.
create or replace function public.next_credit_note_num(p_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from current_date);
  v_seq integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_org::text || ':credits:' || v_year::text));
  select coalesce(max(public.ref_seq(num)), 0) + 1 into v_seq
  from public.credit_notes
  where organization_id = p_org and num like format('AV-%s-%%', v_year);
  return format('AV-%s-%s', v_year, lpad(v_seq::text, 5, '0'));
end;
$$;
revoke execute on function public.next_credit_note_num(uuid) from public, anon, authenticated;

-- Locks a client's open orders (plus p_extra, e.g. a return's own order), in
-- the order settle_client_account walks them. Every function that may touch
-- several orders of a client calls it FIRST, before any advisory, line or
-- stock lock: the same lock order everywhere, no deadlock between two counters.
create or replace function public.lock_client_open_orders(p_org uuid, p_client uuid, p_extra uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
  from public.orders o
  where o.organization_id = p_org
    and (
      o.id = p_extra
      or (o.client_id = p_client and o.devis = false and o.is_restock = false
          and o.cancelled_at is null and o.solde_restant > 0)
    )
  order by coalesce(o.echeance, o.date_commande), o.date_commande, o."createdAt", o.id
  for update;
end;
$$;
revoke execute on function public.lock_client_open_orders(uuid, uuid, uuid) from public, anon, authenticated;

-- Imputes what is left of a credit note on its client's open orders: the
-- credit's own order first, then by due date. No access check: callers do it.
create or replace function public.impute_credit_internal(p_credit_id uuid, p_order_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit public.credit_notes;
  v_left numeric;
  v_total numeric := 0;
  v_alloc numeric;
  v_solde numeric;
  v_o record;
  v_allocs jsonb := '[]'::jsonb;
begin
  select * into v_credit from public.credit_notes where id = p_credit_id;
  if not found then
    raise exception 'Credit note not found.';
  end if;
  if v_credit.client_id is null then
    return jsonb_build_object('num', v_credit.num, 'imputed', 0, 'remaining', greatest(v_credit.amount - v_credit.used_amount, 0), 'allocations', v_allocs);
  end if;

  -- The orders first (callers usually hold them already), then the credit note.
  perform public.lock_client_open_orders(v_credit.organization_id, v_credit.client_id, v_credit.order_id);

  select * into v_credit from public.credit_notes where id = p_credit_id for update;
  v_left := round(v_credit.amount - v_credit.used_amount, 2);
  if v_credit.statut not in ('EN_COURS', 'PARTIEL') or v_left <= 0 then
    return jsonb_build_object('num', v_credit.num, 'imputed', 0, 'remaining', greatest(v_left, 0), 'allocations', v_allocs);
  end if;
  if v_credit.echeance is not null and v_credit.echeance < current_date then
    raise exception 'Cet avoir a expiré le %.', to_char(v_credit.echeance, 'DD/MM/YYYY');
  end if;

  for v_o in
    select o.id, o.ref_demande, o.solde_restant
    from public.orders o
    where o.organization_id = v_credit.organization_id and o.client_id = v_credit.client_id
      and o.devis = false and o.is_restock = false and o.cancelled_at is null and o.solde_restant > 0
      and (p_order_ids is null or o.id = any(p_order_ids))
    order by (o.id = v_credit.order_id) desc nulls last, coalesce(o.echeance, o.date_commande), o.date_commande, o."createdAt"
    -- An order that became open after the pre-lock is locked (and re-read) here.
    for update
  loop
    exit when v_left <= 0;
    v_alloc := least(v_left, v_o.solde_restant);
    v_solde := round(v_o.solde_restant - v_alloc, 2);
    insert into public.credit_allocations (organization_id, credit_note_id, order_id, amount, created_by)
    values (v_credit.organization_id, v_credit.id, v_o.id, v_alloc, auth.uid());
    update public.orders
    set solde_restant = v_solde,
        statut_paiement = case when v_solde <= 0 then 'PAYÉ'::public.orders_statut_paiement_enum
                               else 'PARTIEL'::public.orders_statut_paiement_enum end,
        updated_at = now()
    where id = v_o.id;
    v_allocs := v_allocs || jsonb_build_object('order_id', v_o.id, 'ref', v_o.ref_demande, 'amount', v_alloc);
    v_total := round(v_total + v_alloc, 2);
    v_left := round(v_left - v_alloc, 2);
  end loop;

  if v_total > 0 then
    update public.credit_notes
    set used_amount = used_amount + v_total,
        statut = case when used_amount + v_total >= amount then 'UTILISE'::public.credit_status
                      else 'PARTIEL'::public.credit_status end,
        updated_at = now()
    where id = v_credit.id;
  end if;

  return jsonb_build_object('num', v_credit.num, 'imputed', v_total, 'remaining', v_left, 'allocations', v_allocs);
end;
$$;
revoke execute on function public.impute_credit_internal(uuid, uuid[]) from public, anon, authenticated;

-- Puts back on the shelf only the units taken back now (restock_returned_line
-- puts the whole line); the line is marked done once every unit is back.
create or replace function public.restock_returned_units(p_line_id uuid, p_qty integer, p_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line public.order_lines;
  v_back integer;
begin
  select * into v_line from public.order_lines where id = p_line_id for update;
  if not found or v_line.retour_stock_fait or coalesce(p_qty, 0) <= 0 then
    return;
  end if;
  perform set_config('app.stock_reason', 'RETOUR_CLIENT', true);
  perform set_config('app.stock_ref', coalesce(p_ref, ''), true);
  perform set_config('app.stock_order_id', v_line.order_id::text, true);
  insert into public.stock_items (organization_id, sku, name, quantity_on_hand, cost_price)
  values (v_line.organization_id, v_line.reference, v_line.nom_produit, p_qty, nullif(v_line.prix_achat_unitaire, 0))
  on conflict (organization_id, sku) do update
    set quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
        name = coalesce(public.stock_items.name, excluded.name),
        updated_at = now();
  select coalesce(sum(r.quantity), 0) into v_back
  from public.sales_returns r
  where r.order_line_id = v_line.id and r.statut_traitement in ('ACCEPTE', 'REMBOURSE', 'AVOIR');
  if v_back >= v_line.quantity then
    update public.order_lines set retour_stock_fait = true where id = v_line.id;
  end if;
end;
$$;
revoke execute on function public.restock_returned_units(uuid, integer, text) from public, anon, authenticated;

-- What the garage reads after a deduction: what came off its account, and what is
-- left as an avoir (instead of « Avoir de X € », which it no longer holds).
create or replace function public.notify_credit_deduction(p_credit_id uuid, p_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c public.credit_notes;
  v_left numeric;
begin
  select * into v_c from public.credit_notes where id = p_credit_id;
  if not found or v_c.client_id is null or not public.client_is_garage(v_c.client_id) then
    return;
  end if;
  v_left := round(v_c.amount - v_c.used_amount, 2);
  perform public.notify(
    v_c.organization_id, 'CLIENT', 'CREDIT_DEDUCTED',
    case when v_c.used_amount > 0
         then format('%s € déduits de votre compte', to_char(v_c.used_amount, 'FM999G999G990D00'))
         else format('Avoir %s de %s €', coalesce(v_c.num, ''), to_char(v_c.amount, 'FM999G999G990D00')) end,
    concat_ws(' ',
      format('Retour %s.', coalesce(p_ref, '')),
      case when v_left > 0 then format('Il reste %s € en avoir (%s)%s.', to_char(v_left, 'FM999G999G990D00'), v_c.num,
        case when v_c.echeance is not null then format(', valable jusqu''au %s', to_char(v_c.echeance, 'DD/MM/YYYY')) else '' end) end),
    '/garagiste/dashboard/factures', 'credit_notes', v_c.id, v_c.client_id);
end;
$$;
revoke execute on function public.notify_credit_deduction(uuid, text) from public, anon, authenticated;

-- « Déduire de l'encours » on the account file: a credit note the client still
-- holds pays its open orders (or the ones given).
create or replace function public.impute_credit_note(p_credit_id uuid, p_order_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_result jsonb;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if not exists (select 1 from public.credit_notes c where c.id = p_credit_id and c.organization_id = v_org) then
    raise exception 'Credit note not found.';
  end if;
  v_result := public.impute_credit_internal(p_credit_id, p_order_ids);
  if coalesce((v_result->>'imputed')::numeric, 0) <= 0 then
    raise exception 'Rien à déduire : ce client n''a aucune commande à régler (ou l''avoir est déjà utilisé).';
  end if;
  return v_result;
end;
$$;
revoke execute on function public.impute_credit_note(uuid, uuid[]) from public, anon;
grant execute on function public.impute_credit_note(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 3a. Retour comptoir : compensation DEDUCTION
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_walk_in_return(p_order_id uuid, p_line_ids uuid[], p_reason text, p_compensation text, p_supplier_id uuid DEFAULT NULL::uuid, p_fee_pcts numeric[] DEFAULT NULL::numeric[])
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
  v_idx integer;
  v_fee numeric;
  v_gross numeric;
  v_net numeric;
  v_returned integer;
  v_remaining integer;
  v_replace boolean := p_compensation = 'REMPLACEMENT';
  -- 20261005 : « Déduire de l'encours » = avoir émis puis imputé.
  v_deduct boolean := p_compensation = 'DEDUCTION';
  v_credit_id uuid;
  v_client uuid;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one line.';
  end if;
  if p_compensation not in ('REMBOURSEMENT', 'AVOIR', 'REMPLACEMENT', 'FOURNISSEUR', 'DEDUCTION') then
    raise exception 'Invalid return compensation.';
  end if;
  if p_fee_pcts is not null and array_length(p_fee_pcts, 1) <> array_length(p_line_ids, 1) then
    raise exception 'One fee per line is expected.';
  end if;

  -- 20261005 : a deduction may touch every open order of the client: lock them first
  -- (lock_client_open_orders), before the advisory, line and stock locks below.
  if v_deduct then
    select o.client_id into v_client from public.orders o where o.id = p_order_id and o.organization_id = v_org;
    if v_client is not null then
      perform public.lock_client_open_orders(v_org, v_client, p_order_id);
    end if;
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and devis = false
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  -- 20261005 : a cancelled order owes nothing and its parts are back already.
  if v_order.cancelled_at is not null then
    raise exception 'Commande annulée : aucun retour possible.';
  end if;
  if v_deduct and v_order.client_id is null then
    raise exception 'Déduction impossible : cette commande n''a pas de client.';
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
    -- Units already taken back (a refused request does not count): the counter takes back what is left.
    select coalesce(sum(r.quantity), 0) into v_returned
    from public.sales_returns r
    where r.order_line_id = v_line.id and r.statut_traitement <> 'REFUSE';
    v_remaining := v_line.quantity - v_returned;
    if v_remaining <= 0 then
      raise exception 'This order line has already been returned.';
    end if;

    v_ref := format('RET-%s-%s', v_year, lpad(v_return_seq::text, 5, '0'));
    v_return_seq := v_return_seq + 1;

    -- Frais de retour de cette ligne (aucun pour un remplacement : pas d'argent rendu).
    v_idx := array_position(p_line_ids, v_line.id);
    v_fee := case when v_replace then 0 else least(greatest(coalesce(p_fee_pcts[v_idx], 0), 0), 100) end;
    v_gross := v_remaining * v_line.prix_vente_unitaire;
    v_net := case when v_replace then 0 else round(v_gross * (100 - v_fee) / 100, 2) end;
    v_total := v_total + v_net;

    insert into public.sales_returns (
      organization_id, client_id, order_id, order_line_id, ref, designation,
      reason, motif, type_retour, statut_traitement, decote_pct, montant, frais, quantity, compensation, supplier_id
    ) values (
      v_org, v_order.client_id, v_order.id, v_line.id, v_ref, v_line.nom_produit,
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      'RETOURNABLE',
      case when p_compensation = 'FOURNISSEUR' then 'A_TRAITER'::public.return_treatment
           when p_compensation in ('AVOIR', 'DEDUCTION') then 'AVOIR'::public.return_treatment
           when v_replace then 'ACCEPTE'::public.return_treatment
           else 'REMBOURSE'::public.return_treatment end,
      v_fee, v_net,
      case when v_replace then 0 else round(v_gross - v_net, 2) end,
      v_remaining, p_compensation,
      case when p_compensation = 'FOURNISSEUR' then p_supplier_id else null end
    );
    -- Remboursement / avoir : la pièce reprise retourne en rayon. Remplacement : pas de mouvement automatique.
    if p_compensation in ('REMBOURSEMENT', 'AVOIR', 'DEDUCTION') then
      -- 20261005 : only the units taken back now (a garage return may have brought some back already).
      if v_remaining >= v_line.quantity then
        perform public.restock_returned_line(v_line.id, v_order.ref_demande);
      else
        perform public.restock_returned_units(v_line.id, v_remaining, v_order.ref_demande);
      end if;
    end if;
  end loop;

  if v_count <> array_length(p_line_ids, 1) then
    raise exception 'One or more selected lines do not belong to this order.';
  end if;

  if p_compensation not in ('AVOIR', 'DEDUCTION') then
    return null;
  end if;

  v_avoir_num := public.next_credit_note_num(v_org);
  -- A deducted avoir is not announced as « Avoir de X € »: the garage is told what was deducted.
  if v_deduct then
    perform set_config('app.credit_deduction', 'on', true);
  end if;

  insert into public.credit_notes (
    organization_id, client_id, order_id, num, amount, used_amount, statut,
    echeance, motif, designation
  ) values (
    v_org, v_order.client_id, v_order.id, v_avoir_num, v_total, 0, 'EN_COURS',
    v_expiry, coalesce(nullif(trim(p_reason), ''), 'Retour client'),
    (select string_agg(nom_produit, ', ') from public.order_lines where id = any(p_line_ids))
  ) returning id into v_credit_id;

  if v_deduct then
    perform set_config('app.credit_deduction', '', true);
    perform public.impute_credit_internal(v_credit_id, null);
    perform public.notify_credit_deduction(v_credit_id, 'sur la commande ' || v_order.ref_demande);
  end if;

  return v_avoir_num;
end;
$function$;
revoke all on function public.create_walk_in_return(uuid, uuid[], text, text, uuid, numeric[]) from public, anon;
grant execute on function public.create_walk_in_return(uuid, uuid[], text, text, uuid, numeric[]) to authenticated;

-- ---------------------------------------------------------------------
-- 3b. Traitement d'un retour en attente : DEDUCTION, pas de double remise en stock
-- ---------------------------------------------------------------------
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
  v_credit_id uuid;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_mode not in ('REMBOURSEMENT', 'AVOIR', 'DEDUCTION') then
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
  -- 20261005 : a replaced part is already compensated; a garage request is settled once the part is back.
  if v_return.compensation = 'REMPLACEMENT' then
    raise exception 'Ce retour a déjà été compensé par un remplacement.';
  end if;
  if v_return.requested_by is not null and v_return.received_at is null then
    raise exception 'Réceptionnez d''abord la pièce : le garage ne l''a pas encore rendue.';
  end if;
  -- A deduction may touch every open order of the client: lock them before any line or stock lock.
  if p_mode = 'DEDUCTION' then
    perform public.lock_client_open_orders(v_org, v_return.client_id, v_return.order_id);
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
  -- 20261005 : no known value (no amount, line or order) → nothing can be paid or deducted.
  if v_cap is null or v_cap <= 0 then
    raise exception 'Valeur du retour inconnue : impossible de rembourser ou de déduire.';
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
    -- 20261005 : déjà remise en rayon à la réception d'un retour garage.
    if v_return.order_line_id is not null and v_return.received_at is null then
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

  if v_return.order_line_id is not null and v_return.received_at is null then
    perform public.restock_returned_line(v_return.order_line_id, v_return.ref);
  end if;

  v_num := public.next_credit_note_num(v_org);
  -- A deducted avoir is not announced as « Avoir de X € »: the garage is told what was deducted.
  if p_mode = 'DEDUCTION' then
    perform set_config('app.credit_deduction', 'on', true);
  end if;

  insert into public.credit_notes (
    organization_id, client_id, order_id, num, amount, used_amount, statut,
    echeance, motif, designation
  ) values (
    v_org, v_return.client_id, v_return.order_id, v_num, v_amount, 0, 'EN_COURS',
    (current_date + interval '1 year')::date,
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), v_return.motif, 'Retour client'),
    coalesce(v_return.designation, v_return.ref)
  ) returning id into v_credit_id;
  perform set_config('app.credit_deduction', '', true);

  update public.sales_returns
  set statut_traitement = 'AVOIR'::public.return_treatment,
      montant = v_amount,
      compensation = case when p_mode = 'DEDUCTION' then 'DEDUCTION' else compensation end,
      motif = coalesce(nullif(trim(coalesce(p_reason, '')), ''), motif),
      updated_at = now()
  where id = v_return.id;

  -- 20261005 : « Déduire de l'encours » : l'avoir paie aussitôt ce que le client doit.
  if p_mode = 'DEDUCTION' then
    perform public.impute_credit_internal(v_credit_id, null);
    -- At a reception, receive_garage_return tells the garage itself (one message, not two).
    if coalesce(current_setting('app.in_receive', true), '') <> 'on' then
      perform public.notify_credit_deduction(v_credit_id, v_return.ref);
    end if;
  end if;

  return v_num;
end;
$function$;
revoke execute on function public.settle_client_return(uuid, text, numeric, text, text) from public, anon;
grant execute on function public.settle_client_return(uuid, text, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3c. Réception d'un retour garage : déduire, avoir ou remplacement
-- ---------------------------------------------------------------------
drop function if exists public.receive_garage_return(uuid);
CREATE OR REPLACE FUNCTION public.receive_garage_return(
  p_return_id uuid,
  -- 20261005 : DEDUCTION (déduire de l'encours), AVOIR, REMPLACEMENT, ou null (rien, comme avant).
  p_compensation text DEFAULT NULL::text,
  -- Montant déduit / de l'avoir ; null = la valeur du retour.
  p_amount numeric DEFAULT NULL::numeric
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_ret public.sales_returns;
  v_line public.order_lines;
  v_amount numeric;
  v_num text;
  v_imputed numeric := 0;
  v_money text := '';
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_compensation is not null and p_compensation not in ('DEDUCTION', 'AVOIR', 'REMPLACEMENT') then
    raise exception 'Invalid return compensation.';
  end if;
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
  -- 20261005 : a deduction may touch every open order of the garage: lock them before the line and stock.
  if p_compensation = 'DEDUCTION' and v_ret.client_id is not null then
    perform public.lock_client_open_orders(v_org, v_ret.client_id, v_ret.order_id);
  end if;

  update public.sales_returns
  set statut_traitement = 'ACCEPTE',
      received_at = now(),
      received_by = auth.uid(),
      leg_status = case when livreur_leg is not null then 'FAIT' else leg_status end,
      leg_done_at = case when livreur_leg is not null then coalesce(leg_done_at, now()) else leg_done_at end,
      compensation = case when p_compensation = 'REMPLACEMENT' then 'REMPLACEMENT' else compensation end
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

  -- 20261005 : la valeur du retour est déduite de l'encours, ou devient un avoir.
  v_amount := round(coalesce(p_amount, v_ret.montant, 0), 2);
  -- A part that was offered is only deducted for the share that was not offered
  -- (same rule as the trigger sales_returns_offert_guard).
  if v_ret.order_line_id is not null then
    select * into v_line from public.order_lines where id = v_ret.order_line_id;
    if found and coalesce(v_line.offert_montant, 0) > 0 and v_line.quantity * v_line.prix_vente_unitaire > 0 then
      v_amount := least(v_amount, round(coalesce(v_ret.quantity, 1) * v_line.prix_vente_unitaire
        * (1 - least(v_line.offert_montant / (v_line.quantity * v_line.prix_vente_unitaire), 1)), 2));
    end if;
  end if;
  if p_compensation in ('DEDUCTION', 'AVOIR') and v_amount > 0 then
    perform set_config('app.in_receive', 'on', true);
    v_num := public.settle_client_return(v_ret.id, p_compensation, v_amount, null, 'ESPECES');
    perform set_config('app.in_receive', '', true);
    if p_compensation = 'DEDUCTION' then
      select coalesce(sum(a.amount), 0) into v_imputed
      from public.credit_allocations a
      join public.credit_notes c on c.id = a.credit_note_id
      where c.organization_id = v_org and c.num = v_num and a.reversed_at is null;
    end if;
    v_money := case
      when v_imputed > 0 and v_imputed >= v_amount then
        format(' %s € déduits de votre compte.', to_char(v_imputed, 'FM999G990D00'))
      when v_imputed > 0 then
        format(' %s € déduits de votre compte, %s € en avoir (%s).', to_char(v_imputed, 'FM999G990D00'), to_char(v_amount - v_imputed, 'FM999G990D00'), v_num)
      else format(' Avoir %s de %s €.', v_num, to_char(v_amount, 'FM999G990D00'))
    end;
  end if;

  perform public.notify(
    v_org, 'CLIENT', 'RETURN_RECEIVED',
    'Retour ' || v_ret.ref || ' réceptionné',
    v_ret.quantity || ' × ' || v_ret.designation || ' est revenu au magasin.' || v_money,
    '/garagiste/dashboard/retours', 'sales_return', v_ret.id, v_ret.client_id
  );
end;
$function$;
revoke execute on function public.receive_garage_return(uuid, text, numeric) from public, anon;
grant execute on function public.receive_garage_return(uuid, text, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Annulation : les avoirs imputés reviennent
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_order(p_order_id uuid, p_reason text, p_refund_mode text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_paid numeric;
  v_l record;
  v_a record;
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

  -- 20261005 : les avoirs imputés sur la commande redeviennent disponibles.
  for v_a in
    select a.credit_note_id, sum(a.amount) as amount
    from public.credit_allocations a
    where a.order_id = v_order.id and a.organization_id = v_org and a.reversed_at is null
    group by a.credit_note_id
  loop
    update public.credit_notes
    set used_amount = greatest(0, used_amount - v_a.amount),
        statut = case when greatest(0, used_amount - v_a.amount) = 0
                      then 'EN_COURS'::public.credit_status else 'PARTIEL'::public.credit_status end,
        updated_at = now()
    where id = v_a.credit_note_id and organization_id = v_org;
  end loop;
  update public.credit_allocations
  set reversed_at = now()
  where order_id = v_order.id and organization_id = v_org and reversed_at is null;

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
$function$;
revoke execute on function public.cancel_order(uuid, text, text) from public, anon;
grant execute on function public.cancel_order(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Règlement de compte : même ordre de verrouillage que les déductions
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.settle_client_account(p_client_id uuid, p_amount numeric, p_mode text, p_reference text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_order_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_remaining numeric;
  v_open numeric := 0;
  v_payment uuid;
  v_o record;
  v_alloc numeric;
  v_allocs jsonb := '[]'::jsonb;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if p_mode not in ('ESPECES', 'CARTE', 'VIREMENT', 'CHEQUE') then
    raise exception 'Invalid payment mode.';
  end if;
  if v_amount <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not exists (select 1 from public.clients c where c.id = p_client_id and c.organization_id = v_org) then
    raise exception 'Client not found.';
  end if;

  -- 20261005 : lock the open orders first, in the order the loop below walks them
  -- (shared with the deductions), so v_open cannot change before the allocation.
  perform public.lock_client_open_orders(v_org, p_client_id, null);

  select coalesce(sum(o.solde_restant), 0) into v_open
  from public.orders o
  where o.organization_id = v_org and o.client_id = p_client_id
    and o.devis = false and o.is_restock = false and o.solde_restant > 0
    and (p_order_ids is null or o.id = any(p_order_ids));
  if v_open <= 0 then
    raise exception 'This account has nothing left to pay.';
  end if;
  if v_amount > v_open then
    raise exception 'Amount exceeds the open balance (max % EUR).', v_open;
  end if;

  insert into public.payments (
    organization_id, client_id, session_id, kind, mode, amount, reference, note, received_by
  ) values (
    v_org, p_client_id, public.current_cash_session(v_org), 'REGLEMENT_COMPTE', p_mode, v_amount,
    nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid()
  ) returning id into v_payment;

  v_remaining := v_amount;
  for v_o in
    select o.id, o.ref_demande, o.solde_restant
    from public.orders o
    where o.organization_id = v_org and o.client_id = p_client_id
      and o.devis = false and o.is_restock = false and o.solde_restant > 0
      and (p_order_ids is null or o.id = any(p_order_ids))
    order by coalesce(o.echeance, o.date_commande), o.date_commande, o."createdAt"
    for update
  loop
    exit when v_remaining <= 0;
    v_alloc := least(v_remaining, v_o.solde_restant);
    insert into public.payment_allocations (organization_id, payment_id, order_id, amount)
    values (v_org, v_payment, v_o.id, v_alloc);
    perform public.apply_payment_to_order(v_o.id, v_alloc);
    v_allocs := v_allocs || jsonb_build_object('order_id', v_o.id, 'ref', v_o.ref_demande, 'amount', v_alloc);
    v_remaining := round(v_remaining - v_alloc, 2);
  end loop;

  -- Never record money that is not allocated to an order.
  if v_remaining > 0 then
    raise exception 'Le solde du compte a changé pendant l''enregistrement : réessayez.';
  end if;

  return jsonb_build_object('payment_id', v_payment, 'amount', v_amount, 'allocations', v_allocs);
end;
$function$;
revoke execute on function public.settle_client_account(uuid, numeric, text, text, text, uuid[]) from public, anon;
grant execute on function public.settle_client_account(uuid, numeric, text, text, text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Étiquette d'une ligne : une commande payée en partie par un avoir imputé reste « Acompte »
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_line_reglement(p_line_id uuid, p_reglement text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org uuid := public.current_user_org_id();
  v_order_id uuid;
  v_order public.orders;
  v_line public.order_lines;
  v_refunded integer;
  v_gift numeric := 0;
  v_solde numeric;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_reglement not in ('A_PAYER', 'PAYE', 'OFFERT') then
    raise exception 'Invalid line settlement.';
  end if;

  select l.order_id into v_order_id
  from public.order_lines l
  where l.id = p_line_id and l.organization_id = v_org;
  if not found then
    raise exception 'Line not found.';
  end if;
  -- Same lock order as the payment and return functions: the order, then its line.
  select * into v_order
  from public.orders
  where id = v_order_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  select * into v_line
  from public.order_lines
  where id = p_line_id and organization_id = v_org
  for update;

  -- What was offered before comes back on the balance…
  v_solde := v_order.solde_restant + v_line.offert_montant;
  -- …and an offered line takes its value off again: the units not already
  -- refunded, never more than what is still due.
  if p_reglement = 'OFFERT' and not coalesce(v_order.devis, false) and v_order.cancelled_at is null then
    select coalesce(sum(r.quantity), 0) into v_refunded
    from public.sales_returns r
    where r.order_line_id = v_line.id and r.statut_traitement in ('REMBOURSE', 'AVOIR');
    v_gift := least(
      round(greatest(v_line.quantity - v_refunded, 0) * v_line.prix_vente_unitaire, 2),
      greatest(v_solde, 0)
    );
    v_solde := v_solde - v_gift;
  end if;
  v_solde := round(v_solde, 2);

  if v_solde is distinct from v_order.solde_restant then
    update public.orders
    set solde_restant = v_solde,
        statut_paiement = case
          when v_solde <= 0 then 'PAYÉ'::public.orders_statut_paiement_enum
          when coalesce(montant_paye, 0) + coalesce(avance_payee, 0) + coalesce(avoir_applique, 0)
               -- 20261005 : an avoir imputed later (credit_allocations) is a payment too.
               + coalesce((select sum(a.amount) from public.credit_allocations a
                           where a.order_id = v_order.id and a.reversed_at is null), 0) > 0
            then 'PARTIEL'::public.orders_statut_paiement_enum
          else 'NON_PAYÉ'::public.orders_statut_paiement_enum
        end,
        updated_at = now()
    where id = v_order.id;
  end if;

  update public.order_lines
  set reglement = p_reglement, reglement_at = now(), reglement_by = auth.uid(), offert_montant = v_gift
  where id = v_line.id;
end;
$function$;
revoke execute on function public.set_line_reglement(uuid, text) from public, anon;
grant execute on function public.set_line_reglement(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 7. Notification « Avoir de X € » : pas pour un avoir aussitôt déduit
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credit_notes_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- 20261005 : an avoir created to be deducted at once is announced by notify_credit_deduction.
  if coalesce(current_setting('app.credit_deduction', true), '') = 'on' then
    return null;
  end if;
  if new.client_id is not null and public.client_is_garage(new.client_id) then
    perform public.notify(new.organization_id, 'CLIENT', 'CREDIT_ISSUED',
      format('Avoir %s de %s €', coalesce(new.num, ''), to_char(new.amount, 'FM999G999G990D00')),
      case when new.echeance is not null then format('Valable jusqu''au %s.', to_char(new.echeance, 'DD/MM/YYYY')) else null end,
      '/garagiste/dashboard/factures', 'credit_notes', new.id, new.client_id);
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------
-- 8. Facture : « Avoir déduit » compte aussi les avoirs imputés après la vente
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emit_invoice(p_order_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- 20261005 : avoirs imputed after the sale (credit_allocations) are deducted too.
    'avoir_applique', coalesce(v_order.avoir_applique, 0) + coalesce((
      select sum(a.amount) from public.credit_allocations a
      where a.order_id = v_order.id and a.reversed_at is null), 0),
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
$function$;
revoke execute on function public.emit_invoice(uuid) from public, anon;
grant execute on function public.emit_invoice(uuid) to authenticated;

notify pgrst, 'reload schema';
