-- Facturation conforme (audit 2026-09-07, chantier 3).
--
--  * organizations: identité légale (SIRET, TVA intracom, RCS, capital, forme,
--    IBAN/BIC), taux de TVA par défaut, préfixe et pied de facture.
--  * clients: adresse, SIRET, TVA intracom (garages).
--  * order_lines.tva_rate: taux par ligne (null = taux de l'organisation).
--  * invoices: document IMMUABLE émis à partir d'une commande (FACTURE) ou d'un
--    avoir (AVOIR). Instantané vendeur / acheteur / lignes / totaux par taux,
--    numérotation continue par organisation et par an (invoice_counters, sans
--    trou : l'incrément est annulé si la transaction échoue), chaîne de
--    hachage SHA-256 (content_hash / prev_hash). Toute modification ou
--    suppression est refusée par trigger, même en service role : une erreur se
--    corrige par un avoir.
--  RPC : emit_invoice(order), emit_credit_note_document(credit_note),
--        update_organization_profile(jsonb).

create extension if not exists pgcrypto with schema extensions;

alter table public.organizations
  add column if not exists legal_name text,
  add column if not exists legal_form text,
  add column if not exists siret text,
  add column if not exists tva_intra text,
  add column if not exists rcs text,
  add column if not exists capital text,
  add column if not exists iban text,
  add column if not exists bic text,
  add column if not exists tva_rate numeric(5,2) not null default 20,
  add column if not exists invoice_prefix text not null default 'FA',
  add column if not exists invoice_footer text,
  add column if not exists payment_terms_text text;
alter table public.organizations drop constraint if exists organizations_tva_rate_check;
alter table public.organizations add constraint organizations_tva_rate_check check (tva_rate >= 0 and tva_rate <= 100);

alter table public.clients
  add column if not exists address text,
  add column if not exists siret text,
  add column if not exists tva_intra text;

alter table public.order_lines add column if not exists tva_rate numeric(5,2);
alter table public.order_lines drop constraint if exists order_lines_tva_rate_check;
alter table public.order_lines add constraint order_lines_tva_rate_check check (tva_rate is null or (tva_rate >= 0 and tva_rate <= 100));

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------
create table if not exists public.invoice_counters (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  year integer not null,
  kind text not null,
  next integer not null default 1,
  primary key (organization_id, year, kind)
);
alter table public.invoice_counters enable row level security;
revoke all on public.invoice_counters from public, anon, authenticated;

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  number text not null,
  kind text not null check (kind in ('FACTURE', 'AVOIR')),
  issued_at timestamptz not null default now(),
  issued_by uuid references auth.users (id) on delete set null,
  order_id uuid references public.orders (id) on delete restrict,
  client_id uuid references public.clients (id) on delete restrict,
  credit_note_id uuid references public.credit_notes (id) on delete restrict,
  related_invoice_id uuid references public.invoices (id) on delete restrict,
  seller jsonb not null,
  buyer jsonb not null,
  lines jsonb not null,
  totals jsonb not null,
  due_date date,
  payment_terms text,
  mode_paiement text,
  note text,
  prev_hash text,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, number)
);
create unique index if not exists invoices_one_facture_per_order on public.invoices (order_id) where kind = 'FACTURE';
create unique index if not exists invoices_one_doc_per_credit on public.invoices (credit_note_id) where kind = 'AVOIR';
create index if not exists invoices_org_issued_idx on public.invoices (organization_id, issued_at desc);
create index if not exists invoices_org_client_idx on public.invoices (organization_id, client_id);

alter table public.invoices enable row level security;
drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select
  using (
    organization_id = public.current_user_org_id()
    and public.has_operational_access(organization_id)
    and (
      public.is_counter_staff()
      or (public.current_user_client_id() is not null and client_id = public.current_user_client_id())
    )
  );
revoke all on public.invoices from public, anon, authenticated;
grant select on public.invoices to authenticated;

create or replace function public.invoices_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Invoices are immutable (%). Issue a credit note (avoir) to correct it.', coalesce(old.number, '');
end;
$$;
drop trigger if exists invoices_no_update on public.invoices;
create trigger invoices_no_update before update or delete on public.invoices
  for each row execute function public.invoices_immutable();

drop trigger if exists audit_invoices on public.invoices;
create trigger audit_invoices after insert on public.invoices
  for each row execute function public.audit_row();

-- ---------------------------------------------------------------------
-- Numbering: gapless per organisation, year and kind
-- ---------------------------------------------------------------------
create or replace function public.next_invoice_number(p_org uuid, p_kind text, p_prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from timezone('Europe/Paris', now()))::integer;
  v_seq integer;
