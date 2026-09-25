-- Module après-vente (2026-09-20) — 1/2 : le modèle de données.
--
-- « Autodecision est le SAV du comptoir : tout ce qui arrive à une pièce après
-- qu'elle a été vendue. » Ce fichier pose ce dont tous les écrans après-vente
-- dépendent ; les automatismes (SMS, relances, tableau de bord) sont dans
-- 20260920020000_sav_automations.sql.
--
--  1. Les champs à capturer à la vente : consentement SMS + jeton public sur le
--     client, date promise / casier de retrait / garage poseur sur la commande,
--     n° de série / marque / famille / garantie commerciale sur la ligne.
--  2. La garantie : warranty_rules (durée commerciale par marque et famille),
--     part_family() qui classe une désignation, et le calcul des dates sur
--     chaque ligne (légale 24 mois + extension, commerciale).
--  3. sav_settings : la politique du magasin (reprise, consigne, délai de
--     réponse, avis Google) et l'interrupteur de chaque automatisme — tous
--     éteints par défaut : aucun SMS ne part vers un client sans que le magasin
--     l'ait décidé.
--  4. sav_cases : le dossier SAV, un seul conteneur pour la garantie et le
--     litige garage (et rattaché au retour ou à la consigne d'origine), avec
--     deux workflows parallèles — côté client, côté fournisseur — un journal
--     (sav_case_events) et des pièces jointes (sav_case_files, bucket `sav`).
--  5. La recherche « sans facture » : sav_search_sales(q) retrouve une vente
--     par immatriculation, téléphone, nom, référence ou n° de série.

-- ---------------------------------------------------------------------------
-- 1) Champs capturés à la vente
-- ---------------------------------------------------------------------------

alter table public.clients
  add column if not exists sms_marketing_consent boolean not null default false,
  add column if not exists sms_marketing_consent_at timestamptz,
  add column if not exists sms_opt_out_at timestamptz,
  add column if not exists public_token text not null default substr(md5(gen_random_uuid()::text), 1, 16),
  add column if not exists labor_rate numeric(10, 2);
create unique index if not exists clients_public_token_idx on public.clients (public_token);

alter table public.orders
  add column if not exists promised_date date,
  add column if not exists promise_revised_date date,
  add column if not exists casier text,
  add column if not exists ready_at timestamptz,
  add column if not exists picked_up_at timestamptz,
  -- No foreign key on purpose: a second orders → clients relationship would make every
  -- existing PostgREST embed `orders(…, clients(…))` ambiguous (PGRST201). set_order_sav_fields
  -- checks the garage belongs to the magasin; the name is kept alongside.
  add column if not exists garage_poseur_id uuid,
  add column if not exists garage_poseur_name text,
  add column if not exists immat_norm text generated always as (
    upper(regexp_replace(coalesce(immatriculation, ''), '[^A-Za-z0-9]', '', 'g'))
  ) stored;
create index if not exists orders_immat_norm_idx on public.orders (organization_id, immat_norm) where immat_norm <> '';

alter table public.order_lines
  add column if not exists serial_number text,
  add column if not exists marque text,
  add column if not exists famille text,
  add column if not exists warranty_months integer,
  add column if not exists warranty_extension_months integer not null default 0,
  add column if not exists reception_photo_path text;
create index if not exists order_lines_serial_idx on public.order_lines (organization_id, serial_number) where serial_number is not null;

alter table public.suppliers
  add column if not exists return_window_days integer,
  add column if not exists core_return_days integer,
  add column if not exists warranty_reminder_days integer not null default 15,
  add column if not exists sav_email text;

-- ---------------------------------------------------------------------------
-- 2) Famille de pièce et garantie commerciale
-- ---------------------------------------------------------------------------

-- Classe une désignation de comptoir dans une famille. Les mêmes codes sont
-- repris dans lib/sav.ts (libellés, relances d'entretien).
create or replace function public.part_family(p_name text)
returns text
language sql
immutable
as $$
  with n as (
    select translate(lower(coalesce(p_name, '')), 'éèêëàâäîïôöùûüç', 'eeeeaaaiioouuuc') as t
  )
  select case
    when t ~ 'plaquette' then 'PLAQUETTES'
    when t ~ 'disque' and t !~ 'embrayage' then 'DISQUES'
    when t ~ 'etrier|machoire|tambour|flexible de frein|maitre.cylindre|liquide de frein' then 'FREINAGE'
    when t ~ 'kit (de )?distribution|courroie (de )?distribution|galet (de )?distribution|chaine (de )?distribution' then 'DISTRIBUTION'
    when t ~ 'vidange|filtre a huile|huile moteur|huile [0-9]+w' then 'VIDANGE'
    when t ~ 'filtre' then 'FILTRATION'
    when t ~ 'batterie' then 'BATTERIE'
    when t ~ 'amortisseur|coupelle|butee de suspension|ressort de suspension' then 'AMORTISSEURS'
    when t ~ 'essuie|balai' then 'ESSUIE_GLACE'
    when t ~ 'embrayage|volant moteur|butee hydraulique' then 'EMBRAYAGE'
    when t ~ 'alternateur|demarreur' then 'DEMARRAGE_CHARGE'
    when t ~ 'bougie|bobine' then 'ALLUMAGE'
    when t ~ 'ampoule|phare|feu |feux|optique|clignotant' then 'ECLAIRAGE'
    when t ~ 'radiateur|thermostat|durite|pompe a eau|liquide de refroidissement|ventilateur' then 'REFROIDISSEMENT'
    when t ~ 'rotule|biellette|triangle|roulement|cardan|silent|bras de suspension|cremaillere|soufflet' then 'DIRECTION_SUSPENSION'
    when t ~ 'echappement|silencieux|catalyseur|fap|filtre a particules|sonde lambda' then 'ECHAPPEMENT'
    when t ~ 'injecteur|pompe (a )?injection|turbo|vanne egr|debitmetre|pompe a carburant' then 'INJECTION'
    when t ~ 'clim|condenseur|compresseur' then 'CLIMATISATION'
    when t ~ 'courroie|galet' then 'COURROIE_ACCESSOIRE'
    when t ~ 'pneu' then 'PNEUMATIQUE'
    else 'AUTRE'
  end
  from n;
$$;

-- Durée de garantie commerciale de l'équipementier, par marque et/ou famille.
-- La règle la plus précise l'emporte : marque + famille, puis marque, puis famille.
create table if not exists public.warranty_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  marque text,
  famille text,
  months integer not null check (months between 1 and 120),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (marque is not null or famille is not null)
);
create unique index if not exists warranty_rules_key_idx
  on public.warranty_rules (organization_id, upper(coalesce(marque, '')), coalesce(famille, ''));

alter table public.warranty_rules enable row level security;
drop policy if exists warranty_rules_select on public.warranty_rules;
create policy warranty_rules_select on public.warranty_rules for select
  using (organization_id = public.current_user_org_id() and public.is_counter_staff());
drop policy if exists warranty_rules_write on public.warranty_rules;
create policy warranty_rules_write on public.warranty_rules for all
  using (organization_id = public.current_user_org_id() and public.is_counter_staff()
         and public.current_user_role() = 'ADMIN'::public.user_role)
  with check (organization_id = public.current_user_org_id() and public.is_counter_staff()
              and public.current_user_role() = 'ADMIN'::public.user_role);
revoke all on public.warranty_rules from public, anon, authenticated;
grant select, insert, update, delete on public.warranty_rules to authenticated;

