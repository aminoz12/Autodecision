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
