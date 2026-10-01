-- Fiche garage (2026-10-01) : une pièce « offerte » n'est plus due.
--
-- Jusqu'ici « Offert » n'était qu'une étiquette (20260930030000). Désormais :
--   * marquer une ligne OFFERT retire sa valeur du solde de la commande
--     (plafonnée au solde restant : une pièce déjà payée reste une étiquette,
--     l'argent se rend par un avoir) ; order_lines.offert_montant garde le
--     montant retiré ;
--   * repasser la ligne « À payer » ou « Payé » remet ce montant dans le solde ;
--   * une pièce offerte ne se rembourse pas : le remboursement ou l'avoir d'un
--     retour est limité à la part de la ligne qui n'a pas été offerte.
-- montant_total et montant_paye ne bougent pas : rien n'entre en caisse.

alter table public.order_lines
  add column if not exists offert_montant numeric(14,2) not null default 0;

create or replace function public.set_line_reglement(p_line_id uuid, p_reglement text)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
          when coalesce(montant_paye, 0) + coalesce(avance_payee, 0) + coalesce(avoir_applique, 0) > 0
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
$$;
revoke execute on function public.set_line_reglement(uuid, text) from public, anon;
grant execute on function public.set_line_reglement(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Une pièce offerte ne se rembourse pas
-- ---------------------------------------------------------------------
create or replace function public.sales_returns_offert_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_line public.order_lines;
  v_value numeric;
  v_cap numeric;
begin
  if new.order_line_id is null or new.statut_traitement not in ('REMBOURSE', 'AVOIR') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.statut_traitement = new.statut_traitement
     and old.montant is not distinct from new.montant then
    return new;
  end if;
  select * into v_line from public.order_lines where id = new.order_line_id;
  if not found or coalesce(v_line.offert_montant, 0) <= 0 then
    return new;
  end if;
  v_value := v_line.quantity * v_line.prix_vente_unitaire;
  if v_value <= 0 then
    return new;
  end if;
  -- The returned units, less the share of the line that was offered.
  v_cap := round(
    coalesce(new.quantity, 1) * v_line.prix_vente_unitaire * (1 - least(v_line.offert_montant / v_value, 1)),
    2
  );
  if coalesce(new.montant, 0) > v_cap then
    raise exception 'This part was offered: refund limited to % EUR.', v_cap;
  end if;
  return new;
end;
$$;

drop trigger if exists sales_returns_offert_guard on public.sales_returns;
create trigger sales_returns_offert_guard
  before insert or update of statut_traitement, montant on public.sales_returns
  for each row execute function public.sales_returns_offert_guard();

notify pgrst, 'reload schema';
