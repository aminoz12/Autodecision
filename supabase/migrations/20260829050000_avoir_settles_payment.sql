-- ============================================================================
--  Using an avoir settles the order.
--
--  apply_credit_note reduced solde_restant but left statut_paiement as the
--  cashier had chosen ("Non payé" even when the avoir covered everything).
--  The payment status now follows the balance: nothing left → PAYÉ, part of
--  it covered (cash, acompte or avoir) → PARTIEL, otherwise unchanged.
-- ============================================================================

create or replace function public.apply_credit_note(
  p_org uuid,
  p_credit uuid,
  p_order uuid,
  p_amount numeric
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_credit public.credit_notes;
  v_order public.orders;
  v_remaining numeric;
begin
  if v_org is null or p_org is distinct from v_org or public.current_user_client_id() is not null then
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
$$;

notify pgrst, 'reload schema';
