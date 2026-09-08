-- Payments & cash journal (audit 2026-09-07, chantier 2 + 5).
--
--  * payments            — every euro that moves: encaissement d'une commande,
--                          règlement d'un compte garage, remboursement d'un retour.
--  * payment_allocations — which orders a payment settles (a garage payment can
--                          cover several orders, FIFO by échéance).
--  * cash_sessions       — journée de caisse: fond de caisse, clôture (Z),
--                          écart. One open session per organisation.
--  RPCs: record_order_payment, settle_client_account, open_cash_session,
--        close_cash_session. settle_client_return now records cash refunds.
--  orders.montant_paye / solde_restant / statut_paiement are updated ONLY here
--  (direct writes were revoked in 20260908010000).

create table if not exists public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  opened_at timestamptz not null default now(),
  opened_by uuid references auth.users (id) on delete set null,
  opening_float numeric(14,2) not null default 0,
  closed_at timestamptz,
  closed_by uuid references auth.users (id) on delete set null,
  expected_cash numeric(14,2),
  counted_cash numeric(14,2),
  difference numeric(14,2),
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists cash_sessions_one_open_idx
  on public.cash_sessions (organization_id) where closed_at is null;
create index if not exists cash_sessions_org_opened_idx
  on public.cash_sessions (organization_id, opened_at desc);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  order_id uuid references public.orders (id) on delete set null,
  return_id uuid references public.sales_returns (id) on delete set null,
  session_id uuid references public.cash_sessions (id) on delete set null,
  kind text not null check (kind in ('ENCAISSEMENT', 'REGLEMENT_COMPTE', 'REMBOURSEMENT')),
  mode text not null check (mode in ('ESPECES', 'CARTE', 'VIREMENT', 'CHEQUE')),
  amount numeric(14,2) not null check (amount > 0),
  reference text,
  note text,
  received_at timestamptz not null default now(),
  received_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists payments_org_received_idx on public.payments (organization_id, received_at desc);
create index if not exists payments_org_client_idx on public.payments (organization_id, client_id);
create index if not exists payments_org_order_idx on public.payments (organization_id, order_id);
create index if not exists payments_session_idx on public.payments (session_id);

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  payment_id uuid not null references public.payments (id) on delete cascade,
  order_id uuid not null references public.orders (id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
create index if not exists payment_allocations_payment_idx on public.payment_allocations (payment_id);
create index if not exists payment_allocations_order_idx on public.payment_allocations (order_id);

alter table public.cash_sessions enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;

drop policy if exists cash_sessions_select on public.cash_sessions;
create policy cash_sessions_select on public.cash_sessions for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.is_counter_staff()
  );
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and (
      public.is_counter_staff()
      or (public.current_user_client_id() is not null and client_id = public.current_user_client_id())
    )
  );
drop policy if exists payment_allocations_select on public.payment_allocations;
create policy payment_allocations_select on public.payment_allocations for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and (
      public.is_counter_staff()
      or exists (
        select 1 from public.payments p
        where p.id = payment_allocations.payment_id
          and p.client_id = public.current_user_client_id()
      )
    )
  );
revoke all on public.cash_sessions, public.payments, public.payment_allocations from public, anon, authenticated;
grant select on public.cash_sessions, public.payments, public.payment_allocations to authenticated;

