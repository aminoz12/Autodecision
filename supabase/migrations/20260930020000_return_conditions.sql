-- Retours (2026-09-30) : conditions de retour — frais par ancienneté de la vente.
--
-- Le comptoir calcule les frais de retour dans l'application (pièce en stock :
-- 20 % jusqu'à 7 j, 30 % jusqu'à 14 j puis jusqu'à 1 mois ; pièce sur commande :
-- 20 % jusqu'au 7e jour, 40 % jusqu'au 14e ; pièces électriques : aucun retour ;
-- pas de frais quand le magasin, le catalogue ou le fournisseur est en tort).
-- create_walk_in_return reçoit désormais un pourcentage par ligne (p_fee_pcts,
-- aligné sur p_line_ids) : le montant remboursé — ou l'avoir émis — est la
-- valeur de la ligne moins ces frais, et la retenue est gardée dans `frais`.
-- L'ancienne signature est supprimée pour éviter toute ambiguïté PostgREST ;
-- l'application appelle la nouvelle et retombe sur un appel sans frais si la
-- base n'a pas encore cette migration.

-- Units taken back (a garage request can be partial; the counter refunds what is left).
alter table public.sales_returns add column if not exists quantity integer not null default 1;
alter table public.sales_returns drop constraint if exists sales_returns_quantity_check;
alter table public.sales_returns add constraint sales_returns_quantity_check check (quantity > 0);

drop function if exists public.create_walk_in_return(uuid, uuid[], text, text, uuid);

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
    -- Units already taken back (a refused request does not count): the counter refunds what is left.
    select coalesce(sum(r.quantity), 0) into v_returned
    from public.sales_returns r
    where r.order_line_id = v_line.id and r.statut_traitement <> 'REFUSE';
    v_remaining := v_line.quantity - v_returned;
    if v_remaining <= 0 then
      raise exception 'This order line has already been returned.';
    end if;

    v_ref := format('RET-%s-%s', v_year, lpad(v_return_seq::text, 5, '0'));
    v_return_seq := v_return_seq + 1;

    -- Frais de retour de cette ligne (0 quand l'application n'en envoie pas).
    v_idx := array_position(p_line_ids, v_line.id);
    v_fee := least(greatest(coalesce(p_fee_pcts[v_idx], 0), 0), 100);
    v_gross := v_remaining * v_line.prix_vente_unitaire;
    v_net := round(v_gross * (100 - v_fee) / 100, 2);
    v_total := v_total + v_net;

    insert into public.sales_returns (
      organization_id, client_id, order_id, order_line_id, ref, designation,
      reason, motif, type_retour, statut_traitement, decote_pct, montant, frais, quantity, supplier_id
    ) values (
      v_org, v_order.client_id, v_order.id, v_line.id, v_ref, v_line.nom_produit,
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      'RETOURNABLE',
      case when p_compensation = 'FOURNISSEUR' then 'A_TRAITER'::public.return_treatment
           when p_compensation = 'AVOIR' then 'AVOIR'::public.return_treatment
           else 'REMBOURSE'::public.return_treatment end,
      v_fee, v_net, round(v_gross - v_net, 2), v_remaining,
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
$$;

revoke all on function public.create_walk_in_return(uuid, uuid[], text, text, uuid, numeric[]) from public;
grant execute on function public.create_walk_in_return(uuid, uuid[], text, text, uuid, numeric[]) to authenticated;
