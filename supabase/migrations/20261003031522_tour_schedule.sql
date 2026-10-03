-- Tournées (2026-10-03) : horaires réglés par le magasin, jour par jour.
--
-- Jusqu'ici les quatre tournées (10 h, 13 h, 15 h, 17 h 30) et leurs heures
-- limites de commande étaient écrites dans le code, les mêmes tous les jours
-- (sauf le dimanche depuis 20261003025812). L'administrateur du magasin les
-- règle désormais dans Paramètres → Tournées : pour chaque jour de la semaine,
-- les tournées, leur heure de départ et l'heure limite de commande. Un jour
-- sans tournée est fermé. Toute la logique « quelle tournée pour cette
-- commande » lit cette table : commandes du comptoir, réapprovisionnements,
-- report d'une pièce par le livreur, tableau des tournées.

create table if not exists public.tour_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- 1 = lundi … 7 = dimanche (isodow)
  weekday smallint not null check (weekday between 1 and 7),
  name text not null,
  slot_start time not null,
  -- Dernière heure à laquelle une commande part sur cette tournée.
  cutoff time not null,
  constraint tour_schedule_cutoff_check check (cutoff <= slot_start),
  constraint tour_schedule_slot_unique unique (organization_id, weekday, slot_start),
  constraint tour_schedule_name_unique unique (organization_id, weekday, name)
);
create index if not exists tour_schedule_org_day_idx on public.tour_schedule (organization_id, weekday, slot_start);
alter table public.tour_schedule enable row level security;
drop policy if exists tour_schedule_read on public.tour_schedule;
create policy tour_schedule_read on public.tour_schedule for select
  using (organization_id = public.current_user_org_id());
revoke all on public.tour_schedule from public, anon, authenticated;
grant select on public.tour_schedule to authenticated;

-- ---------------------------------------------------------------------
-- Horaires par défaut : lundi à samedi, les quatre tournées historiques ;
-- dimanche fermé. Posés à la création d'un magasin, et sur les magasins existants.
-- ---------------------------------------------------------------------
create or replace function public.seed_default_tour_schedule(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_org is null or exists (select 1 from public.tour_schedule s where s.organization_id = p_org) then
    return;
  end if;
  insert into public.tour_schedule (organization_id, weekday, name, slot_start, cutoff)
  select p_org, d, t.name, t.slot_start, t.cutoff
  from generate_series(1, 6) as d
  cross join (values
    ('Tournée 1', time '10:00', time '09:30'),
    ('Tournée 2', time '13:00', time '12:00'),
    ('Tournée 3', time '15:00', time '14:30'),
    ('Tournée 4', time '17:30', time '17:00')
  ) as t(name, slot_start, cutoff);
end;
$$;
revoke execute on function public.seed_default_tour_schedule(uuid) from public, anon, authenticated;

create or replace function public.on_organization_created_seed_tour_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_tour_schedule(new.id);
  return new;
end;
$$;
revoke execute on function public.on_organization_created_seed_tour_schedule() from public, anon, authenticated;
drop trigger if exists organizations_seed_tour_schedule on public.organizations;
create trigger organizations_seed_tour_schedule
  after insert on public.organizations
  for each row execute function public.on_organization_created_seed_tour_schedule();

select public.seed_default_tour_schedule(o.id) from public.organizations o;

-- ---------------------------------------------------------------------
-- La semaine d'un magasin, pour l'application.
-- ---------------------------------------------------------------------
create or replace function public.tour_schedule_json(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'weekday', s.weekday, 'name', s.name,
      'slot', to_char(s.slot_start, 'HH24:MI'), 'cutoff', to_char(s.cutoff, 'HH24:MI')
    ) order by s.weekday, s.slot_start), '[]'::jsonb)
  from public.tour_schedule s
  where s.organization_id = p_org
