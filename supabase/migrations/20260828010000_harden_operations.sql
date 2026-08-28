-- ============================================================================
-- Security and operational integrity hardening.
--
-- All sensitive mutations are performed in PostgreSQL transactions. Browser
-- clients can no longer choose an organization, a role, financial amounts, or
-- a garage workflow state outside the rules enforced below.
-- ============================================================================

-- Keep all reference allocation and tour creation serial per organization.
-- Existing duplicate historical references are intentionally preserved; new
-- rows are allocated under this lock and are therefore collision-free.

-- ---------------------------------------------------------------------------
-- Authentication and tenant isolation
-- ---------------------------------------------------------------------------

-- Only the service-role path may link a newly-created user to an existing
-- organization. User metadata is supplied by the browser and must never be
-- trusted for organization_id, client_id, or role.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org uuid;
  target_client uuid;
  assigned_role public.user_role;
  display text;
  org_name text;
  new_slug text;
begin
  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');

  begin
    target_org := nullif(new.raw_app_meta_data->>'organization_id', '')::uuid;
  exception when others then
    target_org := null;
  end;

  begin
    target_client := nullif(new.raw_app_meta_data->>'client_id', '')::uuid;
  exception when others then
    target_client := null;
  end;

  if target_org is not null then
    if target_client is null or not exists (
      select 1
      from public.clients c
      where c.id = target_client
        and c.organization_id = target_org
        and c.is_garage = true
    ) then
      raise exception 'Invalid garage provisioning metadata.';
    end if;
    -- Garagiste accounts are always external cashiers. The role is fixed here
    -- rather than copied from metadata.
    assigned_role := 'CAISSIER'::public.user_role;
  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
      || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

    insert into public.organizations (name, slug, plan, subscription_status, trial_ends_at)
    values (org_name, new_slug, 'TRIAL', 'trialing', now() + interval '14 days')
    returning id into target_org;
    assigned_role := 'ADMIN'::public.user_role;
  else
    -- There is no safe shared/default organization. A normal sign-up must
    -- create its own organization, while garage accounts are provisioned via
    -- app_metadata by the server-only route.
    raise exception 'Organization name is required for sign-up.';
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Utilisateur'
  );

  insert into public.profiles (user_id, organization_id, display_name, role, client_id)
  values (new.id, target_org, display, assigned_role, target_client)
  on conflict (user_id) do update set
    organization_id = excluded.organization_id,
    display_name = excluded.display_name,
    role = excluded.role,
    client_id = excluded.client_id,
    updated_at = now();

  return new;
end;
$$;

-- The billing screen is a convenience, not a security boundary. Operational
-- tables and write RPCs use this same rule so an expired trial cannot be
-- bypassed through a direct Data API call.
create or replace function public.has_operational_access(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_org = public.current_user_org_id()
    and exists (
      select 1
      from public.organizations o
      where o.id = p_org
        and case
          when lower(o.subscription_status) in
            ('past_due', 'unpaid', 'canceled', 'cancelled', 'incomplete_expired', 'expired')
            then false
          when lower(o.subscription_status) in ('trialing', 'trial')
            then o.trial_ends_at is null or o.trial_ends_at > now()
          else true
        end
    );
$$;

create or replace function public.assert_operational_access(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_operational_access(p_org) then
    raise exception 'Operational access is not available for this subscription.';
  end if;
end;
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (
    user_id = auth.uid()
    or (
      organization_id = public.current_user_org_id()
      and public.current_user_client_id() is null
    )
  );

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_role() = 'ADMIN'::public.user_role
  )
  with check (organization_id = public.current_user_org_id());

-- Garagistes can read only their own operational records. They have no direct
-- write policy: quote, acceptance, and return requests use validated RPCs.
drop policy if exists clients_all on public.clients;
create policy clients_select on public.clients for select
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null or id = public.current_user_client_id())
  );
create policy clients_write_staff on public.clients for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists orders_select on public.orders;
drop policy if exists orders_insert on public.orders;
drop policy if exists orders_update on public.orders;
drop policy if exists orders_delete on public.orders;
create policy orders_select on public.orders for select
  using (
    organization_id = public.current_user_org_id()
    and (
      public.current_user_client_id() is null
      or client_id = public.current_user_client_id()
    )
  );
create policy orders_write_staff on public.orders for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists order_lines_all on public.order_lines;
create policy order_lines_select on public.order_lines for select
  using (
    organization_id = public.current_user_org_id()
    and (
      public.current_user_client_id() is null
      or exists (
        select 1
        from public.orders o
        where o.id = order_lines.order_id
          and o.organization_id = public.current_user_org_id()
          and o.client_id = public.current_user_client_id()
      )
    )
  );
