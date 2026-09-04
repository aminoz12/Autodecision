-- ============================================================================
--  Livreur access.
--
--  A driver gets a login linked to a livreurs row (profiles.livreur_id, role
--  LIVREUR), provisioned by the server-only /api/livreur-access route via
--  app_metadata { organization_id, staff_role: 'LIVREUR', livreur_id }.
--
--  RLS: a LIVREUR sees ONLY the orders assigned to them (+ their lines and
--  the client name/phone) — no stock, suppliers, returns, credits, reports…
--  Counter staff = ADMIN/CAISSIER without client_id; every staff policy now
--  uses is_counter_staff() so the LIVREUR role is excluded everywhere else.
--  mark_order_delivered accepts a LIVREUR for their own order.
-- ============================================================================

alter table public.profiles
  add column if not exists livreur_id uuid
    references public.livreurs (id) on delete set null;

create or replace function public.current_user_livreur_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select livreur_id from public.profiles where user_id = auth.uid() limit 1;
$$;

-- ADMIN / CAISSIER at the counter: full operational access.
create or replace function public.is_counter_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.client_id is null
      and p.role in ('ADMIN'::public.user_role, 'CAISSIER'::public.user_role)
      and p.livreur_id is null
  );
$$;

grant execute on function public.current_user_livreur_id() to authenticated;
grant execute on function public.is_counter_staff() to authenticated;
revoke execute on function public.current_user_livreur_id() from public, anon;
revoke execute on function public.is_counter_staff() from public, anon;

-- ---------------------------------------------------------------------------
-- Orders / lines / clients: counter staff full read, livreur scoped read
-- ---------------------------------------------------------------------------

alter policy orders_select on public.orders using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (
    public.is_counter_staff()
    or client_id = public.current_user_client_id()
    or (public.current_user_livreur_id() is not null and livreur_id = public.current_user_livreur_id())
  )
);
alter policy orders_write_staff on public.orders using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);

alter policy order_lines_select on public.order_lines using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (
    public.is_counter_staff()
    or exists (
      select 1 from public.orders o
      where o.id = order_lines.order_id
        and o.organization_id = public.current_user_org_id()
        and (
          o.client_id = public.current_user_client_id()
          or (public.current_user_livreur_id() is not null and o.livreur_id = public.current_user_livreur_id())
        )
    )
  )
);
alter policy order_lines_write_staff on public.order_lines using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);

alter policy clients_select on public.clients using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (
    public.is_counter_staff()
    or id = public.current_user_client_id()
    or (
      public.current_user_livreur_id() is not null
      and exists (
        select 1 from public.orders o
        where o.client_id = clients.id
          and o.organization_id = public.current_user_org_id()
          and o.livreur_id = public.current_user_livreur_id()
      )
    )
  )
);
alter policy clients_write_staff on public.clients using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);

-- ---------------------------------------------------------------------------
-- Everything else: counter staff only (LIVREUR excluded)
-- ---------------------------------------------------------------------------

alter policy delivery_tasks_staff on public.delivery_tasks using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);
alter policy delivery_tours_staff on public.delivery_tours using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);
alter policy stock_items_staff on public.stock_items using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);
alter policy supplier_receptions_staff on public.supplier_receptions using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);
alter policy sms_notifications_staff on public.sms_notifications using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);
alter policy quotes_staff on public.quotes using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
) with check (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
  and created_by_id = auth.uid()
);
alter policy suppliers_select on public.suppliers using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);
alter policy livreurs_select on public.livreurs using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.is_counter_staff() or id = public.current_user_livreur_id())
);
alter policy loyalty_staff_select on public.loyalty_transactions using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);
alter policy sales_returns_select on public.sales_returns using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.is_counter_staff() or client_id = public.current_user_client_id())
);
alter policy credit_notes_select on public.credit_notes using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.is_counter_staff() or client_id = public.current_user_client_id())
);
alter policy consignment_entries_select on public.consignment_entries using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (public.is_counter_staff() or client_id = public.current_user_client_id())
);
alter policy profiles_select on public.profiles using (
  user_id = auth.uid()
  or (
    organization_id = public.current_user_org_id()
    and public.is_counter_staff()
  )
);

-- ---------------------------------------------------------------------------
-- handle_new_user: + LIVREUR branch
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org uuid;
  target_client uuid;
  target_livreur uuid;
  assigned_role public.user_role;
  display text;
  org_name text;
  new_slug text;
  staff_role text;
begin
  if exists (select 1 from public.profiles p where p.user_id = new.id) then
    return new;
  end if;

  org_name := nullif(trim(new.raw_user_meta_data->>'organization_name'), '');
  staff_role := nullif(trim(new.raw_app_meta_data->>'staff_role'), '');

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
  begin
    target_livreur := nullif(new.raw_app_meta_data->>'livreur_id', '')::uuid;
  exception when others then
    target_livreur := null;
  end;

  if target_org is not null then
    if staff_role in ('CAISSIER', 'ADMIN') then
      assigned_role := staff_role::public.user_role;
      target_client := null;
      target_livreur := null;
    elsif staff_role = 'LIVREUR' and target_livreur is not null and exists (
      select 1 from public.livreurs l
      where l.id = target_livreur and l.organization_id = target_org
    ) then
      assigned_role := 'LIVREUR'::public.user_role;
      target_client := null;
    elsif target_client is not null and exists (
      select 1
      from public.clients c
      where c.id = target_client
        and c.organization_id = target_org
        and c.is_garage = true
    ) then
      assigned_role := 'CAISSIER'::public.user_role;
      target_livreur := null;
    else
      return new;
    end if;
  elsif org_name is not null then
    new_slug := lower(regexp_replace(org_name, '[^a-zA-Z0-9]+', '-', 'g'));
    new_slug := trim(both '-' from new_slug);
    new_slug := coalesce(nullif(new_slug, ''), 'magasin')
      || '-' || substr(replace(new.id::text, '-', ''), 1, 8);

    insert into public.organizations (name, slug, plan, subscription_status, trial_ends_at)
    values (org_name, new_slug, 'TRIAL', 'trialing', now() + interval '14 days')
    returning id into target_org;
    assigned_role := 'ADMIN'::public.user_role;
    target_livreur := null;
  else
    return new;
  end if;

  display := coalesce(
    nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Utilisateur'
  );

  insert into public.profiles (user_id, organization_id, display_name, role, client_id, livreur_id)
  values (new.id, target_org, display, assigned_role, target_client, target_livreur)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

grant execute on function public.handle_new_user() to supabase_auth_admin;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- mark_order_delivered: a LIVREUR may deliver their own assigned order
-- ---------------------------------------------------------------------------

create or replace function public.mark_order_delivered(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_order public.orders;
begin
  if v_org is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_livreur is not null and v_order.livreur_id is distinct from v_livreur then
    raise exception 'This delivery is assigned to another livreur.';
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

notify pgrst, 'reload schema';