$$;
revoke execute on function public.tour_schedule_json(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Quelle tournée pour une commande passée à un instant donné : la première
-- tournée du jour dont l'heure limite n'est pas passée, sinon la première
-- tournée du prochain jour ouvert (deux semaines cherchées).
-- ---------------------------------------------------------------------
create or replace function public.next_tour_for(
  p_org uuid,
  p_at timestamptz,
  out tour_date date,
  out tour_name text,
  out tour_slot time,
  out delivery_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local timestamp := timezone('Europe/Paris', p_at);
  v_day date;
  v_name text;
  v_slot time;
  d integer;
begin
  if p_org is null then
    raise exception 'Organization required.';
  end if;
  perform public.seed_default_tour_schedule(p_org);
  for d in 0..13 loop
    v_day := v_local::date + d;
    select s.name, s.slot_start into v_name, v_slot
    from public.tour_schedule s
    where s.organization_id = p_org
      and s.weekday = extract(isodow from v_day)
      and (d > 0 or s.cutoff >= v_local::time)
    order by s.slot_start
    limit 1;
    if found then
      tour_date := v_day;
      tour_name := v_name;
      tour_slot := v_slot;
      delivery_at := (v_day + v_slot) at time zone 'Europe/Paris';
      return;
    end if;
  end loop;
  raise exception 'Aucune tournée programmée : réglez les horaires dans Paramètres → Tournées.';
end;
$$;
revoke execute on function public.next_tour_for(uuid, timestamptz) from public, anon, authenticated;

-- La tournée qui suit une tournée donnée (report d'une pièce par le livreur).
create or replace function public.next_tour_after(
  p_org uuid,
  p_date date,
  p_slot time,
  out tour_date date,
  out tour_name text,
  out tour_slot time
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_slot time;
  d integer;
begin
  perform public.seed_default_tour_schedule(p_org);
  for d in 0..14 loop
    select s.name, s.slot_start into v_name, v_slot
    from public.tour_schedule s
    where s.organization_id = p_org
      and s.weekday = extract(isodow from p_date + d)
      -- Même jour : seulement une tournée qui part plus tard ; une tournée sans horaire va au jour suivant.
      and (d > 0 or (p_slot is not null and s.slot_start > p_slot))
    order by s.slot_start
    limit 1;
    if found then
      tour_date := p_date + d;
      tour_name := v_name;
      tour_slot := v_slot;
      return;
    end if;
  end loop;
  raise exception 'Aucune tournée programmée : réglez les horaires dans Paramètres → Tournées.';
end;
$$;
revoke execute on function public.next_tour_after(uuid, date, time) from public, anon, authenticated;

-- La prochaine tournée de mon magasin (réapprovisionnements, application).
create or replace function public.next_tournee(
  out tour_name text,
  out tour_date date,
  out tour_slot time,
  out delivery_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  -- Definer: next_tour_for() is internal; the caller's magasin is read from the session.
  select n.tour_name, n.tour_date, n.tour_slot, n.delivery_at
  into tour_name, tour_date, tour_slot, delivery_at
  from public.next_tour_for(public.current_user_org_id(), now()) n;
end;
$$;

-- ---------------------------------------------------------------------
-- Paramètres → Tournées : l'administrateur remplace la semaine entière.
-- p_week = [{ weekday, name, slot 'HH:MM', cutoff 'HH:MM' }, …]
-- ---------------------------------------------------------------------
create or replace function public.set_tour_schedule(p_week jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_n integer;
begin
  if v_org is null or public.current_user_role() <> 'ADMIN'::public.user_role then
    raise exception 'Only an organization administrator may update settings.';
  end if;
  if p_week is null or jsonb_typeof(p_week) <> 'array' or jsonb_array_length(p_week) = 0 then
    raise exception 'Programmez au moins une tournée dans la semaine.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_week) e where nullif(trim(e->>'name'), '') is null) then
    raise exception 'Chaque tournée doit avoir un nom.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_week) e
             where (e->>'weekday')::int not between 1 and 7 or (e->>'slot')::time is null) then
    raise exception 'Jour ou heure de départ manquant.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_week) e
             where coalesce((e->>'cutoff')::time, (e->>'slot')::time) > (e->>'slot')::time) then
    raise exception 'L''heure limite de commande doit précéder le départ.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_week) e group by e->>'weekday', e->>'slot' having count(*) > 1) then
    raise exception 'Deux tournées du même jour ne peuvent pas partir à la même heure.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_week) e group by e->>'weekday', trim(e->>'name') having count(*) > 1) then
    raise exception 'Deux tournées du même jour ne peuvent pas porter le même nom.';
  end if;

  delete from public.tour_schedule where organization_id = v_org;
  insert into public.tour_schedule (organization_id, weekday, name, slot_start, cutoff)
  select v_org, (e->>'weekday')::int, trim(e->>'name'), (e->>'slot')::time,
         coalesce((e->>'cutoff')::time, (e->>'slot')::time - interval '30 minutes')
  from jsonb_array_elements(p_week) e;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'Programmez au moins une tournée dans la semaine.';
  end if;
  return public.tour_schedule_json(v_org);
end;
$$;
revoke execute on function public.set_tour_schedule(jsonb) from public, anon;
grant execute on function public.set_tour_schedule(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- Les fonctions en place sont reprises telles quelles ; seule la partie qui
-- choisissait la tournée est remplacée. Chaque remplacement s'arrête si le
-- texte attendu est introuvable, plutôt que de ne rien corriger.
-- ---------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
  v_start text := E'v_local := timezone(''Europe/Paris'', now());';
  v_end text := E'v_delivery_at := (v_tour_date + v_tour_slot) at time zone ''Europe/Paris'';';
  p1 integer;
  p2 integer;
  v_anchor text;
begin
  -- 1. Commande du comptoir : la tournée vient de next_tour_for().
  select pg_get_functiondef('public.create_order_with_lines(jsonb)'::regprocedure) into v_def;
  p1 := position(v_start in v_def);
  p2 := position(v_end in v_def);
  if p1 = 0 or p2 = 0 or p2 < p1 then
    raise exception 'create_order_with_lines: the tour block was not found, nothing patched.';
  end if;
  v_new := left(v_def, p1 - 1)
    || E'select n.tour_date, n.tour_name, n.tour_slot, n.delivery_at\n'
    || E'    into v_tour_date, v_tour_name, v_tour_slot, v_delivery_at\n'
    || E'    from public.next_tour_for(v_org, now()) n;'
    || substr(v_def, p2 + length(v_end));
  execute v_new;

  -- 2. Report d'une pièce par le livreur : la tournée suivante selon les horaires du magasin.
  select pg_get_functiondef('public.defer_line_to_next_tour(uuid)'::regprocedure) into v_def;
  v_anchor := 'select * into v_next from public.next_standard_tour(v_tour.tour_date, v_tour.slot_start);';
  v_new := replace(v_def, v_anchor, 'select * into v_next from public.next_tour_after(v_org, v_tour.tour_date, v_tour.slot_start);');
  if v_new = v_def then
    raise exception 'defer_line_to_next_tour: the call was not found, nothing patched.';
  end if;
  execute v_new;

  -- 3. Tableau des tournées : la semaine du magasin voyage avec le tableau.
  select pg_get_functiondef('public.supplier_tour_board(date)'::regprocedure) into v_def;
  v_anchor := E'\n    ''tours'', coalesce((';
  v_new := replace(v_def, v_anchor, E'\n    ''schedule'', public.tour_schedule_json(v_org),' || v_anchor);
  if v_new = v_def then
    raise exception 'supplier_tour_board: the tours key was not found, nothing patched.';
  end if;
  execute v_new;
end $$;

notify pgrst, 'reload schema';
