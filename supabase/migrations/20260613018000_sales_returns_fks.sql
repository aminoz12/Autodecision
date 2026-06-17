-- ============================================================================
--  FKs for sales_returns embeds (dashboard Retours + garagiste returns).
--  sales_returns.order_id / client_id / supplier_id had no FK, so PostgREST
--  can't embed orders(...)/clients(...)/suppliers(...). NOT VALID = safe for
--  existing rows; NOTIFY reloads PostgREST's schema cache.
-- ============================================================================

do $$ begin
  alter table public.sales_returns
    add constraint sales_returns_order_id_fkey
    foreign key (order_id) references public.orders (id) on delete set null not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.sales_returns
    add constraint sales_returns_client_id_fkey
    foreign key (client_id) references public.clients (id) on delete set null not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.sales_returns
    add constraint sales_returns_supplier_id_fkey
    foreign key (supplier_id) references public.suppliers (id) on delete set null not valid;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
