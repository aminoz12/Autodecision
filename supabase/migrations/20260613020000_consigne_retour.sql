-- ============================================================================
--  Consigne (returnable deposit / core charge) + retour impossible.
--
--  * order_lines gains per-line flags written from the Nouvelle commande form
--    and from Rajout rapide:
--      - retour_impossible : the part can never be returned (garagiste blocked,
--        magasin refund blocked for that line).
--      - consigne          : the part carries a returnable deposit.
--      - consigne_price     : the per-unit deposit amount (shown when consigne
--        is checked).
--  * consignment_entries (the "page consigne" register) is linked back to the
--    order / line that created it, and client_id becomes nullable so a comptoir
--    sale with no client record can still hold a deposit.
--  * sales_returns gains order_line_id so a walk-in refund recorded in the
--    Retours page can point at the exact line it refunds.
-- ============================================================================

-- 1) order_lines: consigne + retour impossible -------------------------------
alter table public.order_lines
  add column if not exists retour_impossible boolean not null default false;
alter table public.order_lines
  add column if not exists consigne boolean not null default false;
alter table public.order_lines
  add column if not exists consigne_price numeric(14,2);

-- 2) consignment_entries: link to its origin order/line ----------------------
do $$ begin
  alter table public.consignment_entries alter column client_id drop not null;
exception when others then null; end $$;

alter table public.consignment_entries
  add column if not exists order_id uuid references public.orders (id) on delete set null;
alter table public.consignment_entries
  add column if not exists order_line_id uuid references public.order_lines (id) on delete set null;
alter table public.consignment_entries
  add column if not exists reference text;

-- 3) sales_returns: link a walk-in refund to the exact line ------------------
alter table public.sales_returns
  add column if not exists order_line_id uuid references public.order_lines (id) on delete set null;

notify pgrst, 'reload schema';
