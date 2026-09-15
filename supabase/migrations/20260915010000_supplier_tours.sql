-- Tournée fournisseurs (2026-09-15).
--
-- À chaque tournée (10:00, 13:00, 15:00, 17:30) le livreur passe chez les
-- fournisseurs et récupère les pièces commandées par les vendeurs. Le
-- tableau « Tournée fournisseurs » du comptoir et l'onglet « Fournisseurs »
-- de /livreur lisent la même source : supplier_tour_board(date).
--
--  1. order_lines.pickup_status : récupérée / indisponible chez le
--     fournisseur. Distinct de la réception au magasin (receive_order_line :
--     stock, alertes), qui reste un geste du comptoir.
--  2. delivery_tours : livreur (la FK visait auth.users et n'a jamais servi :
--     elle vise maintenant livreurs), départ / fin, consigne du magasin.
--  3. RPC. Le livreur ne voit que ses tournées et celles sans livreur, du
--     jour aux 6 jours suivants, sans prix ni client.

-- ---------------------------------------------------------------------
-- 1. Pièce récupérée / indisponible chez le fournisseur
-- ---------------------------------------------------------------------
alter table public.order_lines
  add column if not exists pickup_status text,
  add column if not exists pickup_at timestamptz,
  add column if not exists pickup_by uuid references auth.users (id) on delete set null;

alter table public.order_lines drop constraint if exists order_lines_pickup_status_check;
alter table public.order_lines
  add constraint order_lines_pickup_status_check
  check (pickup_status is null or pickup_status in ('PICKED_UP', 'UNAVAILABLE'));

-- ---------------------------------------------------------------------
-- 2. Tournée : livreur, départ / fin, consigne
-- ---------------------------------------------------------------------
alter table public.delivery_tours drop constraint if exists delivery_tours_livreur_id_fkey;
update public.delivery_tours t
set livreur_id = null
where t.livreur_id is not null
  and not exists (select 1 from public.livreurs l where l.id = t.livreur_id);
alter table public.delivery_tours
  add constraint delivery_tours_livreur_id_fkey
  foreign key (livreur_id) references public.livreurs (id) on delete set null;

alter table public.delivery_tours
  add column if not exists started_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists note text;

create index if not exists idx_delivery_tours_org_date
  on public.delivery_tours (organization_id, tour_date);

-- Livreur attitré d'une tournée (« Tournée 1 → Rachid, tous les jours ») :
-- appliqué à la création de la tournée du jour, modifiable au cas par cas.
create table if not exists public.tour_livreur_defaults (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tour_name text not null,
  livreur_id uuid not null references public.livreurs (id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (organization_id, tour_name)
);
alter table public.tour_livreur_defaults enable row level security;
drop policy if exists tour_livreur_defaults_staff on public.tour_livreur_defaults;
create policy tour_livreur_defaults_staff on public.tour_livreur_defaults for select
  using (organization_id = public.current_user_org_id() and public.is_counter_staff());
revoke all on public.tour_livreur_defaults from public, anon, authenticated;
grant select on public.tour_livreur_defaults to authenticated;

create or replace function public.delivery_tours_apply_default_livreur()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.livreur_id is null then
    select d.livreur_id into new.livreur_id
    from public.tour_livreur_defaults d
    join public.livreurs l on l.id = d.livreur_id and l.active
    where d.organization_id = new.organization_id and d.tour_name = new.name;
  end if;
  return new;
end;
$$;
drop trigger if exists delivery_tours_default_livreur on public.delivery_tours;
create trigger delivery_tours_default_livreur
  before insert on public.delivery_tours
  for each row execute function public.delivery_tours_apply_default_livreur();

-- ---------------------------------------------------------------------
-- 3. RPC
-- ---------------------------------------------------------------------

-- Qui agit : 'STAFF' (comptoir) ou 'LIVREUR' (livreur actif). Refuse le reste.
create or replace function public.supplier_tour_actor()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  if v_org is null or auth.uid() is null then
    raise exception 'Staff access is required.';
  end if;
  if public.is_counter_staff() then
    perform public.assert_operational_access(v_org);
    return 'STAFF';
  end if;
  if public.current_user_livreur_id() is not null then
    perform public.assert_operational_access(v_org);
    return 'LIVREUR';
  end if;
  if exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.livreur_id is not null) then
    raise exception 'Livreur access is disabled.';
  end if;
  raise exception 'Staff access is required.';
