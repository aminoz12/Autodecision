-- ============================================================================
--  Client returns are settled between the CLIENT (particulier or garage) and
--  the MAGASIN — a refund or an avoir — not through the supplier pipeline.
--
--  settle_client_return(return, mode, amount, reason):
--    REMBOURSEMENT → statut_traitement = REMBOURSE, montant = amount
--    AVOIR         → credit note AV-YYYY-NNNNN for the client (+1 year),
--                    statut_traitement = AVOIR, montant = amount
--  Allowed from any non-final state; final states (REMBOURSE, AVOIR, REFUSE)
--  cannot be settled twice. The supplier pipeline (set_return_treatment)
--  remains available for stock parts sent back to a supplier.
-- ============================================================================

create or replace function public.settle_client_return(
  p_return_id uuid,
  p_mode text,
  p_amount numeric,
  p_reason text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_return public.sales_returns;
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_num text;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
begin
  if v_org is null or public.current_user_client_id() is not null then
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
$$;

grant execute on function public.settle_client_return(uuid, text, numeric, text) to authenticated;
revoke execute on function public.settle_client_return(uuid, text, numeric, text) from public, anon;

notify pgrst, 'reload schema';