create policy order_lines_write_staff on public.order_lines for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists returns_all on public.sales_returns;
drop policy if exists sales_returns_all on public.sales_returns;
create policy sales_returns_select on public.sales_returns for select
  using (
    organization_id = public.current_user_org_id()
    and (
      public.current_user_client_id() is null
      or client_id = public.current_user_client_id()
    )
  );

drop policy if exists credits_all on public.credit_notes;
drop policy if exists credit_notes_all on public.credit_notes;
create policy credit_notes_select on public.credit_notes for select
  using (
    organization_id = public.current_user_org_id()
    and (
      public.current_user_client_id() is null
      or client_id = public.current_user_client_id()
    )
  );

drop policy if exists consign_all on public.consignment_entries;
drop policy if exists consignment_entries_all on public.consignment_entries;
create policy consignment_entries_select on public.consignment_entries for select
  using (
    organization_id = public.current_user_org_id()
    and (
      public.current_user_client_id() is null
      or client_id = public.current_user_client_id()
    )
  );

-- The legacy policies below were organization-wide, so a garage login could
-- still read or mutate stock, tours, suppliers, and delivery work directly.
-- Staff retain their dashboard access; garage accounts use scoped RPCs only.
drop policy if exists delivery_tasks_all on public.delivery_tasks;
drop policy if exists delivery_all on public.delivery_tasks;
create policy delivery_tasks_staff on public.delivery_tasks for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists delivery_tours_all on public.delivery_tours;
create policy delivery_tours_staff on public.delivery_tours for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists stock_all on public.stock_items;
drop policy if exists stock_items_all on public.stock_items;
create policy stock_items_staff on public.stock_items for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists suppliers_all on public.suppliers;
create policy suppliers_staff on public.suppliers for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists receptions_all on public.supplier_receptions;
drop policy if exists supplier_receptions_all on public.supplier_receptions;
create policy supplier_receptions_staff on public.supplier_receptions for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

drop policy if exists sms_notifications_all on public.sms_notifications;
create policy sms_notifications_staff on public.sms_notifications for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

-- Some earlier deployments do not include the legacy vehicles table.
-- Keep the migration compatible with both schema variants.
do $$
begin
  if to_regclass('public.vehicles') is not null then
    drop policy if exists vehicles_all on public.vehicles;
    create policy vehicles_staff on public.vehicles for all
      using (
        organization_id = public.current_user_org_id()
        and public.current_user_client_id() is null
      )
      with check (
        organization_id = public.current_user_org_id()
        and public.current_user_client_id() is null
      );
  end if;
end;
$$;

drop policy if exists quotes_all on public.quotes;
create policy quotes_staff on public.quotes for all
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
    and created_by_id = auth.uid()
  );

-- Keep data access in sync with BillingGate. Organization/profile reads are
-- deliberately left available so the locked settings and account screens can
-- still render, but all operational records are unavailable.
alter policy clients_select on public.clients using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.current_user_client_id() is null or id = public.current_user_client_id())
);
alter policy clients_write_staff on public.clients using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);

alter policy orders_select on public.orders using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
);
alter policy orders_write_staff on public.orders using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);

alter policy order_lines_select on public.order_lines using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (
    public.current_user_client_id() is null
    or exists (
      select 1 from public.orders o
      where o.id = order_lines.order_id
        and o.organization_id = public.current_user_org_id()
        and o.client_id = public.current_user_client_id()
    )
  )
);
alter policy order_lines_write_staff on public.order_lines using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);

alter policy sales_returns_select on public.sales_returns using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
);
alter policy credit_notes_select on public.credit_notes using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
);
alter policy consignment_entries_select on public.consignment_entries using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.current_user_client_id() is null or client_id = public.current_user_client_id())
);

alter policy delivery_tasks_staff on public.delivery_tasks using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);
alter policy delivery_tours_staff on public.delivery_tours using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);
alter policy stock_items_staff on public.stock_items using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);
alter policy suppliers_staff on public.suppliers using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);
alter policy supplier_receptions_staff on public.supplier_receptions using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);
alter policy sms_notifications_staff on public.sms_notifications using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
);
do $$
begin
  if to_regclass('public.vehicles') is not null then
    alter policy vehicles_staff on public.vehicles using (
      organization_id = public.current_user_org_id()
      and public.has_operational_access(organization_id)
      and public.current_user_client_id() is null
    ) with check (
      organization_id = public.current_user_org_id()
      and public.has_operational_access(organization_id)
      and public.current_user_client_id() is null
    );
  end if;
