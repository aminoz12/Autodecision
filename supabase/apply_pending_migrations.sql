-- ============================================================================
-- ALL PENDING MIGRATIONS combined for manual application via the Supabase
-- SQL editor (Dashboard > SQL Editor > paste > Run).
-- Every statement is idempotent - safe to run more than once.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- >>> migrations/20260613020000_consigne_retour.sql
-- ────────────────────────────────────────────────────────────────────────────
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

-- ────────────────────────────────────────────────────────────────────────────
-- >>> migrations/20260702010000_avoir_lifecycle.sql
-- ────────────────────────────────────────────────────────────────────────────
-- ============================================================================
--  Avoir (credit note) lifecycle — sheet parity: MONTANT UTILISE / RESTE,
--  échéance +1 an, and using an avoir as payment on a new order.
--
--  * credit_notes.used_amount : cumulative amount already consumed; the
--    remaining balance is amount - used_amount (the sheet's RESTE DU MONTANT).
--  * credit_notes.client_id becomes nullable so a comptoir refund with no
--    client record can still be compensated with an avoir.
--  * return_treatment gains AVOIR: the return was compensated by a credit
--    note instead of a cash refund.
--  * orders.avoir_id / avoir_applique : which avoir paid part of the order
--    and for how much.
--  * apply_credit_note() consumes an avoir atomically (row lock): validates
--    balance + expiry, bumps used_amount, flips statut to PARTIEL / UTILISE,
--    and decrements the order's solde_restant.
-- ============================================================================

-- 1) credit_notes: consumption tracking --------------------------------------
alter table public.credit_notes
  add column if not exists used_amount numeric(14,2) not null default 0;

do $$ begin
  alter table public.credit_notes alter column client_id drop not null;
exception when others then null; end $$;

-- 2) sales_returns: a return can be settled with an avoir --------------------
alter type public.return_treatment add value if not exists 'AVOIR';

-- 3) orders: an avoir can pay (part of) an order ------------------------------
alter table public.orders
  add column if not exists avoir_id uuid references public.credit_notes (id) on delete set null;
alter table public.orders
  add column if not exists avoir_applique numeric(14,2) not null default 0;

-- 4) Atomic consumption ---------------------------------------------------
-- SECURITY INVOKER on purpose: RLS keeps every read/update inside the
-- caller's organization even if p_org is forged.
create or replace function public.apply_credit_note(
  p_org uuid,
  p_credit uuid,
  p_order uuid,
  p_amount numeric
) returns numeric
language plpgsql set search_path = public as $$
declare
  v_remaining numeric;
  v_echeance date;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Montant d''avoir invalide.';
  end if;

  select cn.amount - cn.used_amount, cn.echeance
    into v_remaining, v_echeance
  from public.credit_notes cn
  where cn.id = p_credit and cn.organization_id = p_org
  for update;

  if not found then
    raise exception 'Avoir introuvable.';
  end if;
  if v_echeance is not null and v_echeance < current_date then
    raise exception 'Avoir expiré depuis le %.', to_char(v_echeance, 'DD/MM/YYYY');
  end if;
  if v_remaining < p_amount then
    raise exception 'Solde d''avoir insuffisant (reste % €).', v_remaining;
  end if;

  update public.credit_notes
     set used_amount = used_amount + p_amount,
         statut = case when used_amount + p_amount >= amount
                       then 'UTILISE'::public.credit_status
                       else 'PARTIEL'::public.credit_status end,
         updated_at = now()
   where id = p_credit;

  update public.orders
     set avoir_id = p_credit,
         avoir_applique = avoir_applique + p_amount,
         solde_restant = greatest(0, solde_restant - p_amount),
         updated_at = now()
   where id = p_order and organization_id = p_org;

  if not found then
    raise exception 'Commande introuvable.';
  end if;

  return v_remaining - p_amount;
end;
$$;
grant execute on function public.apply_credit_note(uuid, uuid, uuid, numeric) to authenticated;

notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- >>> migrations/20260709010000_rename_sales_returns_created_at.sql
-- ────────────────────────────────────────────────────────────────────────────
-- ============================================================================
--  sales_returns."createdAt" -> created_at
--
--  The remote table was originally created with a camelCase "createdAt"
--  column, while schema.sql, every other table and the app code all use
--  snake_case created_at. The Retours page fails with
--  « column sales_returns.created_at does not exist » — rename to align.
-- ============================================================================

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sales_returns'
      and column_name = 'createdAt'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sales_returns'
      and column_name = 'created_at'
  ) then
    alter table public.sales_returns rename column "createdAt" to created_at;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- >>> migrations/20260709020000_rename_credit_consign_created_at.sql
