-- Tournées (2026-10-03) : pas de tournée le dimanche.
--
-- Une commande passée le samedi après 17 h partait sur la « Tournée 1 » du
-- lendemain — un dimanche, jour sans travail. Tout ce qui tomberait un dimanche
-- part désormais lundi matin (Tournée 1, 10 h) : commandes du comptoir,
-- réapprovisionnements, pièces reportées par le livreur. Le samedi reste un
-- jour de tournée.

-- Le jour de tournée qui suit une date : la date elle-même, sauf un dimanche → lundi.
create or replace function public.next_delivery_day(p_date date)
returns date
language sql
immutable
as $$
  select case when extract(isodow from p_date) = 7 then p_date + 1 else p_date end
$$;

-- ---------------------------------------------------------------------
-- La prochaine tournée à partir de maintenant (réapprovisionnements…)
-- Reprise de 20260829010000, plus le saut du dimanche.
-- ---------------------------------------------------------------------
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
  -- Dimanche : pas de tournée, tout part lundi matin.
  if extract(isodow from tour_date) = 7 then
    tour_date := public.next_delivery_day(tour_date); v_number := 1; tour_slot := time '10:00';
  end if;
  tour_name := format('Tournée %s', v_number);
  delivery_at := (tour_date + tour_slot) at time zone 'Europe/Paris';
end;
$$;

-- ---------------------------------------------------------------------
-- La tournée standard qui suit une tournée (« reporter à la tournée suivante »)
-- Reprise de 20260919010000, plus le saut du dimanche.
-- ---------------------------------------------------------------------
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
  if extract(isodow from tour_date) = 7 then
    tour_date := public.next_delivery_day(tour_date); tour_name := 'Tournée 1'; tour_slot := time '10:00';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Commande du comptoir : la fonction en place est reprise telle quelle, seule
-- la ligne qui fixe la date de tournée est complétée. Si cette ligne est
-- introuvable, la migration s'arrête plutôt que de ne rien corriger.
-- ---------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.create_order_with_lines(jsonb)'::regprocedure) into v_def;
  v_new := replace(
    v_def,
    'v_tour_date := v_local::date + case when v_tour_number = 1 and v_minutes > 1020 then 1 else 0 end;',
    'v_tour_date := v_local::date + case when v_tour_number = 1 and v_minutes > 1020 then 1 else 0 end;
    -- Dimanche : pas de tournée, la commande part sur la Tournée 1 de lundi.
    if extract(isodow from v_tour_date) = 7 then
      v_tour_date := public.next_delivery_day(v_tour_date); v_tour_number := 1; v_tour_slot := time ''10:00'';
    end if;'
  );
  if v_new = v_def then
    raise exception 'create_order_with_lines: the tour date line was not found, nothing patched.';
  end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------
-- Les tournées déjà créées un dimanche (planifiées) passent au lundi.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_monday date;
  v_next uuid;
begin
  for r in
    select t.id, t.organization_id, t.tour_date
    from public.delivery_tours t
    where extract(isodow from t.tour_date) = 7 and t.status = 'PLANIFIEE'
  loop
    v_monday := public.next_delivery_day(r.tour_date);
    v_next := public.ensure_supplier_tour_row(r.organization_id, v_monday, 'Tournée 1', time '10:00');
    update public.orders o
    set date_envoi = (v_monday + time '10:00') at time zone 'Europe/Paris', updated_at = now()
    where o.organization_id = r.organization_id
      and o.date_envoi is not null
      and timezone('Europe/Paris', o.date_envoi)::date = r.tour_date
      and exists (select 1 from public.order_lines l where l.order_id = o.id and l.tour_id = r.id);
    update public.order_lines
    set tour_id = v_next, pickup_status = null, pickup_at = null, pickup_by = null
    where tour_id = r.id;
    update public.sales_returns set leg_tour_id = v_next where leg_tour_id = r.id;
    delete from public.delivery_tours t
    where t.id = r.id
      and not exists (select 1 from public.order_lines l where l.tour_id = t.id)
      and not exists (select 1 from public.sales_returns s where s.leg_tour_id = t.id);
  end loop;
end $$;

notify pgrst, 'reload schema';
