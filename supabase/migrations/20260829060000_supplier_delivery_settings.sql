-- ============================================================================
--  Supplier delivery settings.
--
--  * own_delivery : the supplier delivers with its own driver. Lines ordered
--                   from it are NOT expected on a magasin tournée (tour_id
--                   null) — they still have to be pointed on reception.
--  * lead_days    : expected delay in days (0 = J, same day; 1 = J+1 …).
--                   Tournée suppliers keep the same slot, shifted by that
--                   many days; own-delivery suppliers get prevue_le = J+n.
--
--  Applied by a BEFORE INSERT/UPDATE trigger on order_lines, so every path
--  (create_order_with_lines, reorder_stock_lines, quick add) is covered.
-- ============================================================================

alter table public.suppliers
  add column if not exists own_delivery boolean not null default false,
  add column if not exists lead_days integer not null default 0
    check (lead_days between 0 and 30);

create or replace function public.order_lines_apply_supplier_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_own boolean;
  v_lead integer;
  v_tour public.delivery_tours;
  v_new_tour_id uuid;
  v_local timestamp;
begin
  if new.supplier_id is null then
    return new;
  end if;

  select s.own_delivery, s.lead_days into v_own, v_lead
  from public.suppliers s
  where s.id = new.supplier_id;
  if not found then
    return new;
  end if;
  v_lead := coalesce(v_lead, 0);
  v_local := timezone('Europe/Paris', now());

  if v_own then
    -- Delivered by the supplier: no magasin tournée, expected around J+n.
    new.tour_id := null;
    new.prevue_le := ((v_local::date + v_lead) + time '12:00') at time zone 'Europe/Paris';
    return new;
  end if;

  if v_lead > 0 and new.tour_id is not null then
    select * into v_tour from public.delivery_tours t where t.id = new.tour_id;
    if found then
      select t.id into v_new_tour_id
      from public.delivery_tours t
      where t.organization_id = v_tour.organization_id
        and t.name = v_tour.name
        and t.tour_date = v_tour.tour_date + v_lead
      limit 1;
      if v_new_tour_id is null then
        insert into public.delivery_tours (organization_id, name, tour_date, slot_start)
        values (v_tour.organization_id, v_tour.name, v_tour.tour_date + v_lead, v_tour.slot_start)
        returning delivery_tours.id into v_new_tour_id;
      end if;
      new.tour_id := v_new_tour_id;
      new.prevue_le := ((v_tour.tour_date + v_lead) + coalesce(v_tour.slot_start, time '10:00')) at time zone 'Europe/Paris';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists order_lines_supplier_delivery on public.order_lines;
create trigger order_lines_supplier_delivery
  before insert or update of supplier_id on public.order_lines
  for each row execute function public.order_lines_apply_supplier_delivery();

revoke execute on function public.order_lines_apply_supplier_delivery() from public, anon, authenticated;

notify pgrst, 'reload schema';