do $$
declare t text;
begin
  foreach t in array array['payments','payment_allocations','cash_sessions'] loop
    execute format('drop trigger if exists audit_%s on public.%I', t, t);
    execute format('create trigger audit_%s after insert or update or delete on public.%I for each row execute function public.audit_row()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Helpers (internal, not granted)
-- ---------------------------------------------------------------------
create or replace function public.current_cash_session(p_org uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from public.cash_sessions s
  where s.organization_id = p_org and s.closed_at is null
  limit 1;
$$;
revoke execute on function public.current_cash_session(uuid) from public, anon, authenticated;

/* Apply an allocated amount to an order's balance. Caller holds the row lock. */
create or replace function public.apply_payment_to_order(p_order_id uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_new_solde numeric;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  v_new_solde := greatest(0, round(v_order.solde_restant - p_amount, 2));
  update public.orders
  set montant_paye = round(montant_paye + p_amount, 2),
      solde_restant = v_new_solde,
      statut_paiement = case when v_new_solde <= 0 then 'PAYÉ'::public.orders_statut_paiement_enum
                             else 'PARTIEL'::public.orders_statut_paiement_enum end,
      updated_at = now()
  where id = p_order_id;
end;
$$;
revoke execute on function public.apply_payment_to_order(uuid, numeric) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Encaisser une commande
-- ---------------------------------------------------------------------
create or replace function public.record_order_payment(
  p_order_id uuid,
  p_amount numeric,
  p_mode text,
  p_reference text default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_amount numeric := round(coalesce(p_amount, 0), 2);
  v_payment uuid;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  if p_mode not in ('ESPECES', 'CARTE', 'VIREMENT', 'CHEQUE') then
    raise exception 'Invalid payment mode.';
  end if;
  if v_amount <= 0 then
    raise exception 'Amount must be positive.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.devis or v_order.is_restock then
    raise exception 'Only a confirmed client order can be paid.';
  end if;
  if v_order.solde_restant <= 0 then
    raise exception 'Nothing left to pay on this order.';
  end if;
  if v_amount > v_order.solde_restant then
    raise exception 'Amount exceeds the balance (max % EUR).', v_order.solde_restant;
  end if;

  insert into public.payments (
    organization_id, client_id, order_id, session_id, kind, mode, amount,
    reference, note, received_by
  ) values (
    v_org, v_order.client_id, v_order.id, public.current_cash_session(v_org),
    'ENCAISSEMENT', p_mode, v_amount,
    nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), ''), auth.uid()
  ) returning id into v_payment;

  insert into public.payment_allocations (organization_id, payment_id, order_id, amount)
  values (v_org, v_payment, v_order.id, v_amount);

  perform public.apply_payment_to_order(v_order.id, v_amount);
  return v_payment;
end;
$$;
revoke execute on function public.record_order_payment(uuid, numeric, text, text, text) from public, anon;
grant execute on function public.record_order_payment(uuid, numeric, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Règlement d'un compte client / garage (FIFO par échéance)
-- ---------------------------------------------------------------------
create or replace function public.settle_client_account(
  p_client_id uuid,
  p_amount numeric,
  p_mode text,
  p_reference text default null,
  p_note text default null,
  p_order_ids uuid[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  return jsonb_build_object('payment_id', v_payment, 'amount', v_amount, 'allocations', v_allocs);
end;
$$;
revoke execute on function public.settle_client_account(uuid, numeric, text, text, text, uuid[]) from public, anon;
grant execute on function public.settle_client_account(uuid, numeric, text, text, text, uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- Journée de caisse
-- ---------------------------------------------------------------------
create or replace function public.open_cash_session(p_opening_float numeric default 0)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_id uuid;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  v_id := public.current_cash_session(v_org);
  if v_id is not null then
    return v_id;
  end if;
  insert into public.cash_sessions (organization_id, opened_by, opening_float)
  values (v_org, auth.uid(), greatest(round(coalesce(p_opening_float, 0), 2), 0))
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.open_cash_session(numeric) from public, anon;
grant execute on function public.open_cash_session(numeric) to authenticated;

create or replace function public.close_cash_session(p_counted_cash numeric, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_session public.cash_sessions;
  v_in numeric := 0;
  v_out numeric := 0;
  v_expected numeric;
  v_counted numeric := round(coalesce(p_counted_cash, 0), 2);
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  select * into v_session
  from public.cash_sessions
  where organization_id = v_org and closed_at is null
  for update;
  if not found then
    raise exception 'No open cash session.';
  end if;

  select coalesce(sum(case when kind <> 'REMBOURSEMENT' then amount else 0 end), 0),
         coalesce(sum(case when kind = 'REMBOURSEMENT' then amount else 0 end), 0)
  into v_in, v_out
  from public.payments
  where session_id = v_session.id and mode = 'ESPECES';

  v_expected := round(v_session.opening_float + v_in - v_out, 2);
  update public.cash_sessions
  set closed_at = now(),
      closed_by = auth.uid(),
      expected_cash = v_expected,
      counted_cash = v_counted,
      difference = round(v_counted - v_expected, 2),
      note = nullif(trim(coalesce(p_note, '')), '')
  where id = v_session.id;

  return jsonb_build_object(
    'id', v_session.id, 'opening_float', v_session.opening_float,
    'cash_in', v_in, 'cash_out', v_out, 'expected', v_expected,
    'counted', v_counted, 'difference', round(v_counted - v_expected, 2)
  );
end;
$$;
revoke execute on function public.close_cash_session(numeric, text) from public, anon;
grant execute on function public.close_cash_session(numeric, text) to authenticated;

-- ---------------------------------------------------------------------
-- settle_client_return: cash refunds go through the journal
-- ---------------------------------------------------------------------
drop function if exists public.settle_client_return(uuid, text, numeric, text);
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

revoke execute on function public.settle_client_return(uuid, text, numeric, text, text) from public, anon;
grant execute on function public.settle_client_return(uuid, text, numeric, text, text) to authenticated;

notify pgrst, 'reload schema';
