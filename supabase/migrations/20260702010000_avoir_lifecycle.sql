-- ============================================================================
--  Avoir (credit note) lifecycle — sheet parity: MONTANT UTILISE / RESTE,
--  échéance +1 an, and using an avoir as payment on a new order.
--
--  * credit_notes.used_amount : cumulative amount already consumed; the
--    remaining balance is amount - used_amount (the sheet's RESTE DU MONTANT).
--  * credit_notes.client_id becomes nullable so a comptoir refund with no
--    client record can still be compensated with an avoir.
--  * return_treatment gains AVOIR: the return was compensated by a credit
--    note instead of a cash refund.
--  * orders.avoir_id / avoir_applique : which avoir paid part of the order
--    and for how much.
--  * apply_credit_note() consumes an avoir atomically (row lock): validates
--    balance + expiry, bumps used_amount, flips statut to PARTIEL / UTILISE,
--    and decrements the order's solde_restant.
-- ============================================================================

-- 1) credit_notes: consumption tracking --------------------------------------
alter table public.credit_notes
  add column if not exists used_amount numeric(14,2) not null default 0;

do $$ begin
  alter table public.credit_notes alter column client_id drop not null;
exception when others then null; end $$;

-- 2) sales_returns: a return can be settled with an avoir --------------------
alter type public.return_treatment add value if not exists 'AVOIR';

-- 3) orders: an avoir can pay (part of) an order ------------------------------
alter table public.orders
  add column if not exists avoir_id uuid references public.credit_notes (id) on delete set null;
alter table public.orders
  add column if not exists avoir_applique numeric(14,2) not null default 0;

-- 4) Atomic consumption ---------------------------------------------------
-- SECURITY INVOKER on purpose: RLS keeps every read/update inside the
-- caller's organization even if p_org is forged.
create or replace function public.apply_credit_note(
  p_org uuid,
  p_credit uuid,
  p_order uuid,
  p_amount numeric
) returns numeric
language plpgsql set search_path = public as $$
declare
  v_remaining numeric;
  v_echeance date;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Montant d''avoir invalide.';
  end if;

  select cn.amount - cn.used_amount, cn.echeance
    into v_remaining, v_echeance
  from public.credit_notes cn
  where cn.id = p_credit and cn.organization_id = p_org
  for update;

  if not found then
    raise exception 'Avoir introuvable.';
  end if;
  if v_echeance is not null and v_echeance < current_date then
    raise exception 'Avoir expiré depuis le %.', to_char(v_echeance, 'DD/MM/YYYY');
  end if;
  if v_remaining < p_amount then
    raise exception 'Solde d''avoir insuffisant (reste % €).', v_remaining;
  end if;

  update public.credit_notes
     set used_amount = used_amount + p_amount,
         statut = case when used_amount + p_amount >= amount
                       then 'UTILISE'::public.credit_status
                       else 'PARTIEL'::public.credit_status end,
         updated_at = now()
   where id = p_credit;

  update public.orders
     set avoir_id = p_credit,
         avoir_applique = avoir_applique + p_amount,
         solde_restant = greatest(0, solde_restant - p_amount),
         updated_at = now()
   where id = p_order and organization_id = p_org;

  if not found then
    raise exception 'Commande introuvable.';
  end if;

  return v_remaining - p_amount;
end;
$$;
grant execute on function public.apply_credit_note(uuid, uuid, uuid, numeric) to authenticated;

notify pgrst, 'reload schema';
