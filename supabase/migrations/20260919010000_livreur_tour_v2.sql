-- Espace livreur v2 (2026-09-19) — le design « espace-auto-chauffeur ».
--
--  1. Chaque pièce de la tournée porte sa destination (kind) : GARAGE, COMPTOIR
--     ou STOCK — le livreur la range dans la bonne caisse. Dérivé de la commande
--     sans exposer le client au livreur.
--  2. « Reporter à la tournée suivante » : defer_line_to_next_tour() déplace la
--     pièce sur la tournée standard suivante (10h → 13h → 15h → 17h30 → 10h du
--     lendemain, créée au besoin), remet son état à « à récupérer » et prévient
--     le comptoir quand c'est le livreur qui reporte.
--  3. Retours confiés au livreur : deux trajets sur sales_returns —
--     GARAGE_TO_STORE (récupérer la pièce chez le garage) et STORE_TO_SUPPLIER
--     (déposer le retour chez le fournisseur, avec le n° de bon de retour).
--     Le comptoir les affecte à une tournée (assign_return_leg), le livreur
--     les valide (complete_return_leg), le tableau de tournée les renvoie
--     (`returns`). Les statuts métier du retour (statut_traitement) ne bougent
--     pas : le trajet est de la logistique.

-- ---------------------------------------------------------------------------
-- 1) La tournée standard qui suit une tournée
-- ---------------------------------------------------------------------------

create or replace function public.next_standard_tour(
  p_date date,
  p_slot time,
  out tour_date date,
  out tour_name text,
  out tour_slot time
)
language plpgsql
immutable
as $$
begin
  if p_slot is not null and p_slot < time '13:00' then
    tour_date := p_date; tour_name := 'Tournée 2'; tour_slot := time '13:00';
  elsif p_slot is not null and p_slot < time '15:00' then
    tour_date := p_date; tour_name := 'Tournée 3'; tour_slot := time '15:00';
  elsif p_slot is not null and p_slot < time '17:30' then
    tour_date := p_date; tour_name := 'Tournée 4'; tour_slot := time '17:30';
  else
    -- Dernière tournée du jour, ou tournée sans horaire : demain matin.
    tour_date := p_date + 1; tour_name := 'Tournée 1'; tour_slot := time '10:00';
  end if;
end;
$$;

-- The delivery_tours row of a tournée on a date, created if missing. Internal:
-- called by definer functions that did their own access check.
create or replace function public.ensure_supplier_tour_row(p_org uuid, p_date date, p_name text, p_slot time)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select t.id into v_id
  from public.delivery_tours t
  where t.organization_id = p_org and t.name = p_name and t.tour_date = p_date
  order by t.slot_start nulls last
  limit 1;
  if v_id is null then
    insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
    values (p_org, p_name, p_date, p_slot)
    returning delivery_tours.id into v_id;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.ensure_supplier_tour_row(uuid, date, text, time) from public, anon, authenticated;