end;
$$;
revoke execute on function public.supplier_tour_actor() from public, anon, authenticated;

-- Les tournées d'un jour et les pièces à récupérer chez chaque fournisseur.
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
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.supplier_tour_board(date) from public, anon;
grant execute on function public.supplier_tour_board(date) to authenticated;

-- Récupérée / indisponible chez le fournisseur, ou remise à récupérer (null).
create or replace function public.set_line_pickup(p_line_id uuid, p_status text default null)
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
  v_status text := nullif(upper(trim(coalesce(p_status, ''))), '');
  v_line public.order_lines;
  v_order public.orders;
  v_tour public.delivery_tours;
  v_supplier text;
begin
  if v_status is not null and v_status not in ('PICKED_UP', 'UNAVAILABLE') then
    raise exception 'Unknown pickup status %.', v_status;
  end if;

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

  if v_line.pickup_status is not distinct from v_status then
    return;
  end if;

  update public.order_lines
  set pickup_status = v_status,
      pickup_at = case when v_status is null then null else now() end,
      pickup_by = case when v_status is null then null else auth.uid() end
  where id = v_line.id;

  if v_actor = 'LIVREUR' and v_status is not null then
    -- Première pièce cochée par le livreur : la tournée est partie, et elle est à lui.
    update public.delivery_tours
    set livreur_id = coalesce(livreur_id, v_livreur),
        status = case when status = 'PLANIFIEE' then 'EN_COURS'::public.tour_status else status end,
        started_at = case when status = 'PLANIFIEE' then coalesce(started_at, now()) else started_at end
    where id = v_tour.id
      and (livreur_id is null or status = 'PLANIFIEE');

    if v_status = 'UNAVAILABLE' then
      select s.name into v_supplier from public.suppliers s where s.id = v_line.supplier_id;
      perform public.notify(v_org, 'STAFF', 'SUPPLIER_PART_UNAVAILABLE',
        format('Indisponible chez %s : %s', coalesce(v_supplier, 'le fournisseur'), v_line.reference),
        format('%s — commande %s, %s de %s.', v_line.nom_produit, v_order.ref_demande, v_tour.name,
               coalesce(to_char(v_tour.slot_start, 'HH24"h"MI'), 'la journée')),
        '/dashboard/tournees', 'order_lines', v_line.id);
    end if;
  end if;
end;
$$;
revoke execute on function public.set_line_pickup(uuid, text) from public, anon;
grant execute on function public.set_line_pickup(uuid, text) to authenticated;

-- Planifiée → en cours → terminée. Le livreur ne remet jamais en planifiée.
create or replace function public.set_supplier_tour_status(p_tour_id uuid, p_status text)
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
  v_status text := upper(trim(coalesce(p_status, '')));
  v_tour public.delivery_tours;
  v_done integer;
  v_unavailable integer;
  v_left integer;
