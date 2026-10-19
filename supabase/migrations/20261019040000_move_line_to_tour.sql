-- Reporter la tournée d'une pièce (2026-10-19).
--
-- Sur /dashboard/tournees, à côté de « Changer de fournisseur », le comptoir
-- reporte une pièce sur une autre tournée de son choix (celle d'après, ou un
-- autre jour), par exemple quand le fournisseur annonce la pièce pour demain.
-- Le livreur, lui, garde « Reporter à la tournée suivante »
-- (defer_line_to_next_tour) qui ne choisit pas la tournée.
--
-- move_line_to_tour(p_line_id, p_date, p_name) : comptoir seulement ; la
-- tournée cible est une tournée des horaires du magasin (tour_schedule) pour
-- ce jour-là, pas encore partie ; la ligne de delivery_tours est créée au
-- besoin (ensure_supplier_tour_row). La pièce repasse « à récupérer »
-- (pickup_* effacés), un reliquat / une pièce « non reçue » redevient attendue,
-- et prevue_le = départ de la tournée cible.

create or replace function public.move_line_to_tour(p_line_id uuid, p_date date, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_name text := nullif(trim(coalesce(p_name, '')), '');
  v_today date := timezone('Europe/Paris', now())::date;
  v_line public.order_lines;
  v_order public.orders;
  v_supplier public.suppliers;
  v_slot time;
  v_departure timestamptz;
  v_target uuid;
  v_tour public.delivery_tours;
  v_previous public.delivery_tours;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Accès réservé au comptoir.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_line
  from public.order_lines l
  where l.id = p_line_id and l.organization_id = v_org
  for update;
  if not found then
    raise exception 'Pièce introuvable.';
  end if;

  select * into v_order from public.orders o where o.id = v_line.order_id;
  if v_order.cancelled_at is not null then
    raise exception 'Commande annulée.';
  end if;
  if coalesce(v_order.devis, false) then
    raise exception 'Cette pièce est sur un devis.';
  end if;
  if v_line.reception_status = 'RECEIVED' then
    raise exception 'Pièce déjà reçue au magasin.';
  end if;
  if v_line.supplier_id is null then
    raise exception 'Cette pièce n''est pas sur une tournée fournisseur.';
  end if;
  select * into v_supplier from public.suppliers s where s.id = v_line.supplier_id;
  if coalesce(v_supplier.own_delivery, false) then
    raise exception 'Ce fournisseur livre lui-même : il n''y a pas de tournée à reporter.';
  end if;

  if p_date is null or v_name is null then
    raise exception 'Choisissez une tournée.';
  end if;
  if p_date < v_today then
    raise exception 'Cette date est passée.';
  end if;

  -- The tournée must be one of the magasin's (Paramètres → Tournées) for that weekday.
  perform public.seed_default_tour_schedule(v_org);
  select s.slot_start into v_slot
  from public.tour_schedule s
  where s.organization_id = v_org
    and s.weekday = extract(isodow from p_date)
    and s.name = v_name;
  if not found then
    raise exception 'Tournée inconnue pour ce jour : réglez les horaires dans Paramètres → Tournées.';
  end if;
  v_departure := (p_date + v_slot) at time zone 'Europe/Paris';
  if v_departure <= now() then
    raise exception 'Cette tournée est déjà partie.';
  end if;

  v_target := public.ensure_supplier_tour_row(v_org, p_date, v_name, v_slot);
  if v_target = v_line.tour_id then
    raise exception 'La pièce est déjà sur cette tournée.';
  end if;

  if v_line.tour_id is not null then
    select * into v_previous from public.delivery_tours t where t.id = v_line.tour_id;
  end if;

  update public.order_lines
  set tour_id = v_target,
      prevue_le = v_departure,
      pickup_status = null,
      pickup_at = null,
      pickup_by = null,
      reception_status = case
        when reception_status in ('BACKORDER'::public.reception_status, 'NOT_RECEIVED'::public.reception_status)
          then 'PENDING'::public.reception_status
        else reception_status
      end
  where id = v_line.id;

  select * into v_tour from public.delivery_tours t where t.id = v_target;

  return jsonb_build_object(
    'line_id', v_line.id,
    'tour_id', v_tour.id,
    'tour_name', v_tour.name,
    'tour_date', v_tour.tour_date,
    'tour_slot', to_char(v_tour.slot_start, 'HH24:MI'),
    'prevue_le', v_departure,
    'previous_tour_name', v_previous.name,
    'previous_tour_date', v_previous.tour_date
  );
end;
$$;
revoke execute on function public.move_line_to_tour(uuid, date, text) from public, anon;
grant execute on function public.move_line_to_tour(uuid, date, text) to authenticated;

notify pgrst, 'reload schema';
