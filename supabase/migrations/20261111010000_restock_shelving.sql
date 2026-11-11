-- « À réintégrer pour le stock » (2026-11-11).
--
-- Une pièce de réapprovisionnement pointée reçue entre tout de suite dans les
-- quantités du stock (set_order_line_reception_status) — mais physiquement
-- elle attend encore d'être remise en rayon. Le comptoir veut la liste de ces
-- pièces sous « Stock » dans le menu, et les cocher une fois rangées.
--
--  * order_lines.shelved_qty / shelved_at / shelved_by : unités déjà rangées
--    (une ligne reçue en plusieurs fois revient dans la liste pour le reste).
--  * restock_to_shelve() : les lignes des commandes de réappro dont il reste
--    des unités reçues à ranger, pour la page et le compteur du menu.
--  * shelve_restock_line(p_line_id) : « Rangée » — comptoir seulement, le
--    pointeur de la tablette est reconnu (current_actor_id).
--  * Les réceptions d'avant aujourd'hui sont considérées rangées : la liste
--    démarre avec les pièces du jour, pas avec des semaines d'historique.

alter table public.order_lines
  add column if not exists shelved_qty integer not null default 0,
  add column if not exists shelved_at timestamptz,
  add column if not exists shelved_by uuid;

update public.order_lines l
set shelved_qty = l.qte_recue,
    shelved_at = coalesce(l.received_at, now())
from public.orders o
where o.id = l.order_id
  and o.is_restock
  and l.qte_recue > l.shelved_qty
  and (l.received_at is null
       or l.received_at < ((timezone('Europe/Paris', now())::date)::timestamp at time zone 'Europe/Paris'));

create index if not exists idx_order_lines_to_shelve
  on public.order_lines (organization_id)
  where qte_recue > shelved_qty;

create or replace function public.restock_to_shelve()
returns table (
  line_id uuid,
  order_id uuid,
  order_ref text,
  reference text,
  reference_commande text,
  designation text,
  quantity integer,
  qte_recue integer,
  shelved_qty integer,
  to_shelve integer,
  received_at timestamptz,
  supplier_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  return query
    select l.id,
           o.id,
           o.ref_demande::text,
           l.reference::text,
           l.reference_commande,
           l.nom_produit::text,
           l.quantity,
           l.qte_recue,
           l.shelved_qty,
           (l.qte_recue - l.shelved_qty),
           l.received_at,
           s.name::text
    from public.order_lines l
    join public.orders o on o.id = l.order_id
    left join public.suppliers s on s.id = l.supplier_id
    where l.organization_id = v_org
      and o.is_restock
      and o.cancelled_at is null
      and l.qte_recue > l.shelved_qty
    order by l.received_at desc nulls last, l.id;
end;
$$;

revoke execute on function public.restock_to_shelve() from public, anon;
grant execute on function public.restock_to_shelve() to authenticated;

create or replace function public.shelve_restock_line(p_line_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_line public.order_lines;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  select l.* into v_line
  from public.order_lines l
  join public.orders o on o.id = l.order_id
  where l.id = p_line_id and l.organization_id = v_org and o.is_restock
  for update of l;
  if not found then
    raise exception 'Pièce de réapprovisionnement introuvable.';
  end if;
  if v_line.qte_recue <= v_line.shelved_qty then
    raise exception 'Cette pièce est déjà rangée.';
  end if;
  update public.order_lines
  set shelved_qty = qte_recue,
      shelved_at = now(),
      shelved_by = coalesce(public.current_actor_id(), auth.uid())
  where id = v_line.id;
end;
$$;

revoke execute on function public.shelve_restock_line(uuid) from public, anon;
grant execute on function public.shelve_restock_line(uuid) to authenticated;

notify pgrst, 'reload schema';