end;
$$;
alter policy quotes_staff on public.quotes using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_client_id() is null
  and created_by_id = auth.uid()
);
alter policy invitations_admin on public.invitations using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_role() = 'ADMIN'::public.user_role
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.current_user_role() = 'ADMIN'::public.user_role
);

-- Billing fields must only be updated by a server-side payment integration.
-- The public settings RPC below exposes the four non-billing fields used by
-- the dashboard.
revoke insert, update, delete on public.organizations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Safe helpers for staff-only status changes
-- ---------------------------------------------------------------------------

create or replace function public.update_organization_settings(
  p_name text,
  p_phone text,
  p_address text,
  p_city text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  if v_org is null or public.current_user_role() <> 'ADMIN'::public.user_role
    or public.current_user_client_id() is not null then
    raise exception 'Only an organization administrator may update settings.';
  end if;
  if nullif(trim(p_name), '') is null then
    raise exception 'Organization name is required.';
  end if;

  update public.organizations
  set name = trim(p_name),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      address = nullif(trim(coalesce(p_address, '')), ''),
      city = nullif(trim(coalesce(p_city, '')), '')
  where id = v_org;
end;
$$;

create or replace function public.set_order_line_handed_over(
  p_line_id uuid,
  p_quantity integer
)
returns public.order_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_line
  from public.order_lines
  where id = p_line_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order line not found.';
  end if;

  update public.order_lines
  set qte_remise = least(quantity, greatest(0, coalesce(p_quantity, 0))),
      remise_at = case when greatest(0, coalesce(p_quantity, 0)) > 0 then now() else null end
  where id = v_line.id
  returning * into v_line;
  return v_line;
end;
$$;

create or replace function public.set_order_line_reception_status(
  p_line_id uuid,
  p_status public.reception_status
)
returns public.order_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_status not in ('BACKORDER'::public.reception_status, 'NOT_RECEIVED'::public.reception_status) then
    raise exception 'Use receive_order_line to mark a line as received.';
  end if;

  update public.order_lines
  set reception_status = p_status
  where id = p_line_id and organization_id = v_org
  returning * into v_line;
  if not found then
    raise exception 'Order line not found.';
  end if;
  return v_line;
end;
$$;

create or replace function public.set_consignment_status(
  p_entry_id uuid,
  p_status text
)
returns public.consignment_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_entry public.consignment_entries;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_status not in ('ACTIF', 'RENDUE') then
    raise exception 'Invalid consignment status.';
  end if;

  update public.consignment_entries
  set status = p_status
  where id = p_entry_id and organization_id = v_org
  returning * into v_entry;
  if not found then
    raise exception 'Consignment entry not found.';
  end if;
  return v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- Stock reception and adjustments
-- ---------------------------------------------------------------------------

create or replace function public.adjust_stock_item(
  p_sku text,
  p_name text,
  p_delta integer
)
returns public.stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_result public.stock_items;
  v_sku text := nullif(trim(p_sku), '');
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if v_sku is null then
    raise exception 'SKU is required.';
  end if;

  insert into public.stock_items (organization_id, sku, name, quantity_on_hand)
  values (v_org, v_sku, coalesce(nullif(trim(p_name), ''), v_sku), greatest(coalesce(p_delta, 0), 0))
  on conflict (organization_id, sku) do update
    set quantity_on_hand = greatest(0, public.stock_items.quantity_on_hand + coalesce(p_delta, 0)),
        name = coalesce(nullif(trim(p_name), ''), public.stock_items.name),
        updated_at = now()
  returning * into v_result;
  return v_result;
end;
$$;

create or replace function public.receive_order_line(
  p_line_id uuid
)
returns public.order_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
  v_result public.order_lines;
  v_qty integer;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_line
  from public.order_lines
  where id = p_line_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order line not found.';
  end if;

  v_qty := greatest(v_line.quantity - v_line.qte_recue, 0);
  update public.order_lines
  set qte_recue = quantity,
      reception_status = 'RECEIVED',
      received_at = now(),
      retour_stock_fait = case when v_line.depuis_magasin then true else retour_stock_fait end
  where id = v_line.id
  returning * into v_result;

  -- Only replenishment lines belong in stock. A supplier delivery made for a
  -- named customer is fulfilled to that customer, not added to inventory.
  if v_qty > 0 and v_line.depuis_magasin then
    insert into public.stock_items (organization_id, sku, name, quantity_on_hand)
    values (v_org, v_line.reference, v_line.nom_produit, v_qty)
    on conflict (organization_id, sku) do update
      set quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
          name = coalesce(public.stock_items.name, excluded.name),
          updated_at = now();
  end if;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Credit notes and returns
-- ---------------------------------------------------------------------------

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
      updated_at = now()
  where id = v_order.id;

  return v_remaining - p_amount;
end;
$$;

create or replace function public.create_walk_in_return(
  p_order_id uuid,
  p_line_ids uuid[],
  p_reason text,
  p_compensation text,
  p_supplier_id uuid default null
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
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if coalesce(array_length(p_line_ids, 1), 0) = 0 then
    raise exception 'Select at least one line.';
  end if;
  if p_compensation not in ('REMBOURSEMENT', 'AVOIR', 'FOURNISSEUR') then
    raise exception 'Invalid return compensation.';
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
  select coalesce(max((regexp_match(ref, '(\\d+)$'))[1]::int), 0) + 1
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
    if exists (
      select 1 from public.sales_returns r where r.order_line_id = v_line.id
    ) then
      raise exception 'This order line has already been returned.';
    end if;

    v_ref := format('RET-%s-%s', v_year, lpad(v_return_seq::text, 5, '0'));
    v_return_seq := v_return_seq + 1;
    v_total := v_total + v_line.quantity * v_line.prix_vente_unitaire;

    insert into public.sales_returns (
      organization_id, client_id, order_id, order_line_id, ref, designation,
      reason, motif, type_retour, statut_traitement, decote_pct, montant, supplier_id
    ) values (
      v_org, v_order.client_id, v_order.id, v_line.id, v_ref, v_line.nom_produit,
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      coalesce(nullif(trim(p_reason), ''), 'Retour client'),
      'RETOURNABLE',
      case when p_compensation = 'FOURNISSEUR' then 'A_TRAITER'::public.return_treatment
           when p_compensation = 'AVOIR' then 'AVOIR'::public.return_treatment
           else 'REMBOURSE'::public.return_treatment end,
      0, v_line.quantity * v_line.prix_vente_unitaire,
      case when p_compensation = 'FOURNISSEUR' then p_supplier_id else null end
    );
  end loop;

  if v_count <> array_length(p_line_ids, 1) then
    raise exception 'One or more selected lines do not belong to this order.';
  end if;

  if p_compensation <> 'AVOIR' then
    return null;
  end if;

  select coalesce(max((regexp_match(num, '(\\d+)$'))[1]::int), 0) + 1
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

create or replace function public.request_garage_return(
  p_order_id uuid,
  p_designation text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_year integer := extract(year from current_date);
  v_seq integer;
begin
  if v_org is null or v_client is null then
    raise exception 'Garage access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if nullif(trim(p_designation), '') is null or nullif(trim(p_reason), '') is null then
    raise exception 'Designation and reason are required.';
  end if;
  if p_order_id is not null and not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.organization_id = v_org and o.client_id = v_client
  ) then
    raise exception 'Order not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':returns:' || v_year::text));
  select coalesce(max((regexp_match(ref, '(\\d+)$'))[1]::int), 0) + 1 into v_seq
  from public.sales_returns
  where organization_id = v_org and ref like format('RET-%s-%%', v_year);

  insert into public.sales_returns (
    organization_id, client_id, order_id, ref, designation, reason, motif,
    type_retour, statut_traitement, decote_pct, montant
  ) values (
    v_org, v_client, p_order_id,
    format('RET-%s-%s', v_year, lpad(v_seq::text, 5, '0')),
    trim(p_designation), trim(p_reason), trim(p_reason), 'RETOURNABLE',
    'A_TRAITER', 0, 0
  );
end;
$$;

-- A supplier return may only progress through its defined state machine.
-- Cash refunds and avoirs are terminal states created atomically above and
-- therefore cannot be retroactively rewritten from the browser.
create or replace function public.set_return_treatment(
  p_return_id uuid,
  p_treatment public.return_treatment
)
returns public.sales_returns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_return public.sales_returns;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_return
  from public.sales_returns
  where id = p_return_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Return not found.';
  end if;

  if not (
    (v_return.statut_traitement = 'A_TRAITER'::public.return_treatment
      and p_treatment = 'DEMANDE_ENVOYEE'::public.return_treatment)
    or (v_return.statut_traitement = 'DEMANDE_ENVOYEE'::public.return_treatment
      and p_treatment = 'A_RECUPERER'::public.return_treatment)
    or (v_return.statut_traitement = 'A_RECUPERER'::public.return_treatment
      and p_treatment in ('ACCEPTE'::public.return_treatment, 'REFUSE'::public.return_treatment))
    or (v_return.statut_traitement = 'ACCEPTE'::public.return_treatment
      and p_treatment = 'REMBOURSE'::public.return_treatment)
  ) then
    raise exception 'Invalid return treatment transition.';
  end if;

  update public.sales_returns
  set statut_traitement = p_treatment
  where id = v_return.id
  returning * into v_return;
  return v_return;
end;
$$;

-- ---------------------------------------------------------------------------
-- Atomic order creation and garage quote lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.create_order_with_lines(p_payload jsonb)
returns table (
  id uuid,
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
  v_client uuid := public.current_user_client_id();
  v_is_garage boolean := v_client is not null;
  v_order_id uuid;
  v_ref text;
  v_year integer := extract(year from current_date);
  v_ref_seq integer;
  v_total numeric := 0;
  v_paid numeric := greatest(coalesce((p_payload->>'montant_paye')::numeric, 0), 0);
  v_advance numeric := greatest(coalesce((p_payload->>'avance_payee')::numeric, 0), 0);
  v_remaining numeric;
  v_order_client uuid;
  v_line jsonb;
  v_qty integer;
  v_sale numeric;
  v_purchase numeric;
  v_consigne numeric;
  v_from_stock boolean;
  v_supplier uuid;
  v_is_consigne boolean;
  v_order_is_devis boolean;
  v_send_delivery boolean;
  v_tour_name text := null;
  v_delivery_at timestamptz := null;
  v_tour_date date;
  v_tour_slot time;
  v_tour_id uuid := null;
  v_local timestamp;
  v_minutes integer;
  v_tour_number integer;
  v_credit_id uuid;
  v_credit_amount numeric;
  v_consigne_seq integer;
  v_line_id uuid;
begin
  if v_org is null or auth.uid() is null then
    raise exception 'Authenticated organization access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if jsonb_typeof(p_payload->'lines') <> 'array' or jsonb_array_length(p_payload->'lines') = 0 then
    raise exception 'At least one order line is required.';
  end if;

  v_order_is_devis := case when v_is_garage then true else coalesce((p_payload->>'devis')::boolean, false) end;
  v_send_delivery := case when v_is_garage then false else coalesce((p_payload->>'envoyer_au_livreur')::boolean, false) end;

  if v_is_garage then
    v_order_client := v_client;
    v_paid := 0;
    v_advance := 0;
  else
    begin
      v_order_client := nullif(p_payload->>'client_id', '')::uuid;
    exception when others then
      v_order_client := null;
    end;
    if v_order_client is not null and not exists (
      select 1 from public.clients c where c.id = v_order_client and c.organization_id = v_org
    ) then
      raise exception 'Client does not belong to this organization.';
    end if;
  end if;

  -- Validate every line before creating the order.
  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    if nullif(trim(v_line->>'nom_produit'), '') is null or nullif(trim(v_line->>'reference'), '') is null then
      raise exception 'Each line needs a designation and a reference.';
    end if;
    v_qty := coalesce((v_line->>'quantity')::integer, 0);
    if v_qty <= 0 then
      raise exception 'Line quantity must be positive.';
    end if;
    v_sale := greatest(coalesce((v_line->>'prix_vente_unitaire')::numeric, 0), 0);
    v_consigne := case when coalesce((v_line->>'consigne')::boolean, false)
      then greatest(coalesce((v_line->>'consigne_price')::numeric, 0), 0)
      else 0 end;
    if not v_is_garage then
      v_total := v_total + v_qty * (v_sale + v_consigne);
    end if;
  end loop;

  if v_paid + v_advance > v_total then
    raise exception 'Amounts paid cannot exceed the order total.';
  end if;
  v_remaining := greatest(0, v_total - v_paid - v_advance);

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':orders:' || v_year::text));
  select coalesce(max((regexp_match(o.ref_demande, '(\\d+)$'))[1]::int), 0) + 1
  into v_ref_seq
  from public.orders o
  where o.organization_id = v_org and o.ref_demande like format('REQ-%s-%%', v_year);
  v_ref := format('REQ-%s-%s', v_year, lpad(v_ref_seq::text, 5, '0'));

  if not v_order_is_devis then
    v_local := timezone('Europe/Paris', now());
    v_minutes := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
    if v_minutes between 571 and 720 then
      v_tour_number := 2; v_tour_slot := time '13:00';
    elsif v_minutes between 721 and 870 then
      v_tour_number := 3; v_tour_slot := time '15:00';
    elsif v_minutes between 871 and 1020 then
      v_tour_number := 4; v_tour_slot := time '17:30';
    else
      v_tour_number := 1; v_tour_slot := time '10:00';
    end if;
    v_tour_date := v_local::date + case when v_tour_number = 1 and v_minutes > 1020 then 1 else 0 end;
    v_tour_name := format('Tournée %s', v_tour_number);
    v_delivery_at := (v_tour_date + v_tour_slot) at time zone 'Europe/Paris';

    select t.id into v_tour_id
    from public.delivery_tours t
    where t.organization_id = v_org and t.name = v_tour_name and t.tour_date = v_tour_date
    limit 1;
    if v_tour_id is null then
      insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
      values (v_org, v_tour_name, v_tour_date, v_tour_slot)
      returning id into v_tour_id;
    end if;
  end if;

  insert into public.orders (
    organization_id, ref_demande, date_commande, vendeur_id, canal_vente,
    client_id, client_phone, client_email, immatriculation, vehicle_model,
    kilometrage, montant_total, devis, devis_status, statut_paiement,
    montant_paye, avance_payee, solde_restant, envoyer_au_livreur, date_envoi,
    statut_livreur, consigne, workflow_status, bl, date_bl
  ) values (
    v_org, v_ref,
    case when v_is_garage then timezone('Europe/Paris', now())::date
         else coalesce(nullif(p_payload->>'date_commande', '')::date, current_date) end,
    auth.uid(),
    case when v_is_garage then 'B2B'::public.orders_canal_vente_enum
         else (p_payload->>'canal_vente')::public.orders_canal_vente_enum end,
    v_order_client,
    case when v_is_garage then coalesce(nullif(trim(p_payload->>'client_phone'), ''), '-')
         else coalesce(nullif(trim(p_payload->>'client_phone'), ''), '-') end,
    nullif(trim(p_payload->>'client_email'), ''),
    nullif(trim(p_payload->>'immatriculation'), ''),
    nullif(trim(p_payload->>'vehicle_model'), ''),
    nullif(p_payload->>'kilometrage', '')::integer,
    v_total, v_order_is_devis,
    case when v_is_garage then 'REQUESTED' when v_order_is_devis then nullif(p_payload->>'devis_status', '') else null end,
    case when v_is_garage then 'NON_PAYÉ'::public.orders_statut_paiement_enum
         else (p_payload->>'statut_paiement')::public.orders_statut_paiement_enum end,
    v_paid, v_advance, v_remaining, v_send_delivery, v_delivery_at,
    'EN_ATTENTE', nullif(trim(p_payload->>'consigne'), ''),
    case when v_send_delivery then 'TO_COLLECT'::public.orders_workflow_status_enum else 'PENDING'::public.orders_workflow_status_enum end,
    coalesce((p_payload->>'bl')::boolean, false), nullif(p_payload->>'date_bl', '')::date
  ) returning orders.id into v_order_id;

  select coalesce(max((regexp_match(num, '(\\d+)$'))[1]::int), 0) + 1
  into v_consigne_seq
  from public.consignment_entries
  where organization_id = v_org and num like format('CO-%s-%%', v_year);

  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    v_qty := (v_line->>'quantity')::integer;
    v_purchase := greatest(coalesce((v_line->>'prix_achat_unitaire')::numeric, 0), 0);
    v_sale := case when v_is_garage then 0 else greatest(coalesce((v_line->>'prix_vente_unitaire')::numeric, 0), 0) end;
    v_is_consigne := case when v_is_garage then false else coalesce((v_line->>'consigne')::boolean, false) end;
    v_consigne := case when v_is_consigne then greatest(coalesce((v_line->>'consigne_price')::numeric, 0), 0) else null end;
    v_from_stock := case when v_is_garage then false else coalesce((v_line->>'depuis_magasin')::boolean, false) end;
    begin
      v_supplier := nullif(v_line->>'fournisseur_id', '')::uuid;
    exception when others then
      v_supplier := null;
    end;
    if v_supplier is not null and not exists (
      select 1 from public.suppliers s where s.id = v_supplier and s.organization_id = v_org
    ) then
      raise exception 'Supplier does not belong to this organization.';
    end if;

    insert into public.order_lines (
      organization_id, order_id, nom_produit, reference, supplier_id, quantity,
      a_commander_pour_livreur, depuis_magasin, retour_stock_fait,
      retour_impossible, consigne, consigne_price, qte_remise, remise_at,
      prix_achat_unitaire, prix_vente_unitaire, tour_id, qte_recue,
      reception_status, received_at
    ) values (
      v_org, v_order_id, trim(v_line->>'nom_produit'), trim(v_line->>'reference'), v_supplier, v_qty,
      case when v_is_garage then false else coalesce((v_line->>'a_commander_pour_livreur')::boolean, false) end,
      v_from_stock, false,
      case when v_is_garage then false else coalesce((v_line->>'retour_impossible')::boolean, false) end,
      v_is_consigne, v_consigne,
      least(v_qty, greatest(0, coalesce((v_line->>'qte_remise')::integer, 0))),
      case when coalesce((v_line->>'qte_remise')::integer, 0) > 0 then now() else null end,
      v_purchase, v_sale, v_tour_id,
      case when v_from_stock and v_supplier is null then v_qty else 0 end,
      case when v_from_stock and v_supplier is null then 'RECEIVED'::public.reception_status else 'PENDING'::public.reception_status end,
      case when v_from_stock and v_supplier is null then now() else null end
    ) returning order_lines.id into v_line_id;

    if v_is_consigne then
      insert into public.consignment_entries (
        organization_id, client_id, order_id, order_line_id, num, reference,
        description, quantity, montant, motif, status
      ) values (
        v_org, v_order_client, v_order_id, v_line_id,
        format('CO-%s-%s', v_year, lpad(v_consigne_seq::text, 5, '0')),
        trim(v_line->>'reference'), trim(v_line->>'nom_produit'), v_qty,
        v_qty * v_consigne, 'Consigne pièce', 'ACTIF'
      );
      v_consigne_seq := v_consigne_seq + 1;
    end if;

    -- A shelf sale reserves/leaves stock immediately. This update is atomic
    -- and rejects a concurrent oversell when the SKU is tracked in stock.
    if not v_is_garage and v_from_stock and v_supplier is null then
      update public.stock_items
      set quantity_on_hand = quantity_on_hand - v_qty, updated_at = now()
      where organization_id = v_org
        and sku = trim(v_line->>'reference')
        and quantity_on_hand >= v_qty;
      if not found and exists (
        select 1 from public.stock_items
        where organization_id = v_org and sku = trim(v_line->>'reference')
      ) then
        raise exception 'Insufficient stock for reference %.', trim(v_line->>'reference');
      end if;
    end if;
  end loop;

  if v_send_delivery then
    insert into public.delivery_tasks (organization_id, order_id, workflow_status)
    values (v_org, v_order_id, 'TO_COLLECT');
  end if;

  if not v_is_garage then
    begin
      v_credit_id := nullif(p_payload->>'avoir_id', '')::uuid;
      v_credit_amount := coalesce((p_payload->>'avoir_applique')::numeric, 0);
    exception when others then
      v_credit_id := null;
      v_credit_amount := 0;
    end;
    if v_credit_id is not null and v_credit_amount > 0 then
      perform public.apply_credit_note(v_org, v_credit_id, v_order_id, v_credit_amount);
    end if;
  end if;

  return query select v_order_id, v_ref, v_tour_name, v_delivery_at;
end;
$$;

create or replace function public.resolve_garage_quote(
  p_order_id uuid,
  p_action text
)
returns table (tour_name text, delivery_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_order public.orders;
  v_line public.order_lines;
  v_total numeric := 0;
  v_local timestamp;
  v_minutes integer;
  v_number integer;
  v_date date;
  v_slot time;
  v_name text;
  v_delivery timestamptz;
  v_tour_id uuid;
begin
  if v_org is null or v_client is null then
    raise exception 'Garage access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_action not in ('ACCEPT', 'REFUSE') then
    raise exception 'Invalid quote action.';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and client_id = v_client and devis = true
  for update;
  if not found then
    raise exception 'Quote not found.';
  end if;
  if v_order.devis_status <> 'QUOTED' then
    raise exception 'Only a quoted quote may be accepted or refused.';
  end if;

  if p_action = 'REFUSE' then
    update public.orders set devis_status = 'REFUSED' where id = v_order.id;
    return;
  end if;

  if exists (
    select 1 from public.order_lines l where l.order_id = v_order.id and l.disponible is null
  ) then
    raise exception 'The magasin must answer every requested line first.';
  end if;
  if not exists (
    select 1 from public.order_lines l where l.order_id = v_order.id and l.disponible = true
  ) then
    raise exception 'No line is available to accept.';
  end if;

  v_local := timezone('Europe/Paris', now());
  v_minutes := extract(hour from v_local)::integer * 60 + extract(minute from v_local)::integer;
  if v_minutes between 571 and 720 then
    v_number := 2; v_slot := time '13:00';
  elsif v_minutes between 721 and 870 then
    v_number := 3; v_slot := time '15:00';
  elsif v_minutes between 871 and 1020 then
    v_number := 4; v_slot := time '17:30';
  else
    v_number := 1; v_slot := time '10:00';
  end if;
  v_date := v_local::date + case when v_number = 1 and v_minutes > 1020 then 1 else 0 end;
  v_name := format('Tournée %s', v_number);
  v_delivery := (v_date + v_slot) at time zone 'Europe/Paris';

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':orders:' || extract(year from v_date)::text));
  select id into v_tour_id from public.delivery_tours
  where organization_id = v_org and name = v_name and tour_date = v_date limit 1;
  if v_tour_id is null then
    insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
    values (v_org, v_name, v_date, v_slot)
    returning id into v_tour_id;
  end if;

  for v_line in select * from public.order_lines where order_id = v_order.id for update loop
    if v_line.disponible then
      v_total := v_total + v_line.quantity * v_line.prix_vente_unitaire;
      -- An available quoted part is reserved from the magasin shelf. It is
      -- immediately ready for the garage and must not re-enter stock later.
      update public.order_lines
      set depuis_magasin = true,
          qte_recue = quantity,
          reception_status = 'RECEIVED',
          received_at = now(),
          tour_id = v_tour_id
      where id = v_line.id;
      update public.stock_items
      set quantity_on_hand = quantity_on_hand - v_line.quantity, updated_at = now()
      where organization_id = v_org
        and sku = v_line.reference
        and quantity_on_hand >= v_line.quantity;
      if not found and exists (
        select 1 from public.stock_items
        where organization_id = v_org and sku = v_line.reference
      ) then
        raise exception 'Insufficient stock for reference %.', v_line.reference;
      end if;
    else
      update public.order_lines
      set reception_status = 'NOT_RECEIVED', tour_id = v_tour_id
      where id = v_line.id;
    end if;
  end loop;

  update public.orders
  set devis = false,
      devis_status = 'ACCEPTED',
      montant_total = v_total,
      montant_paye = 0,
      avance_payee = 0,
      solde_restant = v_total,
      envoyer_au_livreur = true,
      workflow_status = 'TO_COLLECT',
      date_envoi = v_delivery
  where id = v_order.id;

  insert into public.delivery_tasks (organization_id, order_id, workflow_status)
  values (v_org, v_order.id, 'TO_COLLECT');

  return query select v_name, v_delivery;
