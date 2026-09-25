-- Module apres-vente (2026-09-25) - correctif 1 : la recherche par telephone.
--
-- sav_search_sales() gardait les espaces des numeros (« 06 12 34 56 78 ») avant
-- de chercher une suite de 9 chiffres : 175 commandes sur 243 etaient introuvables
-- par telephone. Chaque numero est desormais reduit a ses chiffres separement.

create or replace function public.sav_search_sales(p_q text, p_limit integer default 120)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_q text := trim(coalesce(p_q, ''));
  v_plate text := upper(regexp_replace(coalesce(p_q, ''), '[^A-Za-z0-9]', '', 'g'));
  v_digits text := regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g');
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  if length(v_q) < 3 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(row_json order by sale_date desc, designation)
    from (
      select
        public.line_warranty_start(l, o) as sale_date,
        l.nom_produit as designation,
        jsonb_build_object(
          'line_id', l.id, 'order_id', o.id, 'order_ref', o.ref_demande, 'order_date', o.date_commande,
          'warranty_start', public.line_warranty_start(l, o),
          'client_id', o.client_id, 'client_name', coalesce(c.name, 'Client comptoir'),
          'client_phone', coalesce(nullif(o.client_phone, ''), c.phone), 'is_garage', coalesce(c.is_garage, false),
          'plate', o.immatriculation, 'plate_norm', o.immat_norm, 'vehicle_model', o.vehicle_model, 'km', o.kilometrage,
          'garage_poseur', o.garage_poseur_name,
          'designation', l.nom_produit, 'reference', l.reference, 'marque', l.marque, 'famille', l.famille,
          'serial_number', l.serial_number, 'quantity', l.quantity, 'unit_price', l.prix_vente_unitaire,
          'supplier_id', l.supplier_id, 'supplier', s.name,
          'warranty_months', l.warranty_months, 'warranty_extension_months', l.warranty_extension_months,
          'handed_over', l.qte_remise, 'reception_status', l.reception_status,
          'consigne', l.consigne,
          'consigne_status', (select e.status from public.consignment_entries e where e.order_line_id = l.id limit 1),
          'returned', exists (select 1 from public.sales_returns r where r.order_line_id = l.id),
          'open_case', (
            select jsonb_build_object('id', k.id, 'ref', k.ref, 'type', k.type, 'client_status', k.client_status, 'closed', k.closed_at is not null)
            from public.sav_cases k where k.order_line_id = l.id order by k.opened_at desc limit 1
          )
        ) as row_json
      from public.order_lines l
      join public.orders o on o.id = l.order_id
      left join public.clients c on c.id = o.client_id
      left join public.suppliers s on s.id = l.supplier_id
      where o.organization_id = v_org
        and o.devis = false and o.is_restock = false and o.cancelled_at is null
        and (
          (length(v_plate) >= 4 and o.immat_norm like v_plate || '%')
          -- Each phone stripped to its digits on its own: « 06 12 34 56 78 » must match 0612345678.
          or (length(v_digits) >= 6 and (
               regexp_replace(coalesce(o.client_phone, ''), '[^0-9]', '', 'g') like '%' || right(v_digits, 9) || '%'
               or regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || right(v_digits, 9) || '%'))
          or o.ref_demande ilike '%' || v_q || '%'
          or c.name ilike '%' || v_q || '%'
          or l.reference ilike v_q || '%'
          or l.serial_number ilike v_q || '%'
        )
      order by o.date_commande desc
      limit greatest(1, least(coalesce(p_limit, 120), 400))
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.sav_search_sales(text, integer) from public, anon;
grant execute on function public.sav_search_sales(text, integer) to authenticated;

notify pgrst, 'reload schema';
