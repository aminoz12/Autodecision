-- Operational RPC helpers for the SaaS app.
-- Run after full_saas.sql. These functions keep stock/reception mutations
-- atomic inside Postgres while respecting the current authenticated org.

create or replace function public.adjust_stock_item(
  p_sku text,
  p_name text,
  p_delta integer
)
returns public.stock_items
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid := public.current_user_org_id();
  result_row public.stock_items;
  clean_sku text := nullif(trim(p_sku), '');
  clean_name text := nullif(trim(p_name), '');
begin
  if org is null then
    raise exception 'No organization for current user';
  end if;
  if clean_sku is null then
    raise exception 'SKU is required';
  end if;

  insert into public.stock_items (
    organization_id,
    sku,
    name,
    quantity_on_hand
  )
  values (
    org,
    clean_sku,
    coalesce(clean_name, clean_sku),
    p_delta
  )
  on conflict (organization_id, sku) do update set
    quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
    name = coalesce(clean_name, public.stock_items.name),
    updated_at = now()
  returning * into result_row;

  return result_row;
end;
$$;

grant execute on function public.adjust_stock_item(text, text, integer) to authenticated;

create or replace function public.receive_order_line(
  p_line_id uuid
)
returns public.order_lines
language plpgsql
security definer
set search_path = public
as $$
declare
  org uuid := public.current_user_org_id();
  line_row public.order_lines;
  result_row public.order_lines;
  qty_to_receive integer;
begin
  if org is null then
    raise exception 'No organization for current user';
  end if;

  select *
  into line_row
  from public.order_lines
  where id = p_line_id
    and organization_id = org
  for update;

  if not found then
    raise exception 'Order line not found or not in current organization';
  end if;

  qty_to_receive := greatest(line_row.quantity - line_row.qte_recue, 0);

  update public.order_lines
  set qte_recue = quantity,
      reception_status = 'RECEIVED',
      received_at = now()
  where id = line_row.id
    and organization_id = org
  returning * into result_row;

  if qty_to_receive > 0 then
    insert into public.stock_items (
      organization_id,
      sku,
      name,
      quantity_on_hand
    )
    values (
      org,
      line_row.reference,
      line_row.nom_produit,
      qty_to_receive
    )
    on conflict (organization_id, sku) do update set
      quantity_on_hand = public.stock_items.quantity_on_hand + excluded.quantity_on_hand,
      name = coalesce(public.stock_items.name, excluded.name),
      updated_at = now();
  end if;

  return result_row;
end;
$$;

grant execute on function public.receive_order_line(uuid) to authenticated;
