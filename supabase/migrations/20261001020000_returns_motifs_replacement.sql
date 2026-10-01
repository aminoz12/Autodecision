-- Retours (2026-10-01) : nouvelle liste de motifs, compensation « Remplacement ».
--
--  1. Motifs de retour proposés au comptoir et au garage :
--       Erreur client · Erreur magasin · Pièce non conforme / HS ·
--       Annulation client · Prix / reprise commerciale · Autre
--     (codes ERREUR_CLIENT, ERREUR_VENDEUR, NON_CONFORME, ANNULATION,
--     PRIX_REPRISE, AUTRE ; MAUVAISE_IDENTIFICATION et DEFECTUEUSE restent
--     acceptés pour les retours déjà codés).
--  2. Retour comptoir : troisième compensation « REMPLACEMENT » — le client
--     repart avec une pièce, aucun remboursement ni avoir ; le retour est
--     « retourné » (ACCEPTE), sans mouvement de stock automatique.
--     sales_returns.compensation garde la compensation choisie.
-- Cette migration reprend create_walk_in_return (20260930020000) et
-- request_garage_line_return (20260930030000) à l'identique, hors ces points.

alter table public.sales_returns
  add column if not exists compensation text;
alter table public.sales_returns drop constraint if exists sales_returns_compensation_check;
alter table public.sales_returns add constraint sales_returns_compensation_check
  check (compensation is null or compensation in ('REMBOURSEMENT', 'AVOIR', 'REMPLACEMENT', 'FOURNISSEUR'));

-- ---------------------------------------------------------------------
-- Motifs : codage d'un retour au comptoir
-- ---------------------------------------------------------------------
create or replace function public.qualify_returns(
  p_return_ids uuid[], p_line_ids uuid[], p_motif_code text, p_etat text, p_frais numeric
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_n integer;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_motif_code is not null and p_motif_code not in
     ('ERREUR_CLIENT', 'ERREUR_VENDEUR', 'NON_CONFORME', 'ANNULATION', 'PRIX_REPRISE', 'AUTRE',
      'MAUVAISE_IDENTIFICATION', 'DEFECTUEUSE') then
    raise exception 'Invalid return reason code.';
  end if;
  if p_etat is not null and p_etat not in ('NEUVE_EMBALLEE', 'EMBALLAGE_ABIME', 'MONTEE', 'ENDOMMAGEE') then
    raise exception 'Invalid part condition.';
  end if;
  update public.sales_returns r
  set motif_code = coalesce(p_motif_code, r.motif_code),
      etat_piece = coalesce(p_etat, r.etat_piece),
      frais = coalesce(greatest(p_frais, 0), r.frais)
  where r.organization_id = v_org
    and (r.id = any(coalesce(p_return_ids, '{}'::uuid[])) or r.order_line_id = any(coalesce(p_line_ids, '{}'::uuid[])));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.qualify_returns(uuid[], uuid[], text, text, numeric) from public, anon;
grant execute on function public.qualify_returns(uuid[], uuid[], text, text, numeric) to authenticated;

-- ---------------------------------------------------------------------
-- Motifs : demande de retour du garage, article par article
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
    when 'ERREUR_CLIENT' then 'Erreur client'
    when 'ERREUR_VENDEUR' then 'Erreur magasin'
    when 'NON_CONFORME' then 'Pièce non conforme / HS'
    when 'ANNULATION' then 'Annulation client'
    when 'PRIX_REPRISE' then 'Prix / reprise commerciale'
    when 'AUTRE' then 'Autre'
    when 'MAUVAISE_IDENTIFICATION' then 'Mauvaise identification du véhicule'
    when 'DEFECTUEUSE' then 'Pièce défectueuse à la pose'
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
    case when p_motif_code in ('ERREUR_CLIENT', 'ERREUR_VENDEUR', 'NON_CONFORME', 'ANNULATION', 'PRIX_REPRISE', 'AUTRE',
                               'MAUVAISE_IDENTIFICATION', 'DEFECTUEUSE')
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
-- Retour comptoir : remboursement, avoir, remplacement ou retour fournisseur
-- ---------------------------------------------------------------------
create or replace function public.create_walk_in_return(
  p_order_id uuid,
  p_line_ids uuid[],
  p_reason text,
  p_compensation text,
  p_supplier_id uuid default null,
  p_fee_pcts numeric[] default null
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
  v_idx integer;
  v_fee numeric;
  v_gross numeric;
  v_net numeric;
  v_returned integer;
  v_remaining integer;
  v_replace boolean := p_compensation = 'REMPLACEMENT';
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one line.';
  end if;
  if p_compensation not in ('REMBOURSEMENT', 'AVOIR', 'REMPLACEMENT', 'FOURNISSEUR') then
    raise exception 'Invalid return compensation.';
  end if;
  if p_fee_pcts is not null and array_length(p_fee_pcts, 1) <> array_length(p_line_ids, 1) then
    raise exception 'One fee per line is expected.';
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
           when p_compensation = 'AVOIR' then 'AVOIR'::public.return_treatment
           when v_replace then 'ACCEPTE'::public.return_treatment
           else 'REMBOURSE'::public.return_treatment end,
      v_fee, v_net,
      case when v_replace then 0 else round(v_gross - v_net, 2) end,
      v_remaining, p_compensation,
      case when p_compensation = 'FOURNISSEUR' then p_supplier_id else null end
    );
    -- Remboursement / avoir : la pièce reprise retourne en rayon. Remplacement : pas de mouvement automatique.
    if p_compensation in ('REMBOURSEMENT', 'AVOIR') then
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
$$;
revoke all on function public.create_walk_in_return(uuid, uuid[], text, text, uuid, numeric[]) from public;
grant execute on function public.create_walk_in_return(uuid, uuid[], text, text, uuid, numeric[]) to authenticated;

notify pgrst, 'reload schema';
