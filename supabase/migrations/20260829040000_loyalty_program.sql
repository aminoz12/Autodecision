-- ============================================================================
--  Fidelity program for walk-in clients ("Clients particuliers").
--
--  Every confirmed, non-restock order of a non-garage client earns
--  1 point per euro of the order total (floor). Points live in
--  loyalty_transactions (kind EARN / REDEEM / BONUS / ADJUST) so the balance
--  and the lifetime total are always auditable. Staff redeem or grant points
--  through adjust_loyalty_points(); garages are outside the program.
-- ============================================================================

create table if not exists public.loyalty_transactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null references public.clients (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  kind text not null check (kind in ('EARN', 'REDEEM', 'BONUS', 'ADJUST')),
  points integer not null,
  reason text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_loyalty_client
  on public.loyalty_transactions (organization_id, client_id, created_at desc);
create unique index if not exists idx_loyalty_earn_per_order
  on public.loyalty_transactions (order_id) where kind = 'EARN';

alter table public.loyalty_transactions enable row level security;
drop policy if exists loyalty_staff_select on public.loyalty_transactions;
create policy loyalty_staff_select on public.loyalty_transactions for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
  );
-- Writes only through the trigger and the RPC below.
grant select on public.loyalty_transactions to authenticated;
revoke all on public.loyalty_transactions from anon;

-- ---------------------------------------------------------------------------
-- Earn points automatically
-- ---------------------------------------------------------------------------

create or replace function public.loyalty_earn_for_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_points integer;
begin
  if new.devis or new.is_restock or new.client_id is null then
    return new;
  end if;
  if exists (
    select 1 from public.loyalty_transactions t where t.order_id = new.id and t.kind = 'EARN'
  ) then
    return new;
  end if;
  if exists (select 1 from public.clients c where c.id = new.client_id and c.is_garage) then
    return new;
  end if;
  v_points := floor(coalesce(new.montant_total, 0))::integer;
  if v_points <= 0 then
    return new;
  end if;
  insert into public.loyalty_transactions (organization_id, client_id, order_id, kind, points, reason, created_by)
  values (new.organization_id, new.client_id, new.id, 'EARN', v_points,
          format('Commande %s', new.ref_demande), new.vendeur_id);
  return new;
end;
$$;

drop trigger if exists orders_loyalty_earn on public.orders;
create trigger orders_loyalty_earn
  after insert or update of devis, client_id, montant_total on public.orders
  for each row execute function public.loyalty_earn_for_order();

-- Backfill existing history.
insert into public.loyalty_transactions (organization_id, client_id, order_id, kind, points, reason, created_by, created_at)
select o.organization_id, o.client_id, o.id, 'EARN', floor(o.montant_total)::integer,
       format('Commande %s', o.ref_demande), o.vendeur_id, o."createdAt"
from public.orders o
join public.clients c on c.id = o.client_id
where o.devis = false and o.is_restock = false and c.is_garage = false
  and floor(o.montant_total) >= 1
  and not exists (select 1 from public.loyalty_transactions t where t.order_id = o.id and t.kind = 'EARN');

-- ---------------------------------------------------------------------------
-- Manual redeem / bonus
-- ---------------------------------------------------------------------------

create or replace function public.adjust_loyalty_points(
  p_client_id uuid,
  p_points integer,
  p_kind text,
  p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_balance integer;
  v_delta integer;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_kind not in ('REDEEM', 'BONUS', 'ADJUST') then
    raise exception 'Invalid loyalty transaction kind.';
  end if;
  if coalesce(p_points, 0) = 0 then
    raise exception 'Points must be non-zero.';
  end if;
  if not exists (
    select 1 from public.clients c
    where c.id = p_client_id and c.organization_id = v_org and c.is_garage = false
  ) then
    raise exception 'Client not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext('loyalty:' || p_client_id::text));
  select coalesce(sum(points), 0) into v_balance
  from public.loyalty_transactions where client_id = p_client_id;

  v_delta := case
    when p_kind = 'REDEEM' then -abs(p_points)
    when p_kind = 'BONUS' then abs(p_points)
    else p_points end;
  if v_balance + v_delta < 0 then
    raise exception 'Insufficient points (balance %).', v_balance;
  end if;

  insert into public.loyalty_transactions (organization_id, client_id, kind, points, reason, created_by)
  values (v_org, p_client_id, p_kind, v_delta, nullif(trim(coalesce(p_reason, '')), ''), auth.uid());
  return v_balance + v_delta;
end;
$$;

grant execute on function public.adjust_loyalty_points(uuid, integer, text, text) to authenticated;
revoke execute on function public.adjust_loyalty_points(uuid, integer, text, text) from public, anon;
revoke execute on function public.loyalty_earn_for_order() from public, anon, authenticated;

notify pgrst, 'reload schema';