begin
  insert into public.invoice_counters (organization_id, year, kind, next)
  values (p_org, v_year, p_kind, 2)
  on conflict (organization_id, year, kind)
  do update set next = public.invoice_counters.next + 1
  returning next - 1 into v_seq;
  return format('%s-%s-%s', p_prefix, v_year, lpad(v_seq::text, 5, '0'));
end;
$$;
revoke execute on function public.next_invoice_number(uuid, text, text) from public, anon, authenticated;

create or replace function public.invoice_hash(p_number text, p_issued timestamptz, p_lines jsonb, p_totals jsonb, p_prev text)
returns text
language sql
immutable
as $$
  select encode(extensions.digest(convert_to(
    p_number || '|' || p_issued::text || '|' || p_lines::text || '|' || p_totals::text || '|' || coalesce(p_prev, ''),
    'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.seller_snapshot(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'name', o.name, 'legal_name', o.legal_name, 'legal_form', o.legal_form,
    'siret', o.siret, 'tva_intra', o.tva_intra, 'rcs', o.rcs, 'capital', o.capital,
    'address', o.address, 'city', o.city, 'phone', o.phone, 'iban', o.iban, 'bic', o.bic,
    'logo_url', o.logo_url, 'invoice_footer', o.invoice_footer, 'tva_rate', o.tva_rate
  )
  from public.organizations o where o.id = p_org;
$$;
revoke execute on function public.seller_snapshot(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Émettre la facture d'une commande
-- ---------------------------------------------------------------------
create or replace function public.emit_invoice(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_org_row public.organizations;
  v_client public.clients;
  v_existing uuid;
  v_lines jsonb := '[]'::jsonb;
  v_l record;
  v_rate numeric;
  v_unit_ttc numeric;
  v_total_ttc numeric;
  v_total_ht numeric;
  v_ht numeric := 0;
  v_tva numeric := 0;
  v_ttc numeric := 0;
  v_by_rate jsonb := '{}'::jsonb;
  v_rate_key text;
  v_totals jsonb;
  v_buyer jsonb;
  v_number text;
  v_issued timestamptz := now();
  v_prev text;
  v_id uuid;
  v_terms text;
  v_due date;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);

  select * into v_order from public.orders
  where id = p_order_id and organization_id = v_org for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_order.devis or v_order.is_restock then
    raise exception 'Only a confirmed client order can be invoiced.';
  end if;
  select id into v_existing from public.invoices where order_id = v_order.id and kind = 'FACTURE';
  if v_existing is not null then
    return v_existing;
  end if;

  select * into v_org_row from public.organizations where id = v_org;
  if v_order.client_id is not null then
    select * into v_client from public.clients where id = v_order.client_id;
  end if;

  for v_l in
    select l.* from public.order_lines l
    where l.order_id = v_order.id and l.organization_id = v_org
      and l.reception_status <> 'NOT_RECEIVED'
    order by l.id
  loop
    v_rate := coalesce(v_l.tva_rate, v_org_row.tva_rate, 20);
    v_unit_ttc := round(v_l.prix_vente_unitaire, 2);
    v_total_ttc := round(v_l.quantity * v_unit_ttc, 2);
    v_total_ht := round(v_total_ttc / (1 + v_rate / 100), 2);
    v_lines := v_lines || jsonb_build_object(
      'reference', v_l.reference, 'designation', v_l.nom_produit, 'quantity', v_l.quantity,
      'unit_ttc', v_unit_ttc, 'unit_ht', round(v_unit_ttc / (1 + v_rate / 100), 2),
      'tva_rate', v_rate, 'total_ht', v_total_ht, 'total_tva', round(v_total_ttc - v_total_ht, 2), 'total_ttc', v_total_ttc
    );
    v_ht := v_ht + v_total_ht;
    v_tva := v_tva + (v_total_ttc - v_total_ht);
    v_ttc := v_ttc + v_total_ttc;
    v_rate_key := trim(trailing '.' from trim(trailing '0' from v_rate::text));
    v_by_rate := jsonb_set(
      v_by_rate, array[v_rate_key],
      jsonb_build_object(
        'ht', round(coalesce((v_by_rate #>> array[v_rate_key, 'ht'])::numeric, 0) + v_total_ht, 2),
        'tva', round(coalesce((v_by_rate #>> array[v_rate_key, 'tva'])::numeric, 0) + (v_total_ttc - v_total_ht), 2)
      ), true);

    -- Consigne (deposit): separate line, outside the VAT base.
    if v_l.consigne and coalesce(v_l.consigne_price, 0) > 0 then
      v_total_ttc := round(v_l.quantity * v_l.consigne_price, 2);
      v_lines := v_lines || jsonb_build_object(
        'reference', v_l.reference, 'designation', 'Consigne — ' || v_l.nom_produit, 'quantity', v_l.quantity,
        'unit_ttc', round(v_l.consigne_price, 2), 'unit_ht', round(v_l.consigne_price, 2),
        'tva_rate', 0, 'total_ht', v_total_ttc, 'total_tva', 0, 'total_ttc', v_total_ttc
      );
      v_ht := v_ht + v_total_ttc;
      v_ttc := v_ttc + v_total_ttc;
      v_by_rate := jsonb_set(v_by_rate, array['0'], jsonb_build_object(
        'ht', round(coalesce((v_by_rate #>> array['0', 'ht'])::numeric, 0) + v_total_ttc, 2),
        'tva', round(coalesce((v_by_rate #>> array['0', 'tva'])::numeric, 0), 2)), true);
    end if;
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'This order has no invoiceable line.';
  end if;

  v_totals := jsonb_build_object(
    'ht', round(v_ht, 2), 'tva', round(v_tva, 2), 'ttc', round(v_ttc, 2),
    'by_rate', v_by_rate,
    'order_total', v_order.montant_total,
    'avoir_applique', v_order.avoir_applique,
    'paid', v_order.montant_paye + v_order.avance_payee,
    'due', v_order.solde_restant
  );
  v_buyer := jsonb_build_object(
    'name', coalesce(v_client.name, 'Client comptoir'),
    'address', v_client.address, 'city', v_client.city,
    'phone', coalesce(v_client.phone, v_order.client_phone), 'email', coalesce(v_client.email, v_order.client_email),
    'siret', v_client.siret, 'tva_intra', v_client.tva_intra, 'is_garage', coalesce(v_client.is_garage, false),
    'immatriculation', v_order.immatriculation, 'vehicle_model', v_order.vehicle_model
  );
  if v_order.mode_paiement = 'EN_COMPTE' then
    v_due := coalesce(v_order.echeance, (v_issued at time zone 'Europe/Paris')::date + coalesce(v_client.payment_terms_days, 30));
    v_terms := coalesce(v_org_row.payment_terms_text, format('Paiement à %s jours, échéance le %s.', coalesce(v_client.payment_terms_days, 30), to_char(v_due, 'DD/MM/YYYY')));
  else
    v_due := (v_issued at time zone 'Europe/Paris')::date;
    v_terms := coalesce(v_org_row.payment_terms_text, 'Paiement comptant à réception.');
  end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':invoices'));
  select content_hash into v_prev from public.invoices
  where organization_id = v_org order by created_at desc, number desc limit 1;
  v_number := public.next_invoice_number(v_org, 'FACTURE', coalesce(nullif(trim(v_org_row.invoice_prefix), ''), 'FA'));

  insert into public.invoices (
    organization_id, number, kind, issued_at, issued_by, order_id, client_id,
    seller, buyer, lines, totals, due_date, payment_terms, mode_paiement, prev_hash, content_hash
  ) values (
    v_org, v_number, 'FACTURE', v_issued, auth.uid(), v_order.id, v_order.client_id,
    public.seller_snapshot(v_org), v_buyer, v_lines, v_totals, v_due, v_terms, v_order.mode_paiement,
    v_prev, public.invoice_hash(v_number, v_issued, v_lines, v_totals, v_prev)
  ) returning id into v_id;

  return v_id;
end;
$$;
revoke execute on function public.emit_invoice(uuid) from public, anon;
grant execute on function public.emit_invoice(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Document d'avoir (à partir d'un avoir existant)
-- ---------------------------------------------------------------------
create or replace function public.emit_credit_note_document(p_credit_note_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_credit public.credit_notes;
  v_org_row public.organizations;
  v_client public.clients;
  v_existing uuid;
  v_related uuid;
  v_rate numeric;
  v_ht numeric;
  v_lines jsonb;
  v_totals jsonb;
  v_buyer jsonb;
  v_number text;
  v_issued timestamptz := now();
  v_prev text;
  v_id uuid;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  select * into v_credit from public.credit_notes where id = p_credit_note_id and organization_id = v_org for update;
  if not found then
    raise exception 'Credit note not found.';
  end if;
  select id into v_existing from public.invoices where credit_note_id = v_credit.id and kind = 'AVOIR';
  if v_existing is not null then
    return v_existing;
  end if;
  select * into v_org_row from public.organizations where id = v_org;
  if v_credit.client_id is not null then
    select * into v_client from public.clients where id = v_credit.client_id;
  end if;
  if v_credit.order_id is not null then
    select id into v_related from public.invoices where order_id = v_credit.order_id and kind = 'FACTURE';
  end if;

  v_rate := coalesce(v_org_row.tva_rate, 20);
  v_ht := round(v_credit.amount / (1 + v_rate / 100), 2);
  v_lines := jsonb_build_array(jsonb_build_object(
    'reference', coalesce(v_credit.num, ''), 'designation', coalesce('Avoir — ' || v_credit.designation, 'Avoir'),
    'quantity', 1, 'unit_ttc', round(v_credit.amount, 2), 'unit_ht', v_ht, 'tva_rate', v_rate,
    'total_ht', v_ht, 'total_tva', round(v_credit.amount - v_ht, 2), 'total_ttc', round(v_credit.amount, 2)
  ));
  v_totals := jsonb_build_object(
    'ht', v_ht, 'tva', round(v_credit.amount - v_ht, 2), 'ttc', round(v_credit.amount, 2),
    'by_rate', jsonb_build_object(trim(trailing '.' from trim(trailing '0' from v_rate::text)),
      jsonb_build_object('ht', v_ht, 'tva', round(v_credit.amount - v_ht, 2))),
    'paid', 0, 'due', 0
  );
  v_buyer := jsonb_build_object(
    'name', coalesce(v_client.name, 'Client'), 'address', v_client.address, 'city', v_client.city,
    'phone', v_client.phone, 'email', v_client.email, 'siret', v_client.siret, 'tva_intra', v_client.tva_intra,
    'is_garage', coalesce(v_client.is_garage, false)
  );

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':invoices'));
  select content_hash into v_prev from public.invoices
  where organization_id = v_org order by created_at desc, number desc limit 1;
  v_number := public.next_invoice_number(v_org, 'AVOIR', 'AV');

  insert into public.invoices (
    organization_id, number, kind, issued_at, issued_by, order_id, client_id, credit_note_id, related_invoice_id,
    seller, buyer, lines, totals, note, prev_hash, content_hash
  ) values (
    v_org, v_number, 'AVOIR', v_issued, auth.uid(), v_credit.order_id, v_credit.client_id, v_credit.id, v_related,
    public.seller_snapshot(v_org), v_buyer, v_lines, v_totals, v_credit.motif,
    v_prev, public.invoice_hash(v_number, v_issued, v_lines, v_totals, v_prev)
  ) returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.emit_credit_note_document(uuid) from public, anon;
grant execute on function public.emit_credit_note_document(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Organisation profile (identity + legal + invoicing), ADMIN only
-- ---------------------------------------------------------------------
create or replace function public.update_organization_profile(p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_rate numeric;
begin
  if v_org is null or not public.is_counter_staff() or public.current_user_role() <> 'ADMIN'::public.user_role then
    raise exception 'Only an organization administrator may update settings.';
  end if;
  if nullif(trim(coalesce(p->>'name', '')), '') is null then
    raise exception 'Organization name is required.';
  end if;
  v_rate := coalesce(nullif(p->>'tva_rate', '')::numeric, 20);
  if v_rate < 0 or v_rate > 100 then
    raise exception 'Invalid VAT rate.';
  end if;
  update public.organizations
  set name = trim(p->>'name'),
      phone = nullif(trim(coalesce(p->>'phone', '')), ''),
      address = nullif(trim(coalesce(p->>'address', '')), ''),
      city = nullif(trim(coalesce(p->>'city', '')), ''),
      legal_name = nullif(trim(coalesce(p->>'legal_name', '')), ''),
      legal_form = nullif(trim(coalesce(p->>'legal_form', '')), ''),
      siret = nullif(regexp_replace(coalesce(p->>'siret', ''), '[^0-9]', '', 'g'), ''),
      tva_intra = nullif(upper(regexp_replace(coalesce(p->>'tva_intra', ''), '\s', '', 'g')), ''),
      rcs = nullif(trim(coalesce(p->>'rcs', '')), ''),
      capital = nullif(trim(coalesce(p->>'capital', '')), ''),
      iban = nullif(upper(regexp_replace(coalesce(p->>'iban', ''), '\s', '', 'g')), ''),
      bic = nullif(upper(trim(coalesce(p->>'bic', ''))), ''),
      tva_rate = v_rate,
      invoice_prefix = coalesce(nullif(upper(regexp_replace(coalesce(p->>'invoice_prefix', ''), '[^A-Za-z0-9]', '', 'g')), ''), 'FA'),
      invoice_footer = nullif(trim(coalesce(p->>'invoice_footer', '')), ''),
      payment_terms_text = nullif(trim(coalesce(p->>'payment_terms_text', '')), ''),
      updated_at = now()
  where id = v_org;
end;
$$;
revoke execute on function public.update_organization_profile(jsonb) from public, anon;
grant execute on function public.update_organization_profile(jsonb) to authenticated;

-- Clients: staff may now record an address / SIRET / TVA (used by invoices and deliveries).
notify pgrst, 'reload schema';
