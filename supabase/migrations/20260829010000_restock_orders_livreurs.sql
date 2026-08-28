-- ============================================================================
--  Stock re-orders are their own orders + livreurs (delivery drivers).
--
--  1) A part sold from the shelf and re-ordered from a supplier used to be
--     re-ordered ON THE CLIENT'S LINE (supplier_id set on the sale line), so
--     the replenishment stayed linked to the client. Replenishments are now a
--     separate "restock order" (orders.is_restock = true, no client) with its
--     own line; the sale line keeps a pointer (restock_line_id) so it leaves
--     the "À recommander" list.
--
--  2) Livreurs: a per-organization list of delivery drivers ("Livreur 1/2/3"
--     by default). A garage / delivery order is dispatched to one of them
--     (orders.livreur_id + delivery_tasks.livreur_id) and then marked
--     delivered. The garagiste portal reads orders.workflow_status:
--       PENDING / TO_COLLECT → en attente de réception / en préparation
--       IN_TRANSIT          → en cours de livraison
--       DELIVERED           → livrée
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Restock orders
-- ---------------------------------------------------------------------------

alter table public.orders
  add column if not exists is_restock boolean not null default false;

alter table public.order_lines
  add column if not exists restock_line_id uuid
    references public.order_lines (id) on delete set null;

create index if not exists idx_order_lines_restock_pending
  on public.order_lines (organization_id, depuis_magasin, supplier_id)
  where restock_line_id is null;

create index if not exists idx_orders_restock
  on public.orders (organization_id, is_restock);

-- ---------------------------------------------------------------------------
-- 2) Livreurs
-- ---------------------------------------------------------------------------

create table if not exists public.livreurs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  phone text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

alter table public.livreurs enable row level security;

drop policy if exists livreurs_staff on public.livreurs;
create policy livreurs_staff on public.livreurs for all
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and public.current_user_client_id() is null
  );

grant select, insert, update, delete on public.livreurs to authenticated;
revoke all on public.livreurs from anon;

alter table public.orders
  add column if not exists livreur_id uuid
    references public.livreurs (id) on delete set null;

alter table public.delivery_tasks
  add column if not exists livreur_id uuid
    references public.livreurs (id) on delete set null;

-- Every organization starts with three drivers; they can be renamed,
-- deactivated or extended from the Livreurs page.
create or replace function public.seed_default_livreurs(p_org uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.livreurs (organization_id, name, sort_order)
  select p_org, 'Livreur ' || n, n
  from generate_series(1, 3) as n
  on conflict (organization_id, name) do nothing;
$$;

create or replace function public.on_organization_created_seed_livreurs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_livreurs(new.id);
  return new;
end;
$$;

drop trigger if exists organizations_seed_livreurs on public.organizations;
create trigger organizations_seed_livreurs
  after insert on public.organizations
  for each row execute function public.on_organization_created_seed_livreurs();

-- Existing organizations.
select public.seed_default_livreurs(o.id) from public.organizations o;

-- ---------------------------------------------------------------------------
-- 3) Tournée helper (same rules as create_order_with_lines)
-- ---------------------------------------------------------------------------

create or replace function public.next_tournee(
  out tour_name text,
  out tour_date date,
  out tour_slot time,
  out delivery_at timestamptz
)
language plpgsql
stable
as $$
declare
  v_local timestamp;
  v_minutes integer;
  v_number integer;
begin
  v_local := timezone('Europe/Paris', now());
  v_minutes := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if v_minutes between 571 and 720 then
    v_number := 2; tour_slot := time '13:00';
  elsif v_minutes between 721 and 870 then
    v_number := 3; tour_slot := time '15:00';
  elsif v_minutes between 871 and 1020 then
    v_number := 4; tour_slot := time '17:30';
  else
    v_number := 1; tour_slot := time '10:00';
  end if;
  tour_date := v_local::date + case when v_number = 1 and v_minutes > 1020 then 1 else 0 end;
  tour_name := format('Tournée %s', v_number);
  delivery_at := (tour_date + tour_slot) at time zone 'Europe/Paris';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Re-order stock parts: ONE restock order for N sale lines, same supplier
-- ---------------------------------------------------------------------------

