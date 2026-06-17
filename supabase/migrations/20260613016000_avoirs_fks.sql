-- ============================================================================
--  Add missing foreign keys for the Avoirs page embeds.
--
--  credit_notes.client_id / order_id and consignment_entries.client_id hold
--  the right uuids but had no FK constraint, so PostgREST can't embed
--  clients(name) / orders(ref_demande) ("Could not find a relationship…").
--
--  Added NOT VALID so existing rows are never rejected; PostgREST still
--  detects the relationship. NOTIFY reloads its schema cache immediately.
-- ============================================================================

do $$ begin
  alter table public.credit_notes
    add constraint credit_notes_client_id_fkey
    foreign key (client_id) references public.clients (id) on delete cascade not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.credit_notes
    add constraint credit_notes_order_id_fkey
    foreign key (order_id) references public.orders (id) on delete set null not valid;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.consignment_entries
    add constraint consignment_entries_client_id_fkey
    foreign key (client_id) references public.clients (id) on delete cascade not valid;
exception when duplicate_object then null; end $$;

notify pgrst, 'reload schema';