drop trigger if exists set_updated_at on public.warranty_rules;
create trigger set_updated_at before update on public.warranty_rules
  for each row execute function public.set_updated_at();

create or replace function public.warranty_months_for(p_org uuid, p_marque text, p_famille text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select w.months
  from public.warranty_rules w
  where w.organization_id = p_org
    and (w.marque is null or upper(w.marque) = upper(coalesce(p_marque, '')))
    and (w.famille is null or w.famille = coalesce(p_famille, ''))
  order by (w.marque is not null and w.famille is not null) desc, (w.marque is not null) desc
  limit 1;
$$;
revoke execute on function public.warranty_months_for(uuid, text, text) from public, anon, authenticated;

-- Chaque ligne vendue reçoit sa famille et sa garantie commerciale sans rien
-- demander au vendeur (la vente ne doit pas s'allonger).
create or replace function public.order_lines_sav_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.famille is null then
    new.famille := public.part_family(new.nom_produit);
  end if;
  new.marque := nullif(trim(coalesce(new.marque, '')), '');
  new.serial_number := nullif(trim(coalesce(new.serial_number, '')), '');
  if new.warranty_months is null then
    new.warranty_months := public.warranty_months_for(new.organization_id, new.marque, new.famille);
  elsif tg_op = 'UPDATE' then
    -- Marque ou famille corrigée après coup : la durée suit, sauf saisie manuelle.
    if (new.marque is distinct from old.marque or new.famille is distinct from old.famille)
       and new.warranty_months is not distinct from old.warranty_months then
      new.warranty_months := coalesce(public.warranty_months_for(new.organization_id, new.marque, new.famille), new.warranty_months);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists order_lines_sav_defaults on public.order_lines;
create trigger order_lines_sav_defaults
  before insert or update of marque, famille, nom_produit on public.order_lines
  for each row execute function public.order_lines_sav_defaults();

-- Reprise de l'historique, sans noyer le journal d'audit.
alter table public.order_lines disable trigger audit_order_lines;
update public.order_lines set famille = public.part_family(nom_produit) where famille is null;
alter table public.order_lines enable trigger audit_order_lines;

-- ---------------------------------------------------------------------------
-- 3) Politique après-vente du magasin
-- ---------------------------------------------------------------------------

create table if not exists public.sav_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  -- Automatismes vers le client : éteints tant que le magasin ne les allume pas.
  auto_sms_ready boolean not null default false,
  auto_sms_delay boolean not null default false,
  auto_sms_pickup_reminders boolean not null default false,
  auto_sms_consigne boolean not null default false,
  auto_sms_satisfaction boolean not null default false,
  auto_sms_avoir boolean not null default false,
  auto_sms_maintenance boolean not null default false,
  -- Relance automatique du fournisseur sur les dossiers garantie sans réponse.
  auto_supplier_reminders boolean not null default true,
  channel text not null default 'SMS' check (channel in ('SMS', 'WHATSAPP')),
  return_policy_days integer not null default 15 check (return_policy_days between 0 and 365),
  return_policy_text text,
  consigne_client_days integer not null default 30 check (consigne_client_days between 1 and 365),
  sla_hours integer not null default 48 check (sla_hours between 1 and 720),
  dormant_credit_months integer not null default 6 check (dormant_credit_months between 1 and 60),
  google_review_url text,
  templates jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sav_settings enable row level security;
drop policy if exists sav_settings_select on public.sav_settings;
create policy sav_settings_select on public.sav_settings for select
  using (organization_id = public.current_user_org_id() and public.is_counter_staff());
revoke all on public.sav_settings from public, anon, authenticated;
grant select on public.sav_settings to authenticated;

-- The settings row of a magasin, created with the defaults on first use.
create or replace function public.sav_settings_for(p_org uuid)
returns public.sav_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.sav_settings;
begin
  select * into v_row from public.sav_settings s where s.organization_id = p_org;
  if not found then
    insert into public.sav_settings (organization_id) values (p_org)
    on conflict (organization_id) do nothing;
    select * into v_row from public.sav_settings s where s.organization_id = p_org;
  end if;
  return v_row;
end;
$$;
revoke execute on function public.sav_settings_for(uuid) from public, anon, authenticated;

create or replace function public.get_sav_settings()
returns public.sav_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  return public.sav_settings_for(v_org);
end;
$$;
revoke execute on function public.get_sav_settings() from public, anon;
grant execute on function public.get_sav_settings() to authenticated;

create or replace function public.update_sav_settings(p jsonb)
returns public.sav_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_row public.sav_settings;
  v_url text := nullif(trim(coalesce(p->>'google_review_url', '')), '');
begin
  if v_org is null or not public.is_counter_staff() or public.current_user_role() <> 'ADMIN'::public.user_role then
    raise exception 'Only an organization administrator may update settings.';
  end if;
  if v_url is not null and v_url !~* '^https://' then
    raise exception 'The review link must start with https://';
  end if;
  v_row := public.sav_settings_for(v_org);

  update public.sav_settings s
  set auto_sms_ready = coalesce((p->>'auto_sms_ready')::boolean, s.auto_sms_ready),
      auto_sms_delay = coalesce((p->>'auto_sms_delay')::boolean, s.auto_sms_delay),
      auto_sms_pickup_reminders = coalesce((p->>'auto_sms_pickup_reminders')::boolean, s.auto_sms_pickup_reminders),
      auto_sms_consigne = coalesce((p->>'auto_sms_consigne')::boolean, s.auto_sms_consigne),
      auto_sms_satisfaction = coalesce((p->>'auto_sms_satisfaction')::boolean, s.auto_sms_satisfaction),
      auto_sms_avoir = coalesce((p->>'auto_sms_avoir')::boolean, s.auto_sms_avoir),
      auto_sms_maintenance = coalesce((p->>'auto_sms_maintenance')::boolean, s.auto_sms_maintenance),
      auto_supplier_reminders = coalesce((p->>'auto_supplier_reminders')::boolean, s.auto_supplier_reminders),
      channel = case when p->>'channel' in ('SMS', 'WHATSAPP') then p->>'channel' else s.channel end,
      return_policy_days = coalesce(nullif(p->>'return_policy_days', '')::integer, s.return_policy_days),
      return_policy_text = case when p ? 'return_policy_text' then nullif(trim(coalesce(p->>'return_policy_text', '')), '') else s.return_policy_text end,
      consigne_client_days = coalesce(nullif(p->>'consigne_client_days', '')::integer, s.consigne_client_days),
      sla_hours = coalesce(nullif(p->>'sla_hours', '')::integer, s.sla_hours),
      dormant_credit_months = coalesce(nullif(p->>'dormant_credit_months', '')::integer, s.dormant_credit_months),
      google_review_url = case when p ? 'google_review_url' then v_url else s.google_review_url end,
      templates = case when jsonb_typeof(p->'templates') = 'object' then p->'templates' else s.templates end,
      updated_at = now()
  where s.organization_id = v_org
  returning * into v_row;
  return v_row;
end;
$$;
revoke execute on function public.update_sav_settings(jsonb) from public, anon;
grant execute on function public.update_sav_settings(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Compléter la vente sans toucher create_order_with_lines
-- ---------------------------------------------------------------------------

-- Appelé juste après la création de la commande (et depuis la fiche commande) :
-- date promise, casier, garage poseur, consentement, n° de série / marque.
create or replace function public.set_order_sav_fields(p_order_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_poseur uuid;
  v_line jsonb;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  select * into v_order from public.orders o where o.id = p_order_id and o.organization_id = v_org for update;
  if not found then
    raise exception 'Order not found.';
  end if;

  if p ? 'garage_poseur_id' and nullif(p->>'garage_poseur_id', '') is not null then
    select c.id into v_poseur from public.clients c
    where c.id = (p->>'garage_poseur_id')::uuid and c.organization_id = v_org;
    if v_poseur is null then
      raise exception 'Garage not found.';
    end if;
  end if;

  update public.orders o
  set promised_date = case when p ? 'promised_date' then nullif(p->>'promised_date', '')::date else o.promised_date end,
      casier = case when p ? 'casier' then nullif(upper(trim(coalesce(p->>'casier', ''))), '') else o.casier end,
      garage_poseur_id = case when p ? 'garage_poseur_id' then v_poseur else o.garage_poseur_id end,
      garage_poseur_name = case
        when p ? 'garage_poseur_id' and v_poseur is not null then (select c.name from public.clients c where c.id = v_poseur)
        when p ? 'garage_poseur_name' then nullif(trim(coalesce(p->>'garage_poseur_name', '')), '')
        when p ? 'garage_poseur_id' then null
        else o.garage_poseur_name end
  where o.id = v_order.id;

  if p ? 'sms_marketing_consent' and v_order.client_id is not null then
    update public.clients c
    set sms_marketing_consent = (p->>'sms_marketing_consent')::boolean,
        sms_marketing_consent_at = case
          when (p->>'sms_marketing_consent')::boolean and not c.sms_marketing_consent then now()
          when not (p->>'sms_marketing_consent')::boolean then null
          else c.sms_marketing_consent_at end,
        sms_opt_out_at = case when (p->>'sms_marketing_consent')::boolean then null else c.sms_opt_out_at end
    where c.id = v_order.client_id and c.organization_id = v_org;
  end if;

  if jsonb_typeof(p->'lines') = 'array' then
    for v_line in select value from jsonb_array_elements(p->'lines') loop
      update public.order_lines l
      set serial_number = case when v_line ? 'serial_number' then nullif(trim(coalesce(v_line->>'serial_number', '')), '') else l.serial_number end,
          marque = case when v_line ? 'marque' then nullif(trim(coalesce(v_line->>'marque', '')), '') else l.marque end,
          famille = case when v_line ? 'famille' and nullif(v_line->>'famille', '') is not null then v_line->>'famille' else l.famille end,
          warranty_months = case when v_line ? 'warranty_months' then nullif(v_line->>'warranty_months', '')::integer else l.warranty_months end,
          reception_photo_path = case
            when v_line ? 'reception_photo_path' and coalesce(v_line->>'reception_photo_path', '') like v_org::text || '/%'
              then v_line->>'reception_photo_path'
            when v_line ? 'reception_photo_path' and nullif(v_line->>'reception_photo_path', '') is null then null
            else l.reception_photo_path end
      where l.id = (v_line->>'id')::uuid and l.order_id = v_order.id and l.organization_id = v_org;
    end loop;
  end if;
end;
$$;
revoke execute on function public.set_order_sav_fields(uuid, jsonb) from public, anon;
grant execute on function public.set_order_sav_fields(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Le dossier SAV
-- ---------------------------------------------------------------------------

create table if not exists public.sav_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  ref text not null,
  type text not null check (type in ('GARANTIE', 'LITIGE', 'RETOUR', 'CONSIGNE')),
  origin text not null default 'COMPTOIR' check (origin in ('COMPTOIR', 'GARAGE')),
  client_id uuid references public.clients (id) on delete set null,
  order_id uuid references public.orders (id) on delete set null,
  order_line_id uuid references public.order_lines (id) on delete set null,
  supplier_id uuid references public.suppliers (id) on delete set null,
  return_id uuid references public.sales_returns (id) on delete set null,
  consignment_id uuid references public.consignment_entries (id) on delete set null,
  immatriculation text,
  designation text not null,
  reference text,
  marque text,
  famille text,
  serial_number text,
  purchase_date date,
  part_value numeric(14, 2),
  description text,
  -- Côté client : c'est le magasin qui porte la garantie.
  client_status text not null default 'RECU'
    check (client_status in ('RECU', 'EN_EXPERTISE', 'ACCEPTE', 'REFUSE', 'REMPLACE', 'REMBOURSE', 'CLOS')),
  -- Côté fournisseur : une autre horloge, qui ne bloque jamais le client.
  supplier_status text
    check (supplier_status in ('A_DECLARER', 'DECLARE', 'EN_ATTENTE', 'ACCORDE', 'REFUSE', 'AVOIR_RECU', 'SANS_SUITE')),
  supplier_case_number text,
  supplier_declared_at timestamptz,
  supplier_answered_at timestamptz,
  supplier_last_reminder_at timestamptz,
  supplier_reminder_count integer not null default 0,
  supplier_credit_amount numeric(14, 2),
  -- Pièces du dossier garantie exigées par les équipementiers.
  km_montage integer,
  km_panne integer,
  garage_poseur text,
  pose_invoice_ref text,
  -- Où est physiquement la pièce défectueuse.
  part_location text not null default 'CLIENT'
    check (part_location in ('CLIENT', 'MAGASIN', 'EN_TRANSIT', 'FOURNISSEUR', 'REVENUE', 'DETRUITE')),
  part_location_note text,
  -- Dépannage immédiat : le client repart avec une pièce, le dossier reste ouvert.
  replacement_given boolean not null default false,
  replacement_at timestamptz,
  replacement_note text,
  warranty_extended boolean not null default false,
  -- Litige garage : main d'œuvre perdue et geste commercial.
  labor_rate numeric(10, 2),
  labor_hours numeric(6, 2),
  labor_amount numeric(14, 2) generated always as (round(coalesce(labor_rate, 0) * coalesce(labor_hours, 0), 2)) stored,
  gesture_type text check (gesture_type in ('AVOIR', 'REMISE', 'PIECE_OFFERTE', 'MAIN_OEUVRE', 'AUCUN')),
  gesture_amount numeric(14, 2),
  gesture_budget text check (gesture_budget in ('MAGASIN', 'FOURNISSEUR', 'PARTAGE')),
  gesture_by uuid references auth.users (id) on delete set null,
  gesture_at timestamptz,
  gesture_note text,
  credit_note_id uuid references public.credit_notes (id) on delete set null,
  sla_due_at timestamptz,
  first_response_at timestamptz,
  opened_by uuid references auth.users (id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sav_cases_ref_idx on public.sav_cases (organization_id, ref);
create index if not exists sav_cases_org_open_idx on public.sav_cases (organization_id, opened_at desc);
create index if not exists sav_cases_client_idx on public.sav_cases (client_id) where client_id is not null;
create index if not exists sav_cases_line_idx on public.sav_cases (order_line_id) where order_line_id is not null;
create index if not exists sav_cases_order_idx on public.sav_cases (order_id) where order_id is not null;

alter table public.sales_returns
  add column if not exists motif_code text
    check (motif_code in ('ERREUR_VENDEUR', 'MAUVAISE_IDENTIFICATION', 'ERREUR_CLIENT', 'NON_CONFORME', 'DEFECTUEUSE', 'ANNULATION')),
  add column if not exists etat_piece text check (etat_piece in ('NEUVE_EMBALLEE', 'EMBALLAGE_ABIME', 'MONTEE', 'ENDOMMAGEE')),
  add column if not exists frais numeric(14, 2) not null default 0,
  add column if not exists supplier_deadline date,
  add column if not exists sav_case_id uuid references public.sav_cases (id) on delete set null;

alter table public.consignment_entries
  add column if not exists core_state text check (core_state in ('COMPLET', 'INCOMPLET', 'CASSE', 'VIDE')),
  add column if not exists core_photo_path text,
  add column if not exists returned_at timestamptz,
  add column if not exists supplier_status text check (supplier_status in ('A_RENVOYER', 'RENVOYE', 'AVOIR_RECU', 'REFUSE')),
  add column if not exists supplier_deadline date,
  add column if not exists supplier_sent_at timestamptz,
  add column if not exists supplier_credit_amount numeric(14, 2),
  add column if not exists supplier_credit_at timestamptz,
  add column if not exists return_id uuid references public.sales_returns (id) on delete set null;

create table if not exists public.sav_case_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null references public.sav_cases (id) on delete cascade,
  kind text not null,
  body text,
  meta jsonb,
  visible_to_client boolean not null default false,
  actor_id uuid references auth.users (id) on delete set null,
  actor_name text,
  -- Relance fournisseur par e-mail : boîte d'envoi vidée par /api/notifications/dispatch.
  email_to text,
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz not null default now()
);
create index if not exists sav_case_events_case_idx on public.sav_case_events (case_id, created_at);
create index if not exists sav_case_events_outbox_idx on public.sav_case_events (created_at)
  where email_to is not null and email_sent_at is null;

create table if not exists public.sav_case_files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  case_id uuid not null references public.sav_cases (id) on delete cascade,
  path text not null,
  kind text not null default 'DEFAUT' check (kind in ('DEFAUT', 'PIECE', 'FACTURE_POSE', 'COEUR', 'AUTRE')),
  caption text,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists sav_case_files_case_idx on public.sav_case_files (case_id, created_at);

-- Lecture réservée au comptoir : le garagiste lit ses dossiers par
-- garage_sav_cases(), qui ne renvoie ni le côté fournisseur ni l'enveloppe.
alter table public.sav_cases enable row level security;
alter table public.sav_case_events enable row level security;
alter table public.sav_case_files enable row level security;

drop policy if exists sav_cases_select on public.sav_cases;
create policy sav_cases_select on public.sav_cases for select
  using (organization_id = public.current_user_org_id() and public.has_operational_access(organization_id) and public.is_counter_staff());
drop policy if exists sav_case_events_select on public.sav_case_events;
create policy sav_case_events_select on public.sav_case_events for select
  using (organization_id = public.current_user_org_id() and public.has_operational_access(organization_id) and public.is_counter_staff());
drop policy if exists sav_case_files_select on public.sav_case_files;
create policy sav_case_files_select on public.sav_case_files for select
  using (organization_id = public.current_user_org_id() and public.has_operational_access(organization_id) and public.is_counter_staff());

revoke all on public.sav_cases, public.sav_case_events, public.sav_case_files from public, anon, authenticated;
grant select on public.sav_cases, public.sav_case_events, public.sav_case_files to authenticated;

drop trigger if exists set_updated_at on public.sav_cases;
create trigger set_updated_at before update on public.sav_cases
  for each row execute function public.set_updated_at();

drop trigger if exists audit_sav_cases on public.sav_cases;
create trigger audit_sav_cases after insert or update or delete on public.sav_cases
  for each row execute function public.audit_row();

-- Photos et justificatifs : <org>/<dossier ou ligne>/<fichier>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sav', 'sav', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists sav_insert on storage.objects;
create policy sav_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sav'
    and (storage.foldername(name))[1] = public.current_user_org_id()::text
    and (public.is_counter_staff() or public.current_user_client_id() is not null)
  );

drop policy if exists sav_select on storage.objects;
create policy sav_select on storage.objects for select to authenticated
  using (
    bucket_id = 'sav'
    and (storage.foldername(name))[1] = public.current_user_org_id()::text
    and (public.is_counter_staff() or owner = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 6) Helpers internes
-- ---------------------------------------------------------------------------

create or replace function public.sav_actor_name()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.display_name from public.profiles p where p.user_id = auth.uid()),
    'Système'
  );
$$;
revoke execute on function public.sav_actor_name() from public, anon, authenticated;

create or replace function public.sav_log(
  p_case public.sav_cases, p_kind text, p_body text,
  p_visible boolean default false, p_meta jsonb default null, p_email_to text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.sav_case_events (organization_id, case_id, kind, body, meta, visible_to_client, actor_id, actor_name, email_to)
  values (p_case.organization_id, p_case.id, p_kind, p_body, p_meta, p_visible, auth.uid(), public.sav_actor_name(), p_email_to);
$$;
revoke execute on function public.sav_log(public.sav_cases, text, text, boolean, jsonb, text) from public, anon, authenticated;

create or replace function public.next_sav_ref(p_org uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year integer := extract(year from current_date);
  v_seq integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_org::text || ':sav:' || v_year::text));
  select coalesce(max(public.ref_seq(c.ref)), 0) + 1 into v_seq
  from public.sav_cases c
  where c.organization_id = p_org and c.ref like format('SAV-%s-%%', v_year);
  return format('SAV-%s-%s', v_year, lpad(v_seq::text, 5, '0'));
end;
$$;
revoke execute on function public.next_sav_ref(uuid) from public, anon, authenticated;

-- Début de garantie d'une ligne : la délivrance (remise au client ou
-- livraison), à défaut la date de commande.
create or replace function public.line_warranty_start(p_line public.order_lines, p_order public.orders)
returns date
language sql
stable
as $$
  select coalesce(
    (p_line.remise_at at time zone 'Europe/Paris')::date,
    (p_order.delivered_at at time zone 'Europe/Paris')::date,
    p_order.date_commande
  );
$$;
revoke execute on function public.line_warranty_start(public.order_lines, public.orders) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7) Ouvrir un dossier — comptoir
-- ---------------------------------------------------------------------------