create or replace function public.ensure_supplier_tour(p_date date, p_name text, p_slot time default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_date is null or v_name is null then
    raise exception 'A date and a tour name are required.';
  end if;
  return public.ensure_supplier_tour_row(v_org, p_date, v_name, p_slot);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Reporter une pièce à la tournée suivante
-- ---------------------------------------------------------------------------

create or replace function public.defer_line_to_next_tour(p_line_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := public.supplier_tour_actor();
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_today date := timezone('Europe/Paris', now())::date;
  v_line public.order_lines;
  v_order public.orders;
  v_tour public.delivery_tours;
  v_next record;
  v_next_id uuid;
  v_supplier text;
  v_who text;
begin
  select * into v_line
  from public.order_lines l
  where l.id = p_line_id and l.organization_id = v_org
  for update;
  if not found then
    raise exception 'Order line not found.';
  end if;
  if v_line.supplier_id is null or v_line.tour_id is null then
    raise exception 'This part is not on a supplier tour.';
  end if;

  select * into v_order from public.orders o where o.id = v_line.order_id;
  if v_order.cancelled_at is not null then
    raise exception 'This order has been cancelled.';
  end if;
  if coalesce(v_order.devis, false) then
    raise exception 'This part is not on a supplier tour.';
  end if;
  if v_line.reception_status = 'RECEIVED' then
    raise exception 'This part has already been received at the magasin.';
  end if;

  select * into v_tour
  from public.delivery_tours t
  where t.id = v_line.tour_id and t.organization_id = v_org
  for update;
  if not found then
    raise exception 'This part is not on a supplier tour.';
  end if;
  if v_actor = 'LIVREUR' then
    if v_tour.livreur_id is not null and v_tour.livreur_id <> v_livreur then
      raise exception 'This tour is assigned to another livreur.';
    end if;
    if v_tour.tour_date < v_today or v_tour.tour_date > v_today + 6 then
      raise exception 'This tour date is not available.';
    end if;
  end if;

  select * into v_next from public.next_standard_tour(v_tour.tour_date, v_tour.slot_start);
  v_next_id := public.ensure_supplier_tour_row(v_org, v_next.tour_date, v_next.tour_name, v_next.tour_slot);
  if v_next_id = v_tour.id then
    raise exception 'No later tour to defer to.';
  end if;

  update public.order_lines
  set tour_id = v_next_id,
      pickup_status = null,
      pickup_at = null,
      pickup_by = null
  where id = v_line.id;

  if v_actor = 'LIVREUR' then
    select s.name into v_supplier from public.suppliers s where s.id = v_line.supplier_id;
    select l.name into v_who from public.livreurs l where l.id = v_livreur;
    perform public.notify(v_org, 'STAFF', 'SUPPLIER_PART_DEFERRED',
      format('Reportée à %s (%s) : %s', v_next.tour_name, to_char(v_next.tour_slot, 'HH24"h"MI'), v_line.reference),
      format('%s — commande %s, chez %s. Reportée par %s depuis %s%s.',
             v_line.nom_produit, v_order.ref_demande, coalesce(v_supplier, 'le fournisseur'),
             coalesce(v_who, 'le livreur'), v_tour.name,
             case when v_next.tour_date <> v_tour.tour_date then format(' (au %s)', to_char(v_next.tour_date, 'DD/MM')) else '' end),
      '/dashboard/tournees', 'order_lines', v_line.id);
  end if;

  return jsonb_build_object(
    'tour_id', v_next_id,
    'tour_name', v_next.tour_name,
    'slot', to_char(v_next.tour_slot, 'HH24:MI'),
    'date', v_next.tour_date
  );
end;
$$;
revoke execute on function public.defer_line_to_next_tour(uuid) from public, anon;
grant execute on function public.defer_line_to_next_tour(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Retours confiés au livreur
-- ---------------------------------------------------------------------------

alter table public.sales_returns
  add column if not exists livreur_leg text,
  add column if not exists leg_tour_id uuid references public.delivery_tours(id) on delete set null,
  add column if not exists leg_status text,
  add column if not exists leg_done_at timestamptz,
  add column if not exists leg_done_by uuid references auth.users(id) on delete set null,
  add column if not exists leg_slip text,
  add column if not exists leg_note text;
alter table public.sales_returns drop constraint if exists sales_returns_livreur_leg_check;
alter table public.sales_returns
  add constraint sales_returns_livreur_leg_check
  check (livreur_leg is null or livreur_leg in ('GARAGE_TO_STORE', 'STORE_TO_SUPPLIER'));
alter table public.sales_returns drop constraint if exists sales_returns_leg_status_check;
alter table public.sales_returns
  add constraint sales_returns_leg_status_check
  check (leg_status is null or leg_status in ('A_FAIRE', 'FAIT'));
create index if not exists sales_returns_leg_tour_idx
  on public.sales_returns (organization_id, leg_tour_id)
  where leg_tour_id is not null;

comment on column public.sales_returns.livreur_leg is 'Trajet confié au livreur : GARAGE_TO_STORE (récupérer chez le garage) ou STORE_TO_SUPPLIER (déposer chez le fournisseur).';
comment on column public.sales_returns.leg_slip is 'N° du bon de retour remis au fournisseur.';

-- Comptoir : confier (ou retirer, p_leg null) un retour à une tournée.
create or replace function public.assign_return_leg(
  p_return_id uuid,
  p_leg text,
  p_tour_id uuid,
  p_slip text default null,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_leg text := nullif(upper(trim(coalesce(p_leg, ''))), '');
  v_ret public.sales_returns;
  v_tour public.delivery_tours;
  v_user uuid;
  v_dest text;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_ret
  from public.sales_returns r
  where r.id = p_return_id and r.organization_id = v_org
  for update;
  if not found then
    raise exception 'Return not found.';
  end if;

  if v_leg is null then
    update public.sales_returns
    set livreur_leg = null, leg_tour_id = null, leg_status = null,
        leg_done_at = null, leg_done_by = null, leg_slip = null, leg_note = null
    where id = v_ret.id;
    return;
  end if;
  if v_leg not in ('GARAGE_TO_STORE', 'STORE_TO_SUPPLIER') then
    raise exception 'Unknown return leg %.', v_leg;
  end if;
  if v_leg = 'GARAGE_TO_STORE' and v_ret.client_id is null then
    raise exception 'This return has no client to collect from.';
  end if;
  if v_leg = 'STORE_TO_SUPPLIER' and v_ret.supplier_id is null then
    raise exception 'This return has no supplier to deliver to.';
  end if;

  select * into v_tour
  from public.delivery_tours t
  where t.id = p_tour_id and t.organization_id = v_org;
  if not found then
    raise exception 'Tour not found.';
  end if;

  update public.sales_returns
  set livreur_leg = v_leg,
      leg_tour_id = v_tour.id,
      leg_status = 'A_FAIRE',
      leg_done_at = null,
      leg_done_by = null,
      leg_slip = nullif(trim(coalesce(p_slip, '')), ''),
      leg_note = nullif(trim(coalesce(p_note, '')), '')
  where id = v_ret.id;

  if v_tour.livreur_id is not null then
    select p.user_id into v_user from public.profiles p where p.livreur_id = v_tour.livreur_id limit 1;
    if v_user is not null then
      v_dest := case
        when v_leg = 'GARAGE_TO_STORE' then coalesce((select c.name from public.clients c where c.id = v_ret.client_id), 'le garage')
        else coalesce((select s.name from public.suppliers s where s.id = v_ret.supplier_id), 'le fournisseur')
      end;
      perform public.notify(v_org, 'LIVREUR', 'RETURN_LEG_ASSIGNED',
        format('%s : retour à %s chez %s', v_tour.name,
               case when v_leg = 'GARAGE_TO_STORE' then 'récupérer' else 'déposer' end, v_dest),
        format('%s%s', coalesce(v_ret.designation, v_ret.ref, 'Pièce'),
               case when nullif(trim(coalesce(p_slip, '')), '') is not null then format(' — bon de retour %s', trim(p_slip)) else '' end),
        '/livreur', 'sales_returns', v_ret.id, null, v_user);
    end if;
  end if;
end;
$$;
revoke execute on function public.assign_return_leg(uuid, text, uuid, text, text) from public, anon;
grant execute on function public.assign_return_leg(uuid, text, uuid, text, text) to authenticated;

-- Livreur (ou comptoir) : trajet fait / à refaire.
create or replace function public.complete_return_leg(p_return_id uuid, p_done boolean default true)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := public.supplier_tour_actor();
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_today date := timezone('Europe/Paris', now())::date;
  v_done boolean := coalesce(p_done, true);
  v_ret public.sales_returns;
  v_tour public.delivery_tours;
  v_dest text;
  v_who text;
begin
  select * into v_ret
  from public.sales_returns r
  where r.id = p_return_id and r.organization_id = v_org
  for update;
  if not found then
    raise exception 'Return not found.';
  end if;
  if v_ret.livreur_leg is null or v_ret.leg_tour_id is null then
    raise exception 'This return is not on a tour.';
  end if;

  select * into v_tour
  from public.delivery_tours t
  where t.id = v_ret.leg_tour_id and t.organization_id = v_org
  for update;
  if not found then
    raise exception 'This return is not on a tour.';
  end if;
  if v_actor = 'LIVREUR' then
    if v_tour.livreur_id is not null and v_tour.livreur_id <> v_livreur then
      raise exception 'This tour is assigned to another livreur.';
    end if;
    if v_tour.tour_date < v_today or v_tour.tour_date > v_today + 6 then
      raise exception 'This tour date is not available.';
    end if;
  end if;

  if (v_ret.leg_status = 'FAIT') = v_done then
    return;
  end if;

  update public.sales_returns
  set leg_status = case when v_done then 'FAIT' else 'A_FAIRE' end,
      leg_done_at = case when v_done then now() end,
      leg_done_by = case when v_done then auth.uid() end
  where id = v_ret.id;

  if v_actor = 'LIVREUR' and v_done then
    -- Premier geste du livreur sur la tournée : elle est partie, et elle est à lui.
    update public.delivery_tours
    set livreur_id = coalesce(livreur_id, v_livreur),
        status = case when status = 'PLANIFIEE' then 'EN_COURS'::public.tour_status else status end,
        started_at = case when status = 'PLANIFIEE' then coalesce(started_at, now()) else started_at end
    where id = v_tour.id
      and (livreur_id is null or status = 'PLANIFIEE');

    v_dest := case
      when v_ret.livreur_leg = 'GARAGE_TO_STORE' then coalesce((select c.name from public.clients c where c.id = v_ret.client_id), 'le garage')
      else coalesce((select s.name from public.suppliers s where s.id = v_ret.supplier_id), 'le fournisseur')
    end;
    select l.name into v_who from public.livreurs l where l.id = v_livreur;
    perform public.notify(v_org, 'STAFF', 'RETURN_LEG_DONE',
      format(case when v_ret.livreur_leg = 'GARAGE_TO_STORE' then 'Retour récupéré chez %s : %s' else 'Retour déposé chez %s : %s' end,
             v_dest, coalesce(v_ret.ref, v_ret.designation, 'pièce')),
      format('%s — %s, par %s.%s', coalesce(v_ret.designation, ''), v_tour.name, coalesce(v_who, 'le livreur'),
             case when v_ret.leg_slip is not null then format(' Bon de retour %s.', v_ret.leg_slip) else '' end),
      '/dashboard/retours', 'sales_returns', v_ret.id);
  end if;
end;
$$;
revoke execute on function public.complete_return_leg(uuid, boolean) from public, anon;
grant execute on function public.complete_return_leg(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Le tableau de tournée : kind par pièce + retours du jour
-- ---------------------------------------------------------------------------

create or replace function public.supplier_tour_board(p_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor text := public.supplier_tour_actor();
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_staff boolean;
  v_today date := timezone('Europe/Paris', now())::date;
  v_date date := coalesce(p_date, timezone('Europe/Paris', now())::date);
begin
  v_staff := v_actor = 'STAFF';
  if not v_staff and (v_date < v_today or v_date > v_today + 6) then
    raise exception 'This tour date is not available.';
  end if;

  return jsonb_build_object(
    'date', v_date,
    'defaults', case when v_staff then coalesce((
      select jsonb_agg(jsonb_build_object('tour_name', d.tour_name, 'livreur_id', d.livreur_id, 'livreur_name', l.name))
      from public.tour_livreur_defaults d
      join public.livreurs l on l.id = d.livreur_id
      where d.organization_id = v_org
    ), '[]'::jsonb) else '[]'::jsonb end,
    -- Pièces à récupérer les jours suivants (7 jours), pour ne pas rester sur un tableau vide.
    'upcoming', coalesce((
      select jsonb_agg(jsonb_build_object('date', u.tour_date, 'count', u.n) order by u.tour_date)
      from (
        select t.tour_date, count(*) as n
        from public.order_lines ol
        join public.delivery_tours t on t.id = ol.tour_id
        join public.orders o on o.id = ol.order_id
        join public.suppliers s on s.id = ol.supplier_id
        where ol.organization_id = v_org
          and t.organization_id = v_org
          and t.tour_date > v_date
          and t.tour_date <= greatest(v_date, v_today) + 7
          and (v_staff or ((t.livreur_id is null or t.livreur_id = v_livreur) and t.tour_date <= v_today + 6))
          and coalesce(o.devis, false) = false
          and o.cancelled_at is null
          and coalesce(s.own_delivery, false) = false
        group by t.tour_date
      ) u
    ), '[]'::jsonb),
    'tours', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', t.id,
          'name', t.name,
          'slot', to_char(t.slot_start, 'HH24:MI'),
          'status', t.status,
          'started_at', t.started_at,
          'completed_at', t.completed_at,
          'note', t.note,
          'livreur_id', t.livreur_id,
          'livreur_name', l.name
        ) order by t.slot_start nulls last, t.name)
      from public.delivery_tours t
      left join public.livreurs l on l.id = t.livreur_id
      where t.organization_id = v_org
        and t.tour_date = v_date
        and (v_staff or t.livreur_id is null or t.livreur_id = v_livreur)
    ), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', ol.id,
          'tour_id', ol.tour_id,
          'order_id', o.id,
          'order_ref', o.ref_demande,
          'supplier_id', s.id,
          'supplier', s.name,
          'vendeur_id', o.vendeur_id,
          'vendeur', coalesce((
            select nullif(trim(pr.display_name), '') from public.profiles pr where pr.user_id = o.vendeur_id limit 1
          ), 'Vendeur'),
          'reference', ol.reference,
          'reference_commande', ol.reference_commande,
          'designation', ol.nom_produit,
          'quantity', ol.quantity,
          'received', ol.qte_recue,
          'reception_status', ol.reception_status,
          'pickup_status', ol.pickup_status,
          'pickup_at', ol.pickup_at,
          'pickup_by', (select pr.display_name from public.profiles pr where pr.user_id = ol.pickup_by limit 1),
          'is_restock', coalesce(o.is_restock, false),
          -- La caisse où ranger la pièce : réappro stock, commande d'un garage, ou client comptoir.
          'kind', case
            when coalesce(o.is_restock, false) then 'STOCK'
            when coalesce(c.is_garage, false) then 'GARAGE'
            else 'COMPTOIR'
          end,
          'client', case when v_staff then coalesce(
            c.name,
            case when coalesce(o.is_restock, false) then 'Réappro stock' end,
            nullif(o.client_phone, '-'),
            'Client comptoir'
          ) end
        ) order by t.slot_start nulls last, s.name, o.ref_demande, ol.reference)
      from public.order_lines ol
      join public.delivery_tours t on t.id = ol.tour_id
      join public.orders o on o.id = ol.order_id
      join public.suppliers s on s.id = ol.supplier_id
      left join public.clients c on c.id = o.client_id
      where ol.organization_id = v_org
        and t.organization_id = v_org
        and t.tour_date = v_date
        and (v_staff or t.livreur_id is null or t.livreur_id = v_livreur)
        and coalesce(o.devis, false) = false
        and o.cancelled_at is null
        and coalesce(s.own_delivery, false) = false
    ), '[]'::jsonb),
    -- Retours confiés aux tournées du jour : chez le garage (récupérer) ou chez le fournisseur (déposer).
    'returns', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id,
          'tour_id', r.leg_tour_id,
          'leg', r.livreur_leg,
          'status', r.leg_status,
          'ref', r.ref,
          'designation', r.designation,
          'reference', ol.reference,
          'order_ref', o.ref_demande,
          'destination', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.name else s.name end,
          'address', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.address end,
          'city', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.city end,
          'phone', case when r.livreur_leg = 'GARAGE_TO_STORE' then c.phone end,
          'slip', r.leg_slip,
          'note', r.leg_note,
          'done_at', r.leg_done_at,
          'done_by', (select pr.display_name from public.profiles pr where pr.user_id = r.leg_done_by limit 1)
        ) order by t.slot_start nulls last, r.livreur_leg, coalesce(c.name, s.name), r.created_at)
      from public.sales_returns r
      join public.delivery_tours t on t.id = r.leg_tour_id
      left join public.clients c on c.id = r.client_id
      left join public.suppliers s on s.id = r.supplier_id
      left join public.order_lines ol on ol.id = r.order_line_id
      left join public.orders o on o.id = r.order_id
      where r.organization_id = v_org
        and t.organization_id = v_org
        and t.tour_date = v_date
        and r.livreur_leg is not null
        and (v_staff or t.livreur_id is null or t.livreur_id = v_livreur)
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.supplier_tour_board(date) from public, anon;
grant execute on function public.supplier_tour_board(date) to authenticated;

notify pgrst, 'reload schema';