end;
$$;

grant execute on function public.update_organization_settings(text, text, text, text) to authenticated;
grant execute on function public.has_operational_access(uuid) to authenticated;
grant execute on function public.assert_operational_access(uuid) to authenticated;
grant execute on function public.set_order_line_handed_over(uuid, integer) to authenticated;
grant execute on function public.set_order_line_reception_status(uuid, public.reception_status) to authenticated;
grant execute on function public.set_consignment_status(uuid, text) to authenticated;
grant execute on function public.adjust_stock_item(text, text, integer) to authenticated;
grant execute on function public.receive_order_line(uuid) to authenticated;
grant execute on function public.apply_credit_note(uuid, uuid, uuid, numeric) to authenticated;
grant execute on function public.create_walk_in_return(uuid, uuid[], text, text, uuid) to authenticated;
grant execute on function public.request_garage_return(uuid, text, text) to authenticated;
grant execute on function public.set_return_treatment(uuid, public.return_treatment) to authenticated;
grant execute on function public.create_order_with_lines(jsonb) to authenticated;
grant execute on function public.resolve_garage_quote(uuid, text) to authenticated;

-- PostgreSQL grants EXECUTE to PUBLIC by default. These routines are all
-- SECURITY DEFINER, so explicitly remove anonymous/public invocation.
revoke execute on function public.update_organization_settings(text, text, text, text) from public, anon;
revoke execute on function public.has_operational_access(uuid) from public, anon;
revoke execute on function public.assert_operational_access(uuid) from public, anon;
revoke execute on function public.set_order_line_handed_over(uuid, integer) from public, anon;
revoke execute on function public.set_order_line_reception_status(uuid, public.reception_status) from public, anon;
revoke execute on function public.set_consignment_status(uuid, text) from public, anon;
revoke execute on function public.adjust_stock_item(text, text, integer) from public, anon;
revoke execute on function public.receive_order_line(uuid) from public, anon;
revoke execute on function public.apply_credit_note(uuid, uuid, uuid, numeric) from public, anon;
revoke execute on function public.create_walk_in_return(uuid, uuid[], text, text, uuid) from public, anon;
revoke execute on function public.request_garage_return(uuid, text, text) from public, anon;
revoke execute on function public.set_return_treatment(uuid, public.return_treatment) from public, anon;
revoke execute on function public.create_order_with_lines(jsonb) from public, anon;
revoke execute on function public.resolve_garage_quote(uuid, text) from public, anon;
revoke execute on function public.handle_new_user() from public, anon;

notify pgrst, 'reload schema';