create or replace function public.open_sav_case(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_type text := upper(coalesce(p->>'type', ''));
  v_line public.order_lines;
  v_order public.orders;
  v_return public.sales_returns;
  v_consigne public.consignment_entries;
  v_client uuid := nullif(p->>'client_id', '')::uuid;
  v_supplier uuid := nullif(p->>'supplier_id', '')::uuid;
  v_settings public.sav_settings;
  v_case public.sav_cases;
  v_designation text := nullif(trim(coalesce(p->>'designation', '')), '');
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if v_type not in ('GARANTIE', 'LITIGE', 'RETOUR', 'CONSIGNE') then
    raise exception 'Invalid case type.';
  end if;
  v_settings := public.sav_settings_for(v_org);

  if nullif(p->>'return_id', '') is not null then
    select * into v_return from public.sales_returns r
    where r.id = (p->>'return_id')::uuid and r.organization_id = v_org;
    if not found then raise exception 'Return not found.'; end if;
  end if;
  if nullif(p->>'consignment_id', '') is not null then
    select * into v_consigne from public.consignment_entries e
    where e.id = (p->>'consignment_id')::uuid and e.organization_id = v_org;
    if not found then raise exception 'Consignment entry not found.'; end if;
  end if;

  if coalesce(nullif(p->>'order_line_id', '')::uuid, v_return.order_line_id, v_consigne.order_line_id) is not null then
    select * into v_line from public.order_lines l
    where l.id = coalesce(nullif(p->>'order_line_id', '')::uuid, v_return.order_line_id, v_consigne.order_line_id)
      and l.organization_id = v_org;
    if not found then raise exception 'Order line not found.'; end if;
  end if;
  if coalesce(v_line.order_id, nullif(p->>'order_id', '')::uuid, v_return.order_id, v_consigne.order_id) is not null then
    select * into v_order from public.orders o
    where o.id = coalesce(v_line.order_id, nullif(p->>'order_id', '')::uuid, v_return.order_id, v_consigne.order_id)
      and o.organization_id = v_org;
    if not found then raise exception 'Order not found.'; end if;
  end if;

  v_client := coalesce(v_client, v_order.client_id, v_return.client_id, v_consigne.client_id);
  if v_client is not null and not exists (select 1 from public.clients c where c.id = v_client and c.organization_id = v_org) then
    raise exception 'Client not found.';
  end if;
  v_supplier := coalesce(v_supplier, v_line.supplier_id, v_return.supplier_id, v_consigne.supplier_id);
  if v_supplier is not null and not exists (select 1 from public.suppliers s where s.id = v_supplier and s.organization_id = v_org) then
    raise exception 'Supplier not found.';
  end if;
  v_designation := coalesce(v_designation, v_line.nom_produit, v_return.designation, v_consigne.description);
  if v_designation is null then
    raise exception 'A part designation is required.';
  end if;

  insert into public.sav_cases (
    organization_id, ref, type, origin, client_id, order_id, order_line_id, supplier_id, return_id, consignment_id,
    immatriculation, designation, reference, marque, famille, serial_number, purchase_date, part_value, description,
    client_status, supplier_status, km_montage, km_panne, garage_poseur, pose_invoice_ref,
    part_location, labor_rate, labor_hours, sla_due_at, opened_by
  ) values (
    v_org, public.next_sav_ref(v_org), v_type, 'COMPTOIR', v_client, v_order.id, v_line.id, v_supplier, v_return.id, v_consigne.id,
    coalesce(nullif(trim(coalesce(p->>'immatriculation', '')), ''), v_order.immatriculation),
    v_designation,
    coalesce(nullif(trim(coalesce(p->>'reference', '')), ''), v_line.reference, v_consigne.reference),
    coalesce(nullif(trim(coalesce(p->>'marque', '')), ''), v_line.marque),
    coalesce(v_line.famille, public.part_family(v_designation)),
    coalesce(nullif(trim(coalesce(p->>'serial_number', '')), ''), v_line.serial_number),
    case when v_line.id is not null then public.line_warranty_start(v_line, v_order) else v_order.date_commande end,
    coalesce(nullif(p->>'part_value', '')::numeric, v_line.quantity * v_line.prix_vente_unitaire, v_return.montant),
    nullif(trim(coalesce(p->>'description', '')), ''),
    'RECU',
    case when v_type = 'GARANTIE' then 'A_DECLARER' else nullif(p->>'supplier_status', '') end,
    nullif(p->>'km_montage', '')::integer,
    nullif(p->>'km_panne', '')::integer,
    coalesce(nullif(trim(coalesce(p->>'garage_poseur', '')), ''), v_order.garage_poseur_name),
    nullif(trim(coalesce(p->>'pose_invoice_ref', '')), ''),
    case when p->>'part_location' in ('CLIENT', 'MAGASIN', 'EN_TRANSIT', 'FOURNISSEUR', 'REVENUE', 'DETRUITE') then p->>'part_location'
         when v_return.id is not null then 'MAGASIN' else 'CLIENT' end,
    coalesce(nullif(p->>'labor_rate', '')::numeric, (select c.labor_rate from public.clients c where c.id = v_client)),
    nullif(p->>'labor_hours', '')::numeric,
    case when v_type = 'LITIGE' then now() + make_interval(hours => v_settings.sla_hours) end,
    auth.uid()
  ) returning * into v_case;

  if v_return.id is not null then
    update public.sales_returns r set sav_case_id = v_case.id where r.id = v_return.id;
  end if;
  -- Un dossier ouvert au comptoir est pris en charge dès l'ouverture.
  update public.sav_cases c set first_response_at = now() where c.id = v_case.id;

  perform public.sav_log(v_case, 'CREATED',
    case v_type when 'GARANTIE' then 'Dossier garantie ouvert au comptoir.'
                when 'LITIGE' then 'Litige ouvert au comptoir.'
                else 'Dossier ouvert au comptoir.' end
      || case when v_return.id is not null then format(' Issu du retour %s.', coalesce(v_return.ref, '')) else '' end,
    true);
  return v_case.id;
end;
$$;
revoke execute on function public.open_sav_case(jsonb) from public, anon;
grant execute on function public.open_sav_case(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Ouvrir un litige ou une garantie — espace garagiste
-- ---------------------------------------------------------------------------

create or replace function public.open_garage_dispute(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_type text := case when upper(coalesce(p->>'type', '')) = 'GARANTIE' then 'GARANTIE' else 'LITIGE' end;
  v_order public.orders;
  v_line public.order_lines;
  v_settings public.sav_settings;
  v_case public.sav_cases;
  v_rate numeric := nullif(p->>'labor_rate', '')::numeric;
  v_hours numeric := nullif(p->>'labor_hours', '')::numeric;
  v_designation text := nullif(trim(coalesce(p->>'designation', '')), '');
begin
  if v_org is null or v_client is null then
    raise exception 'Garage access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if nullif(trim(coalesce(p->>'description', '')), '') is null then
    raise exception 'A description is required.';
  end if;
  if v_rate is not null and (v_rate < 0 or v_rate > 500) then raise exception 'Invalid labor rate.'; end if;
  if v_hours is not null and (v_hours < 0 or v_hours > 200) then raise exception 'Invalid labor time.'; end if;

  if nullif(p->>'order_line_id', '') is not null then
    select l.* into v_line from public.order_lines l
    join public.orders o on o.id = l.order_id
    where l.id = (p->>'order_line_id')::uuid and l.organization_id = v_org and o.client_id = v_client;
    if not found then raise exception 'Order line not found.'; end if;
  end if;
  if coalesce(v_line.order_id, nullif(p->>'order_id', '')::uuid) is not null then
    select * into v_order from public.orders o
    where o.id = coalesce(v_line.order_id, nullif(p->>'order_id', '')::uuid)
      and o.organization_id = v_org and o.client_id = v_client;
    if not found then raise exception 'Order not found.'; end if;
  end if;
  v_designation := coalesce(v_designation, v_line.nom_produit);
  if v_designation is null then
    raise exception 'A part designation is required.';
  end if;
  v_settings := public.sav_settings_for(v_org);

  -- Le taux horaire saisi une fois reste sur la fiche du garage.
  if v_rate is not null then
    update public.clients c set labor_rate = v_rate where c.id = v_client and c.labor_rate is distinct from v_rate;
  else
    select c.labor_rate into v_rate from public.clients c where c.id = v_client;
  end if;

  insert into public.sav_cases (
    organization_id, ref, type, origin, client_id, order_id, order_line_id, supplier_id,
    immatriculation, designation, reference, marque, famille, serial_number, purchase_date, part_value, description,
    client_status, supplier_status, km_montage, km_panne, garage_poseur, part_location,
    labor_rate, labor_hours, sla_due_at, opened_by
  ) values (
    v_org, public.next_sav_ref(v_org), v_type, 'GARAGE', v_client, v_order.id, v_line.id, v_line.supplier_id,
    nullif(upper(trim(coalesce(p->>'immatriculation', ''))), ''),
    v_designation, v_line.reference, v_line.marque,
    coalesce(v_line.famille, public.part_family(v_designation)), v_line.serial_number,
    case when v_line.id is not null then public.line_warranty_start(v_line, v_order) else v_order.date_commande end,
    v_line.quantity * v_line.prix_vente_unitaire,
    trim(p->>'description'),
    'RECU', case when v_type = 'GARANTIE' then 'A_DECLARER' end,
    nullif(p->>'km_montage', '')::integer, nullif(p->>'km_panne', '')::integer,
    public.client_name(v_client), 'CLIENT',
    v_rate, v_hours, now() + make_interval(hours => v_settings.sla_hours), auth.uid()
  ) returning * into v_case;

  perform public.sav_log(v_case, 'CREATED',
    format('%s ouvert depuis l''espace garage.', case v_type when 'GARANTIE' then 'Dossier garantie' else 'Litige' end), true);
  perform public.notify(v_org, 'STAFF', 'SAV_OPENED',
    format('%s ouvert par %s', case v_type when 'GARANTIE' then 'Garantie' else 'Litige' end, public.client_name(v_client)),
    format('%s — %s. Réponse attendue sous %s h.', v_case.ref, v_designation, v_settings.sla_hours),
    '/dashboard/sav/' || v_case.id::text, 'sav_cases', v_case.id);
  return v_case.id;
end;
$$;
revoke execute on function public.open_garage_dispute(jsonb) from public, anon;
grant execute on function public.open_garage_dispute(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Faire vivre le dossier
-- ---------------------------------------------------------------------------

create or replace function public.update_sav_case(p_case_id uuid, p jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_old public.sav_cases;
  v_new public.sav_cases;
  v_client_label text;
  v_client_closed boolean;
  v_supplier_closed boolean;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  select * into v_old from public.sav_cases c where c.id = p_case_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'Case not found.';
  end if;
  if p ? 'supplier_id' and nullif(p->>'supplier_id', '') is not null and not exists (
    select 1 from public.suppliers s where s.id = (p->>'supplier_id')::uuid and s.organization_id = v_org
  ) then
    raise exception 'Supplier not found.';
  end if;

  update public.sav_cases c
  set client_status = coalesce(nullif(p->>'client_status', ''), c.client_status),
      supplier_status = case when p ? 'supplier_status' then nullif(p->>'supplier_status', '') else c.supplier_status end,
      supplier_id = case when p ? 'supplier_id' then nullif(p->>'supplier_id', '')::uuid else c.supplier_id end,
      supplier_case_number = case when p ? 'supplier_case_number' then nullif(trim(coalesce(p->>'supplier_case_number', '')), '') else c.supplier_case_number end,
      supplier_credit_amount = case when p ? 'supplier_credit_amount' then nullif(p->>'supplier_credit_amount', '')::numeric else c.supplier_credit_amount end,
      description = case when p ? 'description' then nullif(trim(coalesce(p->>'description', '')), '') else c.description end,
      immatriculation = case when p ? 'immatriculation' then nullif(upper(trim(coalesce(p->>'immatriculation', ''))), '') else c.immatriculation end,
      marque = case when p ? 'marque' then nullif(trim(coalesce(p->>'marque', '')), '') else c.marque end,
      serial_number = case when p ? 'serial_number' then nullif(trim(coalesce(p->>'serial_number', '')), '') else c.serial_number end,
      km_montage = case when p ? 'km_montage' then nullif(p->>'km_montage', '')::integer else c.km_montage end,
      km_panne = case when p ? 'km_panne' then nullif(p->>'km_panne', '')::integer else c.km_panne end,
      garage_poseur = case when p ? 'garage_poseur' then nullif(trim(coalesce(p->>'garage_poseur', '')), '') else c.garage_poseur end,
      pose_invoice_ref = case when p ? 'pose_invoice_ref' then nullif(trim(coalesce(p->>'pose_invoice_ref', '')), '') else c.pose_invoice_ref end,
      part_location = coalesce(nullif(p->>'part_location', ''), c.part_location),
      part_location_note = case when p ? 'part_location_note' then nullif(trim(coalesce(p->>'part_location_note', '')), '') else c.part_location_note end,
      replacement_given = coalesce((p->>'replacement_given')::boolean, c.replacement_given),
      replacement_note = case when p ? 'replacement_note' then nullif(trim(coalesce(p->>'replacement_note', '')), '') else c.replacement_note end,
      labor_rate = case when p ? 'labor_rate' then nullif(p->>'labor_rate', '')::numeric else c.labor_rate end,
      labor_hours = case when p ? 'labor_hours' then nullif(p->>'labor_hours', '')::numeric else c.labor_hours end,
      resolution_note = case when p ? 'resolution_note' then nullif(trim(coalesce(p->>'resolution_note', '')), '') else c.resolution_note end
  where c.id = v_old.id
  returning * into v_new;

  -- Horodatages dérivés.
  update public.sav_cases c
  set first_response_at = coalesce(c.first_response_at, now()),
      replacement_at = case when v_new.replacement_given and not v_old.replacement_given then now()
                            when not v_new.replacement_given then null else c.replacement_at end,
      supplier_declared_at = case
        when v_new.supplier_status in ('DECLARE', 'EN_ATTENTE') and c.supplier_declared_at is null then now()
        else c.supplier_declared_at end,
      supplier_answered_at = case
        when v_new.supplier_status in ('ACCORDE', 'REFUSE', 'AVOIR_RECU') and c.supplier_answered_at is null then now()
        when v_new.supplier_status in ('A_DECLARER', 'DECLARE', 'EN_ATTENTE') then null
        else c.supplier_answered_at end
  where c.id = v_old.id
  returning * into v_new;

  if v_new.client_status is distinct from v_old.client_status then
    v_client_label := case v_new.client_status
      when 'RECU' then 'reçu' when 'EN_EXPERTISE' then 'en expertise' when 'ACCEPTE' then 'accepté'
      when 'REFUSE' then 'refusé' when 'REMPLACE' then 'pièce remplacée' when 'REMBOURSE' then 'remboursé'
      else 'clos' end;
    perform public.sav_log(v_new, 'CLIENT_STATUS', format('Côté client : %s.', v_client_label), true,
      jsonb_build_object('from', v_old.client_status, 'to', v_new.client_status));
    if v_new.client_id is not null and public.client_is_garage(v_new.client_id) then
      perform public.notify(v_org, 'CLIENT', 'SAV_UPDATE',
        format('Dossier %s : %s', v_new.ref, v_client_label), v_new.designation,
        '/garagiste/dashboard/litiges', 'sav_cases', v_new.id, v_new.client_id);
    end if;
    -- Mise en conformité par remplacement : la garantie légale repart de + 6 mois (art. L. 217-13).
    if v_new.client_status = 'REMPLACE' and v_new.type = 'GARANTIE' and not v_new.warranty_extended and v_new.order_line_id is not null then
      update public.order_lines l set warranty_extension_months = l.warranty_extension_months + 6 where l.id = v_new.order_line_id;
      update public.sav_cases c set warranty_extended = true where c.id = v_new.id;
    end if;
  end if;
  if v_new.supplier_status is distinct from v_old.supplier_status then
    perform public.sav_log(v_new, 'SUPPLIER_STATUS', format('Côté fournisseur : %s.', case v_new.supplier_status
      when 'A_DECLARER' then 'à déclarer' when 'DECLARE' then 'déclaré' when 'EN_ATTENTE' then 'en attente de décision'
      when 'ACCORDE' then 'accordé' when 'REFUSE' then 'refusé' when 'AVOIR_RECU' then 'avoir reçu'
      when 'SANS_SUITE' then 'sans suite' else 'non concerné' end)
      || case when v_new.supplier_case_number is not null then format(' Dossier n° %s.', v_new.supplier_case_number) else '' end,
      false, jsonb_build_object('from', v_old.supplier_status, 'to', v_new.supplier_status));
  end if;
  if v_new.part_location is distinct from v_old.part_location then
    perform public.sav_log(v_new, 'LOCATION', format('Pièce défectueuse : %s.', case v_new.part_location
      when 'CLIENT' then 'chez le client' when 'MAGASIN' then 'au magasin' when 'EN_TRANSIT' then 'en transit'
      when 'FOURNISSEUR' then 'chez le fournisseur' when 'REVENUE' then 'revenue du fournisseur' else 'détruite' end)
      || coalesce(' ' || v_new.part_location_note, ''), false);
  end if;
  if v_new.replacement_given and not v_old.replacement_given then
    perform public.sav_log(v_new, 'REPLACEMENT',
      'Dépannage immédiat : pièce de remplacement remise au client, dossier fournisseur maintenu ouvert.'
      || coalesce(' ' || v_new.replacement_note, ''), true);
  end if;

  v_client_closed := v_new.client_status in ('REFUSE', 'REMPLACE', 'REMBOURSE', 'CLOS');
  v_supplier_closed := v_new.supplier_status is null or v_new.supplier_status in ('REFUSE', 'AVOIR_RECU', 'SANS_SUITE');
  update public.sav_cases c
  set closed_at = case when v_client_closed and v_supplier_closed then coalesce(c.closed_at, now()) else null end
  where c.id = v_new.id;
end;
$$;
revoke execute on function public.update_sav_case(uuid, jsonb) from public, anon;
grant execute on function public.update_sav_case(uuid, jsonb) to authenticated;

-- Geste commercial tracé : montant, forme, qui l'a accordé, sur quelle enveloppe.
create or replace function public.record_sav_gesture(
  p_case_id uuid, p_type text, p_amount numeric, p_budget text, p_note text, p_create_credit boolean default false
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_case public.sav_cases;
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_num text;
  v_credit uuid;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_type not in ('AVOIR', 'REMISE', 'PIECE_OFFERTE', 'MAIN_OEUVRE', 'AUCUN') then
    raise exception 'Invalid gesture type.';
  end if;
  if p_budget is not null and p_budget not in ('MAGASIN', 'FOURNISSEUR', 'PARTAGE') then
    raise exception 'Invalid gesture budget.';
  end if;
  if p_type <> 'AUCUN' and (p_amount is null or p_amount <= 0 or p_amount > 100000) then
    raise exception 'A positive amount is required.';
  end if;
  select * into v_case from public.sav_cases c where c.id = p_case_id and c.organization_id = v_org for update;
  if not found then
    raise exception 'Case not found.';
  end if;
  if v_case.credit_note_id is not null then
    raise exception 'A credit note was already issued for this case.';
  end if;

  if p_type = 'AVOIR' and coalesce(p_create_credit, false) then
    if v_case.client_id is null then
      raise exception 'A client is required to issue a credit note.';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_org::text || ':credits:' || v_year::text));
    select coalesce(max(public.ref_seq(num)), 0) + 1 into v_seq
    from public.credit_notes where organization_id = v_org and num like format('AV-%s-%%', v_year);
    v_num := format('AV-%s-%s', v_year, lpad(v_seq::text, 5, '0'));
    insert into public.credit_notes (organization_id, client_id, order_id, num, amount, used_amount, statut, echeance, motif, designation)
    values (v_org, v_case.client_id, v_case.order_id, v_num, round(p_amount, 2), 0, 'EN_COURS',
            (current_date + interval '1 year')::date, format('Geste commercial — dossier %s', v_case.ref), v_case.designation)
    returning id into v_credit;
  end if;

  update public.sav_cases c
  set gesture_type = p_type,
      gesture_amount = case when p_type = 'AUCUN' then null else round(p_amount, 2) end,
      gesture_budget = case when p_type = 'AUCUN' then null else coalesce(p_budget, 'MAGASIN') end,
      gesture_by = auth.uid(),
      gesture_at = now(),
      gesture_note = nullif(trim(coalesce(p_note, '')), ''),
      credit_note_id = coalesce(v_credit, c.credit_note_id),
      first_response_at = coalesce(c.first_response_at, now())
  where c.id = v_case.id
  returning * into v_case;

  perform public.sav_log(v_case, 'GESTURE',
    case when p_type = 'AUCUN' then 'Aucun geste commercial accordé.'
         else format('Geste commercial : %s de %s € (enveloppe %s).', case p_type
           when 'AVOIR' then 'avoir' when 'REMISE' then 'remise' when 'PIECE_OFFERTE' then 'pièce offerte' else 'prise en charge de la main d''œuvre' end,
           to_char(round(p_amount, 2), 'FM999G999G990D00'), lower(coalesce(p_budget, 'MAGASIN'))) end
      || coalesce(format(' Avoir %s émis.', v_num), '')
      || coalesce(' ' || nullif(trim(coalesce(p_note, '')), ''), ''),
    p_type <> 'AUCUN');
  if v_case.client_id is not null and public.client_is_garage(v_case.client_id) and p_type <> 'AUCUN' then
    perform public.notify(v_org, 'CLIENT', 'SAV_UPDATE',
      format('Dossier %s : geste commercial de %s €', v_case.ref, to_char(round(p_amount, 2), 'FM999G999G990D00')),
      v_case.designation, '/garagiste/dashboard/litiges', 'sav_cases', v_case.id, v_case.client_id);
  end if;
  return v_num;
end;
$$;
revoke execute on function public.record_sav_gesture(uuid, text, numeric, text, text, boolean) from public, anon;
grant execute on function public.record_sav_gesture(uuid, text, numeric, text, text, boolean) to authenticated;

-- Note au dossier (comptoir, ou le garage sur son propre dossier).
create or replace function public.add_sav_case_note(p_case_id uuid, p_body text, p_visible boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_staff boolean := public.is_counter_staff();
  v_case public.sav_cases;
begin
  if v_org is null or (not v_staff and v_client is null) then
    raise exception 'Access denied.';
  end if;
  perform public.assert_operational_access(v_org);
  if nullif(trim(coalesce(p_body, '')), '') is null then
    raise exception 'A note is required.';
  end if;
  select * into v_case from public.sav_cases c
  where c.id = p_case_id and c.organization_id = v_org and (v_staff or c.client_id = v_client);
  if not found then
    raise exception 'Case not found.';
  end if;
  perform public.sav_log(v_case, 'NOTE', left(trim(p_body), 2000), case when v_staff then coalesce(p_visible, false) else true end);
  if v_staff then
    update public.sav_cases c set first_response_at = coalesce(c.first_response_at, now()) where c.id = v_case.id;
    if coalesce(p_visible, false) and v_case.client_id is not null and public.client_is_garage(v_case.client_id) then
      perform public.notify(v_org, 'CLIENT', 'SAV_UPDATE', format('Dossier %s : nouveau message du magasin', v_case.ref),
        left(trim(p_body), 140), '/garagiste/dashboard/litiges', 'sav_cases', v_case.id, v_case.client_id);
    end if;
  else
    perform public.notify(v_org, 'STAFF', 'SAV_MESSAGE', format('Dossier %s : message de %s', v_case.ref, public.client_name(v_client)),
      left(trim(p_body), 140), '/dashboard/sav/' || v_case.id::text, 'sav_cases', v_case.id);
  end if;
end;
$$;
revoke execute on function public.add_sav_case_note(uuid, text, boolean) from public, anon;
grant execute on function public.add_sav_case_note(uuid, text, boolean) to authenticated;

create or replace function public.add_sav_case_file(p_case_id uuid, p_path text, p_kind text, p_caption text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_staff boolean := public.is_counter_staff();
  v_case public.sav_cases;
  v_id uuid;
begin
  if v_org is null or (not v_staff and v_client is null) then
    raise exception 'Access denied.';
  end if;
  perform public.assert_operational_access(v_org);
  select * into v_case from public.sav_cases c
  where c.id = p_case_id and c.organization_id = v_org and (v_staff or c.client_id = v_client);
  if not found then
    raise exception 'Case not found.';
  end if;
  if coalesce(p_path, '') not like v_org::text || '/' || v_case.id::text || '/%' then
    raise exception 'Invalid file path.';
  end if;
  insert into public.sav_case_files (organization_id, case_id, path, kind, caption, uploaded_by)
  values (v_org, v_case.id, p_path,
          case when p_kind in ('DEFAUT', 'PIECE', 'FACTURE_POSE', 'COEUR', 'AUTRE') then p_kind else 'DEFAUT' end,
          nullif(trim(coalesce(p_caption, '')), ''), auth.uid())
  returning id into v_id;
  perform public.sav_log(v_case, 'FILE', 'Pièce jointe ajoutée.' || coalesce(' ' || nullif(trim(coalesce(p_caption, '')), ''), ''), true);
  return v_id;
end;
$$;
revoke execute on function public.add_sav_case_file(uuid, text, text, text) from public, anon;
grant execute on function public.add_sav_case_file(uuid, text, text, text) to authenticated;

-- Les dossiers du garage connecté : ni statut fournisseur, ni enveloppe, ni notes internes.
create or replace function public.garage_sav_cases()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
begin
  if v_org is null or v_client is null then
    raise exception 'Garage access is required.';
  end if;
  return jsonb_build_object(
    'sla_hours', (public.sav_settings_for(v_org)).sla_hours,
    'labor_rate', (select c.labor_rate from public.clients c where c.id = v_client),
    'cases', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'ref', c.ref, 'type', c.type, 'origin', c.origin,
        'designation', c.designation, 'reference', c.reference, 'immatriculation', c.immatriculation,
        'description', c.description, 'client_status', c.client_status,
        'order_ref', (select o.ref_demande from public.orders o where o.id = c.order_id),
        'labor_rate', c.labor_rate, 'labor_hours', c.labor_hours, 'labor_amount', c.labor_amount,
        'gesture_type', c.gesture_type, 'gesture_amount', c.gesture_amount,
        'replacement_given', c.replacement_given,
        'sla_due_at', c.sla_due_at, 'first_response_at', c.first_response_at,
        'opened_at', c.opened_at, 'closed_at', c.closed_at,
        'events', coalesce((
          select jsonb_agg(jsonb_build_object('kind', e.kind, 'body', e.body, 'actor', e.actor_name, 'at', e.created_at) order by e.created_at)
          from public.sav_case_events e where e.case_id = c.id and e.visible_to_client
        ), '[]'::jsonb),
        'files', coalesce((
          select jsonb_agg(jsonb_build_object('id', f.id, 'path', f.path, 'kind', f.kind, 'caption', f.caption, 'mine', f.uploaded_by = auth.uid()) order by f.created_at)
          from public.sav_case_files f where f.case_id = c.id
        ), '[]'::jsonb)
      ) order by c.opened_at desc)
      from public.sav_cases c
      where c.organization_id = v_org and c.client_id = v_client
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.garage_sav_cases() from public, anon;
grant execute on function public.garage_sav_cases() to authenticated;

-- ---------------------------------------------------------------------------
-- 10) Retrouver une vente sans facture
-- ---------------------------------------------------------------------------

-- q = immatriculation (avec ou sans tirets), téléphone, nom du client,
-- n° de commande, référence ou n° de série. Une ligne de résultat par pièce
-- vendue, avec ses dates de garantie déjà calculées.
create or replace function public.sav_search_sales(p_q text, p_limit integer default 120)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_q text := trim(coalesce(p_q, ''));
  v_plate text := upper(regexp_replace(coalesce(p_q, ''), '[^A-Za-z0-9]', '', 'g'));
  v_digits text := regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g');
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  if length(v_q) < 3 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(row_json order by sale_date desc, designation)
    from (
      select
        public.line_warranty_start(l, o) as sale_date,
        l.nom_produit as designation,
        jsonb_build_object(
          'line_id', l.id, 'order_id', o.id, 'order_ref', o.ref_demande, 'order_date', o.date_commande,
          'warranty_start', public.line_warranty_start(l, o),
          'client_id', o.client_id, 'client_name', coalesce(c.name, 'Client comptoir'),
          'client_phone', coalesce(nullif(o.client_phone, ''), c.phone), 'is_garage', coalesce(c.is_garage, false),
          'plate', o.immatriculation, 'plate_norm', o.immat_norm, 'vehicle_model', o.vehicle_model, 'km', o.kilometrage,
          'garage_poseur', o.garage_poseur_name,
          'designation', l.nom_produit, 'reference', l.reference, 'marque', l.marque, 'famille', l.famille,
          'serial_number', l.serial_number, 'quantity', l.quantity, 'unit_price', l.prix_vente_unitaire,
          'supplier_id', l.supplier_id, 'supplier', s.name,
          'warranty_months', l.warranty_months, 'warranty_extension_months', l.warranty_extension_months,
          'handed_over', l.qte_remise, 'reception_status', l.reception_status,
          'consigne', l.consigne,
          'consigne_status', (select e.status from public.consignment_entries e where e.order_line_id = l.id limit 1),
          'returned', exists (select 1 from public.sales_returns r where r.order_line_id = l.id),
          'open_case', (
            select jsonb_build_object('id', k.id, 'ref', k.ref, 'type', k.type, 'client_status', k.client_status, 'closed', k.closed_at is not null)
            from public.sav_cases k where k.order_line_id = l.id order by k.opened_at desc limit 1
          )
        ) as row_json
      from public.order_lines l
      join public.orders o on o.id = l.order_id
      left join public.clients c on c.id = o.client_id
      left join public.suppliers s on s.id = l.supplier_id
      where o.organization_id = v_org
        and o.devis = false and o.is_restock = false and o.cancelled_at is null
        and (
          (length(v_plate) >= 4 and o.immat_norm like v_plate || '%')
          or (length(v_digits) >= 6 and regexp_replace(coalesce(o.client_phone, '') || ' ' || coalesce(c.phone, ''), '[^0-9 ]', '', 'g') like '%' || right(v_digits, 9) || '%')
          or o.ref_demande ilike '%' || v_q || '%'
          or c.name ilike '%' || v_q || '%'
          or l.reference ilike v_q || '%'
          or l.serial_number ilike v_q || '%'
        )
      order by o.date_commande desc
      limit greatest(1, least(coalesce(p_limit, 120), 400))
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.sav_search_sales(text, integer) from public, anon;
grant execute on function public.sav_search_sales(text, integer) to authenticated;

notify pgrst, 'reload schema';