create or replace function public.reorder_stock_lines(
  p_line_ids uuid[],
  p_supplier_id uuid,
  p_reference_commandes jsonb default '{}'::jsonb
)
returns table (
  order_id uuid,
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
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_ref text;
  v_order_id uuid;
  v_line public.order_lines;
  v_new_id uuid;
  v_count integer := 0;
  v_t record;
  v_tour_id uuid;
  v_ref_cmd text;
begin
  if v_org is null or auth.uid() is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one line.';
  end if;
  if p_supplier_id is null or not exists (
    select 1 from public.suppliers s where s.id = p_supplier_id and s.organization_id = v_org
  ) then
    raise exception 'A supplier from this organization is required.';
  end if;

  select * into v_t from public.next_tournee();

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':orders:' || v_year::text));

  select t.id into v_tour_id
  from public.delivery_tours t
  where t.organization_id = v_org and t.name = v_t.tour_name and t.tour_date = v_t.tour_date
  limit 1;
  if v_tour_id is null then
    insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
    values (v_org, v_t.tour_name, v_t.tour_date, v_t.tour_slot)
    returning id into v_tour_id;
  end if;

  select coalesce(max((regexp_match(o.ref_demande, '(\\d+)$'))[1]::int), 0) + 1
  into v_seq
  from public.orders o
  where o.organization_id = v_org and o.ref_demande like format('REQ-%s-%%', v_year);
  v_ref := format('REQ-%s-%s', v_year, lpad(v_seq::text, 5, '0'));

  insert into public.orders (
    organization_id, ref_demande, date_commande, vendeur_id, canal_vente,
    client_id, client_phone, montant_total, devis, statut_paiement,
    montant_paye, avance_payee, solde_restant, envoyer_au_livreur,
    statut_livreur, workflow_status, is_restock
  ) values (
    v_org, v_ref, timezone('Europe/Paris', now())::date, auth.uid(),
    'MAGASIN'::public.orders_canal_vente_enum,
    null, '-', 0, false, 'PAYÉ'::public.orders_statut_paiement_enum,
    0, 0, 0, false,
    'EN_ATTENTE', 'PENDING'::public.orders_workflow_status_enum, true
  ) returning orders.id into v_order_id;

  for v_line in
    select *
    from public.order_lines l
    where l.id = any(p_line_ids) and l.organization_id = v_org
    for update
  loop
    v_count := v_count + 1;
    if not v_line.depuis_magasin or v_line.supplier_id is not null then
      raise exception 'Reference % is not a stock sale.', v_line.reference;
    end if;
    if v_line.restock_line_id is not null then
      raise exception 'Reference % has already been re-ordered.', v_line.reference;
    end if;

    v_ref_cmd := nullif(trim(coalesce(p_reference_commandes ->> (v_line.id::text), '')), '');

    insert into public.order_lines (
      organization_id, order_id, nom_produit, reference, reference_commande,
      supplier_id, quantity, a_commander_pour_livreur, depuis_magasin,
      retour_stock_fait, retour_impossible, consigne, consigne_price,
      qte_remise, prix_achat_unitaire, prix_vente_unitaire, tour_id,
      qte_recue, reception_status, prevue_le, origine
    ) values (
      v_org, v_order_id, v_line.nom_produit, v_line.reference, v_ref_cmd,
      p_supplier_id, v_line.quantity, true, true,
      false, false, false, null,
      0, v_line.prix_achat_unitaire, v_line.prix_vente_unitaire, v_tour_id,
      0, 'PENDING'::public.reception_status, v_t.delivery_at, 'stock'
    ) returning order_lines.id into v_new_id;

    update public.order_lines set restock_line_id = v_new_id where id = v_line.id;
  end loop;

  if v_count <> array_length(p_line_ids, 1) then
    raise exception 'One or more selected lines were not found.';
  end if;

  return query select v_order_id, v_ref, v_t.tour_name, v_t.delivery_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Dispatch an order to a livreur / mark it delivered
-- ---------------------------------------------------------------------------

create or replace function public.dispatch_order_to_livreur(
  p_order_id uuid,
  p_livreur_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_livreur_id is null or not exists (
    select 1 from public.livreurs l
    where l.id = p_livreur_id and l.organization_id = v_org and l.active
  ) then
    raise exception 'An active livreur from this organization is required.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and devis = false
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.workflow_status = 'DELIVERED'::public.orders_workflow_status_enum then
    raise exception 'This order has already been delivered.';
  end if;

  update public.orders
  set livreur_id = p_livreur_id,
      envoyer_au_livreur = true,
      workflow_status = 'IN_TRANSIT'::public.orders_workflow_status_enum,
      statut_livreur = 'EN_COURS'::public.orders_statut_livreur_enum,
      date_envoi = coalesce(date_envoi, now()),
      updated_at = now()
  where id = v_order.id;

  if exists (select 1 from public.delivery_tasks t where t.order_id = v_order.id) then
    update public.delivery_tasks
    set livreur_id = p_livreur_id,
        workflow_status = 'IN_TRANSIT'::public.delivery_tasks_workflow_status_enum,
        updated_at = now()
    where order_id = v_order.id;
  else
    insert into public.delivery_tasks (organization_id, order_id, workflow_status, livreur_id)
    values (v_org, v_order.id, 'IN_TRANSIT'::public.delivery_tasks_workflow_status_enum, p_livreur_id);
  end if;
end;
$$;

create or replace function public.mark_order_delivered(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and devis = false
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;

  update public.orders
  set workflow_status = 'DELIVERED'::public.orders_workflow_status_enum,
      statut_livreur = 'LIVRÉ'::public.orders_statut_livreur_enum,
      updated_at = now()
  where id = v_order.id;

  update public.delivery_tasks
  set workflow_status = 'DELIVERED'::public.delivery_tasks_workflow_status_enum,
      updated_at = now()
  where order_id = v_order.id;
end;
$$;

grant execute on function public.next_tournee() to authenticated;
grant execute on function public.reorder_stock_lines(uuid[], uuid, jsonb) to authenticated;
grant execute on function public.dispatch_order_to_livreur(uuid, uuid) to authenticated;
grant execute on function public.mark_order_delivered(uuid) to authenticated;

revoke execute on function public.seed_default_livreurs(uuid) from public, anon, authenticated;
revoke execute on function public.on_organization_created_seed_livreurs() from public, anon, authenticated;
revoke execute on function public.next_tournee() from public, anon;
revoke execute on function public.reorder_stock_lines(uuid[], uuid, jsonb) from public, anon;
revoke execute on function public.dispatch_order_to_livreur(uuid, uuid) from public, anon;
revoke execute on function public.mark_order_delivered(uuid) from public, anon;

notify pgrst, 'reload schema';
