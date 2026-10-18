-- Tournées : recommander une pièce indisponible chez un autre fournisseur (2026-10-18).
--
-- Demande du magasin : « en cas d'indisponibilité, changer le fournisseur ;
-- la référence fournisseur doit apparaître ».
--
-- Quand le livreur marque une pièce « indisponible » chez un fournisseur
-- (order_lines.pickup_status = 'UNAVAILABLE'), le comptoir n'avait aucun moyen
-- de la recommander ailleurs : supplier_id, tour_id et pickup_* ne sont pas
-- modifiables par l'application (seule reference_commande l'est, par
-- PostgREST), et la seule issue était de refaire une commande.
-- change_line_supplier(ligne, fournisseur, réf.) déplace la pièce :
--
--  1. supplier_id = le nouveau fournisseur ; reference_commande = sa référence
--     à lui (celle de l'ancien fournisseur n'a plus de sens : nulle si absente).
--  2. La pièce repart sur la prochaine tournée du magasin (next_tour_for, selon
--     les horaires de Paramètres → Tournées), prevue_le = son départ. Le
--     trigger order_lines_supplier_delivery finit le travail dans le même
--     UPDATE : décalage de lead_days jours, ou tour_id nul + prevue_le à J+n
--     12:00 si le fournisseur livre lui-même (own_delivery).
--  3. pickup_status / pickup_at / pickup_by sont remis à zéro (à récupérer).
--     Une pièce en reliquat (BACKORDER) ou jamais reçue (NOT_RECEIVED) redevient
--     attendue (PENDING) ; PENDING et PARTIAL restent tels quels.
--  4. Le comptoir est prévenu (SUPPLIER_CHANGED). Le retard éventuel à annoncer
--     au client reste géré par order_lines_sav_flow (prevue_le qui recule).
--
-- Réservé au comptoir (ADMIN / CAISSIER) : le livreur garde set_line_pickup.
-- Une ligne de stock (supplier_id nul) est acceptée : elle devient une ligne
-- fournisseur. Une pièce déjà reçue, une commande annulée ou un devis sont
-- refusés. Le journal (audit_order_lines → audit_row) enregistre la
-- modification comme toute mise à jour de order_lines.

create or replace function public.change_line_supplier(
  p_line_id uuid,
  p_supplier_id uuid,
  p_reference_commande text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
  v_order public.orders;
  v_target public.suppliers;
  v_old_supplier text;
  v_next record;
  v_tour_id uuid;
  v_delivery_at timestamptz;
  v_after public.order_lines;
  v_tour public.delivery_tours;
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

  select * into v_target
  from public.suppliers s
  where s.id = p_supplier_id and s.organization_id = v_org;
  if not found then
    raise exception 'Fournisseur introuvable.';
  end if;
  if v_line.supplier_id = v_target.id then
    raise exception 'Même fournisseur.';
  end if;

  if v_line.supplier_id is not null then
    select s.name into v_old_supplier from public.suppliers s where s.id = v_line.supplier_id;
  end if;

  -- Fournisseur de tournée : la prochaine tournée du magasin (le trigger la
  -- décale de lead_days). Fournisseur qui livre lui-même : pas de tournée, le
  -- trigger pose prevue_le.
  if not coalesce(v_target.own_delivery, false) then
    select * into v_next from public.next_tour_for(v_org, now());
    v_tour_id := public.ensure_supplier_tour_row(v_org, v_next.tour_date, v_next.tour_name, v_next.tour_slot);
    v_delivery_at := v_next.delivery_at;
  end if;

  update public.order_lines
  set supplier_id = v_target.id,
      tour_id = v_tour_id,
      prevue_le = coalesce(v_delivery_at, prevue_le),
      pickup_status = null,
      pickup_at = null,
      pickup_by = null,
      reference_commande = nullif(trim(coalesce(p_reference_commande, '')), ''),
      reception_status = case
        when reception_status in ('BACKORDER'::public.reception_status, 'NOT_RECEIVED'::public.reception_status)
          then 'PENDING'::public.reception_status
        else reception_status
      end
  where id = v_line.id
  returning * into v_after;

  perform public.notify(v_org, 'STAFF', 'SUPPLIER_CHANGED',
    format('%s recommandée chez %s', v_line.reference, v_target.name),
    format('%s — commande %s. Était chez %s%s.', v_line.nom_produit, v_order.ref_demande,
           coalesce(v_old_supplier, 'le stock'),
           case when v_line.pickup_status = 'UNAVAILABLE' then ' (indisponible)' else '' end),
    '/dashboard/tournees', 'order_lines', v_line.id);

  -- Lecture après le trigger : la tournée réellement retenue (décalée de lead_days).
  if v_after.tour_id is not null then
    select * into v_tour from public.delivery_tours t where t.id = v_after.tour_id;
  end if;

  return jsonb_build_object(
    'line_id', v_after.id,
    'supplier_id', v_target.id,
    'supplier', v_target.name,
    'own_delivery', coalesce(v_target.own_delivery, false),
    'tour_id', v_after.tour_id,
    'tour_name', v_tour.name,
    'tour_date', v_tour.tour_date,
    'tour_slot', to_char(v_tour.slot_start, 'HH24:MI'),
    'prevue_le', v_after.prevue_le
  );
end;
$$;
revoke execute on function public.change_line_supplier(uuid, uuid, text) from public, anon;
grant execute on function public.change_line_supplier(uuid, uuid, text) to authenticated;

notify pgrst, 'reload schema';