begin
  if v_status not in ('PLANIFIEE', 'EN_COURS', 'TERMINEE') then
    raise exception 'Unknown tour status %.', v_status;
  end if;

  select * into v_tour
  from public.delivery_tours t
  where t.id = p_tour_id and t.organization_id = v_org
  for update;
  if not found then
    raise exception 'Tour not found.';
  end if;

  if v_actor = 'LIVREUR' then
    if v_tour.livreur_id is not null and v_tour.livreur_id <> v_livreur then
      raise exception 'This tour is assigned to another livreur.';
    end if;
    if v_tour.tour_date < v_today or v_tour.tour_date > v_today + 6 then
      raise exception 'This tour date is not available.';
    end if;
    if v_status = 'PLANIFIEE' then
      raise exception 'Only the magasin can put a tour back to planned.';
    end if;
  end if;

  if v_tour.status::text = v_status then
    return;
  end if;

  update public.delivery_tours
  set status = v_status::public.tour_status,
      started_at = case when v_status = 'PLANIFIEE' then null else coalesce(started_at, now()) end,
      completed_at = case when v_status = 'TERMINEE' then now() else null end,
      livreur_id = case when v_actor = 'LIVREUR' then coalesce(livreur_id, v_livreur) else livreur_id end
  where id = v_tour.id;

  if v_status = 'TERMINEE' and v_actor = 'LIVREUR' then
    select
      count(*) filter (where l.reception_status = 'RECEIVED' or l.pickup_status = 'PICKED_UP'),
      count(*) filter (where l.reception_status <> 'RECEIVED'
                         and l.pickup_status is distinct from 'PICKED_UP'
                         and (l.pickup_status = 'UNAVAILABLE' or l.reception_status = 'NOT_RECEIVED')),
      count(*) filter (where l.reception_status not in ('RECEIVED', 'NOT_RECEIVED') and l.pickup_status is null)
    into v_done, v_unavailable, v_left
    from public.order_lines l
    join public.orders o on o.id = l.order_id
    join public.suppliers s on s.id = l.supplier_id
    where l.tour_id = v_tour.id
      and l.organization_id = v_org
      and coalesce(o.devis, false) = false
      and o.cancelled_at is null
      and coalesce(s.own_delivery, false) = false;

    perform public.notify(v_org, 'STAFF', 'SUPPLIER_TOUR_DONE',
      format('%s terminée', v_tour.name),
      format('%s récupérée(s), %s indisponible(s), %s non récupérée(s).', v_done, v_unavailable, v_left),
      '/dashboard/tournees', 'delivery_tours', v_tour.id);
  end if;
end;
$$;
revoke execute on function public.set_supplier_tour_status(uuid, text) from public, anon;
grant execute on function public.set_supplier_tour_status(uuid, text) to authenticated;

-- Comptoir : livreur de la tournée et consigne. Le livreur assigné est prévenu.
-- p_remember : true = ce livreur devient l'attitré de cette tournée (tous les
-- jours), false = plus d'attitré, null = inchangé.
create or replace function public.update_supplier_tour(
  p_tour_id uuid,
  p_livreur_id uuid,
  p_note text,
  p_remember boolean default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_tour public.delivery_tours;
  v_user uuid;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_tour
  from public.delivery_tours t
  where t.id = p_tour_id and t.organization_id = v_org
  for update;
  if not found then
    raise exception 'Tour not found.';
  end if;
  if p_livreur_id is not null
     and p_livreur_id is distinct from v_tour.livreur_id
     and not exists (
       select 1 from public.livreurs l
       where l.id = p_livreur_id and l.organization_id = v_org and l.active
     ) then
    raise exception 'Livreur not found or inactive.';
  end if;

  update public.delivery_tours
  set livreur_id = p_livreur_id,
      note = nullif(trim(coalesce(p_note, '')), '')
  where id = v_tour.id;

  if p_remember is true and p_livreur_id is not null then
    insert into public.tour_livreur_defaults (organization_id, tour_name, livreur_id)
    values (v_org, v_tour.name, p_livreur_id)
    on conflict (organization_id, tour_name) do update
      set livreur_id = excluded.livreur_id, updated_at = now();
  elsif p_remember is not null then
    delete from public.tour_livreur_defaults
    where organization_id = v_org and tour_name = v_tour.name;
  end if;

  if p_livreur_id is not null and p_livreur_id is distinct from v_tour.livreur_id then
    select p.user_id into v_user from public.profiles p where p.livreur_id = p_livreur_id limit 1;
    if v_user is not null then
      perform public.notify(v_org, 'LIVREUR', 'SUPPLIER_TOUR_ASSIGNED',
        format('%s du %s vous est confiée', v_tour.name, to_char(v_tour.tour_date, 'DD/MM')),
        format('Départ à %s : pièces à récupérer chez les fournisseurs.',
               coalesce(to_char(v_tour.slot_start, 'HH24"h"MI'), 'l''heure prévue')),
        '/livreur', 'delivery_tours', v_tour.id, null, v_user);
    end if;
  end if;
end;
$$;
revoke execute on function public.update_supplier_tour(uuid, uuid, text, boolean) from public, anon;
grant execute on function public.update_supplier_tour(uuid, uuid, text, boolean) to authenticated;

notify pgrst, 'reload schema';
