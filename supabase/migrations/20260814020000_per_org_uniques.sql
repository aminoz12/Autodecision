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