-- ────────────────────────────────────────────────────────────────────────────
-- ============================================================================
--  credit_notes."createdAt" / consignment_entries."createdAt" -> created_at
--
--  Same drift as sales_returns (20260709010000): the original remote tables
--  were created with camelCase "createdAt" while schema.sql and the app code
--  use snake_case created_at. The Avoirs page fails with
--  « column credit_notes.created_at does not exist » — rename both to align.
-- ============================================================================

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'credit_notes'
      and column_name = 'createdAt'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'credit_notes'
      and column_name = 'created_at'
  ) then
    alter table public.credit_notes rename column "createdAt" to created_at;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'consignment_entries'
      and column_name = 'createdAt'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'consignment_entries'
      and column_name = 'created_at'
  ) then
    alter table public.consignment_entries rename column "createdAt" to created_at;
  end if;
end $$;

notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- >>> migrations/20260814010000_garagiste_rls_hardening.sql
-- ────────────────────────────────────────────────────────────────────────────
-- ============================================================================
--  Garagiste RLS hardening (audit findings, critical severity)
--
--  1) sales_returns: the baseline org-only policy `returns_all` was never
--     dropped when 20260613017000 added the client-scoped sales_returns_all.
--     Permissive policies OR together, so any garagiste could read/update/
--     delete EVERY return in the org. Drop the leftover.
--  2) credit_notes / consignment_entries: only org-scoped policies existed
--     (duplicated, no client scoping) — a garagiste could read AND mint/alter
--     every client's avoirs and consignes. Replace with: staff see the whole
--     org, a garagiste sees only rows of their own client_id, and only staff
--     may write.
--  3) quotes: SELECT was org-wide, exposing magasin quote payloads (buy/sell
--     prices) to garagistes. Restrict the whole table to staff.
-- ============================================================================

-- 1) sales_returns ----------------------------------------------------------
drop policy if exists returns_all on public.sales_returns;

-- 2) credit_notes -----------------------------------------------------------
drop policy if exists credits_all on public.credit_notes;
drop policy if exists credit_notes_all on public.credit_notes;
create policy credit_notes_all on public.credit_notes
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null
         or client_id = public.current_user_client_id())
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

--    consignment_entries ----------------------------------------------------
drop policy if exists consign_all on public.consignment_entries;
drop policy if exists consignment_entries_all on public.consignment_entries;
create policy consignment_entries_all on public.consignment_entries
  using (
    organization_id = public.current_user_org_id()
    and (public.current_user_client_id() is null
         or client_id = public.current_user_client_id())
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  );

-- 3) quotes: staff only -----------------------------------------------------
drop policy if exists quotes_all on public.quotes;
create policy quotes_all on public.quotes
  using (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
  )
  with check (
    organization_id = public.current_user_org_id()
    and public.current_user_client_id() is null
    and created_by_id = auth.uid()
  );

notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- >>> migrations/20260814020000_per_org_uniques.sql
-- ────────────────────────────────────────────────────────────────────────────
-- ============================================================================
--  Per-organization uniqueness (multi-tenant fix, audit finding)
--
--  The live DB carries GLOBAL unique constraints on values that are only
--  unique within one organization:
--    * stock_items.sku            — OEM references are shared across shops;
--      the second org to stock a known reference breaks its "Reçu" button.
--    * quotes.ref                 — every org generates DEV-YYYY-00001.
--    * supplier_receptions.reference
--  Replace each with UNIQUE (organization_id, ...). Existing data satisfies
--  the composite constraint trivially (global-unique is stricter).
-- ============================================================================

alter table public.stock_items
  drop constraint if exists stock_items_sku_key;
create unique index if not exists stock_items_org_sku_key
  on public.stock_items (organization_id, sku);

alter table public.quotes
  drop constraint if exists quotes_ref_key;
create unique index if not exists quotes_org_ref_key
  on public.quotes (organization_id, ref);

alter table public.supplier_receptions
  drop constraint if exists uq_supplier_receptions_reference;
create unique index if not exists supplier_receptions_org_reference_key
  on public.supplier_receptions (organization_id, reference);

notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────────
-- Record these versions in the CLI migration history so a future
-- `supabase db push` does not try to re-apply them.
-- ────────────────────────────────────────────────────────────────────────────
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version text not null primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260613020000', 'consigne_retour'),
  ('20260702010000', 'avoir_lifecycle'),
  ('20260709010000', 'rename_sales_returns_created_at'),
  ('20260709020000', 'rename_credit_consign_created_at'),
  ('20260814010000', 'garagiste_rls_hardening'),
  ('20260814020000', 'per_org_uniques')
on conflict (version) do nothing;
