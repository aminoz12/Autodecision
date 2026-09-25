-- Module après-vente (2026-09-20) — 2/2 : les automatismes.
--
--  1. sms_notifications devient la file d'attente des messages au client
--     (evenement_notification) : kind, variables, date d'envoi, dédoublonnage.
--     Seules les fonctions de la base y déposent un message ; l'envoi reste à
--     /api/notifications/dispatch (Twilio), qui construit le texte à partir
--     des modèles du magasin. Un compte du comptoir ne peut ni créer ni
--     modifier un message en file.
--  2. Déclencheurs : commande prête (toutes les pièces reçues), retard
--     fournisseur (reliquat, pièce indisponible, tournée reportée), retrait
--     complet (→ enquête de satisfaction à J+3).
--  3. generate_sav_notifications(), appelée par le job quotidien existant :
--     relances de retrait J+3 / J+7 / J+15, consigne à J-10, dossier garantie
--     sans réponse fournisseur, date limite de retour fournisseur à J-5, avoir
--     dormant, relance d'entretien (consentement requis), litige hors délai.
--  4. Boucles retours (motif codé, fenêtre fournisseur) et consignes (état du
--     cœur, renvoi au fournisseur, avoir consigne).
--  5. sav_dashboard() : les quatre chiffres du haut d'écran et les analyses.

-- ---------------------------------------------------------------------------
-- 1) La file des messages client
-- ---------------------------------------------------------------------------

alter table public.sms_notifications
  add column if not exists kind text,
  add column if not exists channel text not null default 'SMS',
  add column if not exists vars jsonb,
  add column if not exists entity text,
  add column if not exists entity_id uuid,
  add column if not exists dedupe_key text,
  add column if not exists scheduled_for timestamptz,
  add column if not exists error text,
  add column if not exists simulated boolean not null default false;
create unique index if not exists sms_notifications_dedupe_idx
  on public.sms_notifications (organization_id, dedupe_key) where dedupe_key is not null;
create index if not exists sms_notifications_queue_idx
  on public.sms_notifications (scheduled_for) where kind is not null and status = 'A_ENVOYER';

-- Le comptoir garde ses écritures historiques (marqueur « traité »), mais un
-- message en file ne se fabrique ni ne se retouche depuis un compte utilisateur :
-- sinon n'importe quelle session pourrait faire partir un texte libre.
create or replace function public.sms_notifications_guard()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.kind := null;
      new.vars := null;
      new.scheduled_for := null;
      new.dedupe_key := null;
      new.entity := null;
      new.entity_id := null;
    elsif old.kind is not null and (
      new.kind is distinct from old.kind or new.phone is distinct from old.phone or new.vars is distinct from old.vars
      or new.message is distinct from old.message or new.status is distinct from old.status
      or new.scheduled_for is distinct from old.scheduled_for or new.channel is distinct from old.channel
    ) then
      raise exception 'Queued messages cannot be edited.';
    elsif old.kind is null and new.kind is not null then
      raise exception 'Queued messages cannot be edited.';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sms_notifications_guard on public.sms_notifications;
create trigger sms_notifications_guard before insert or update on public.sms_notifications
  for each row execute function public.sms_notifications_guard();

-- Dépose un message dans la file. Rien ne part si le client n'a pas de numéro,
-- ou s'il s'est désinscrit (messages non indispensables).
create or replace function public.sav_enqueue_sms(
  p_org uuid, p_kind text, p_order uuid, p_client uuid, p_vars jsonb, p_dedupe text,
  p_at timestamptz default null, p_entity text default null, p_entity_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_name text;
  v_opt_out timestamptz;
  v_consent boolean;
  v_channel text;
  v_inserted integer;
begin
  select nullif(trim(coalesce(o.client_phone, '')), '') into v_phone from public.orders o where o.id = p_order;
  if p_client is not null then
    select coalesce(v_phone, nullif(trim(coalesce(c.phone, '')), '')), c.name, c.sms_opt_out_at, c.sms_marketing_consent
    into v_phone, v_name, v_opt_out, v_consent
    from public.clients c where c.id = p_client;
  end if;
  if v_phone is null then
    return false;
  end if;
  if p_kind in ('SATISFACTION', 'AVOIR_BALANCE', 'AVOIR_DORMANT', 'MAINTENANCE') and v_opt_out is not null then
    return false;
  end if;
  -- Prospection commerciale : consentement recueilli à la vente (RGPD).
  if p_kind = 'MAINTENANCE' and not coalesce(v_consent, false) then
    return false;
  end if;
  select s.channel into v_channel from public.sav_settings s where s.organization_id = p_org;

  insert into public.sms_notifications (
    organization_id, order_id, client_id, phone, status, kind, channel, vars, entity, entity_id, dedupe_key, scheduled_for
  ) values (
    p_org, p_order, p_client, v_phone, 'A_ENVOYER', p_kind, coalesce(v_channel, 'SMS'),
    coalesce(p_vars, '{}'::jsonb) || jsonb_build_object('client', coalesce(v_name, '')),
    p_entity, p_entity_id, p_dedupe, coalesce(p_at, now())
  )
  on conflict (organization_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted > 0;
end;
$$;
revoke execute on function public.sav_enqueue_sms(uuid, text, uuid, uuid, jsonb, text, timestamptz, text, uuid) from public, anon, authenticated;

-- Annuler un message encore en file (comptoir).
create or replace function public.cancel_queued_sms(p_id uuid)
returns void
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
  update public.sms_notifications n
  set status = 'ECHEC', error = 'CANCELLED', traite = true
  where n.id = p_id and n.organization_id = v_org and n.kind is not null and n.status = 'A_ENVOYER';
  if not found then
    raise exception 'Queued message not found.';
  end if;
end;
$$;
revoke execute on function public.cancel_queued_sms(uuid) from public, anon;
grant execute on function public.cancel_queued_sms(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Enquête de satisfaction et désinscription (pages publiques)
-- ---------------------------------------------------------------------------

create table if not exists public.satisfaction_surveys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  token text not null default substr(md5(gen_random_uuid()::text), 1, 16),
  answer text check (answer in ('OUI', 'NON')),
  comment text,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists satisfaction_surveys_token_idx on public.satisfaction_surveys (token);
create unique index if not exists satisfaction_surveys_order_idx on public.satisfaction_surveys (order_id) where order_id is not null;

alter table public.satisfaction_surveys enable row level security;
drop policy if exists satisfaction_surveys_select on public.satisfaction_surveys;
create policy satisfaction_surveys_select on public.satisfaction_surveys for select
  using (organization_id = public.current_user_org_id() and public.is_counter_staff());
revoke all on public.satisfaction_surveys from public, anon, authenticated;
grant select on public.satisfaction_surveys to authenticated;

-- Ce que la page publique /avis/<jeton> affiche. Appelée par le serveur (service role).
create or replace function public.satisfaction_context(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'magasin', o.name,
    'answer', s.answer,
    'review_url', (select st.google_review_url from public.sav_settings st where st.organization_id = s.organization_id)
  )
  from public.satisfaction_surveys s
  join public.organizations o on o.id = s.organization_id
  where s.token = p_token;
$$;
revoke execute on function public.satisfaction_context(text) from public, anon, authenticated;
grant execute on function public.satisfaction_context(text) to service_role;

create or replace function public.answer_satisfaction(p_token text, p_answer text, p_comment text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_s public.satisfaction_surveys;
  v_order public.orders;
  v_first boolean;
begin
  if p_answer not in ('OUI', 'NON') then
    raise exception 'Invalid answer.';
  end if;
  select * into v_s from public.satisfaction_surveys s where s.token = p_token for update;
  if not found then
    raise exception 'Survey not found.';
  end if;
  v_first := v_s.answer is null or (v_s.answer = 'NON' and v_s.comment is null and nullif(trim(coalesce(p_comment, '')), '') is not null);
  update public.satisfaction_surveys s
  set answer = p_answer,
      comment = coalesce(nullif(left(trim(coalesce(p_comment, '')), 1000), ''), s.comment),
      answered_at = coalesce(s.answered_at, now())
  where s.id = v_s.id;

  if p_answer = 'NON' and v_first then
    select * into v_order from public.orders o where o.id = v_s.order_id;
    perform public.notify(v_s.organization_id, 'STAFF', 'SATISFACTION_NEGATIVE',
      format('Client mécontent : %s', coalesce(public.client_name(v_s.client_id), 'client comptoir')),
      format('Commande %s.%s Rappelez-le avant qu''il n''écrive un avis.', coalesce(v_order.ref_demande, ''),
             coalesce(' « ' || nullif(left(trim(coalesce(p_comment, '')), 160), '') || ' »', '')),
      case when v_s.order_id is not null then '/dashboard/commandes/' || v_s.order_id::text else '/dashboard/sav' end,
      'satisfaction_surveys', v_s.id, null, null,
      'SATISFACTION_NEGATIVE:' || v_s.id::text || case when nullif(trim(coalesce(p_comment, '')), '') is null then '' else ':c' end);
  end if;
  return public.satisfaction_context(p_token);
end;
$$;
revoke execute on function public.answer_satisfaction(text, text, text) from public, anon, authenticated;
grant execute on function public.answer_satisfaction(text, text, text) to service_role;

-- Lien « STOP » des messages non indispensables.
create or replace function public.unsubscribe_client(p_token text, p_resubscribe boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client public.clients;
begin
  select * into v_client from public.clients c where c.public_token = p_token for update;
  if not found then
    raise exception 'Unknown link.';
  end if;
  if coalesce(p_resubscribe, false) then
    update public.clients c set sms_opt_out_at = null where c.id = v_client.id;
  else
    update public.clients c
    set sms_opt_out_at = coalesce(c.sms_opt_out_at, now()), sms_marketing_consent = false, sms_marketing_consent_at = null
    where c.id = v_client.id;
    -- Ce qui attendait encore dans la file ne partira pas.
    update public.sms_notifications n
    set status = 'ECHEC', error = 'OPT_OUT', traite = true
    where n.client_id = v_client.id and n.status = 'A_ENVOYER'
      and n.kind in ('SATISFACTION', 'AVOIR_BALANCE', 'AVOIR_DORMANT', 'MAINTENANCE');
  end if;
  return jsonb_build_object(
    'magasin', (select o.name from public.organizations o where o.id = v_client.organization_id),
    'unsubscribed', not coalesce(p_resubscribe, false)
  );
end;
$$;
revoke execute on function public.unsubscribe_client(text, boolean) from public, anon, authenticated;
grant execute on function public.unsubscribe_client(text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 3) Déclencheurs : prête, en retard, retirée
-- ---------------------------------------------------------------------------

-- Retrait complet : toutes les pièces remises (ou commande livrée).
create or replace function public.sav_refresh_order_pickup(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.order_lines l where l.order_id = p_order_id and l.reception_status <> 'NOT_RECEIVED')
     and not exists (
       select 1 from public.order_lines l
       where l.order_id = p_order_id and l.reception_status <> 'NOT_RECEIVED' and l.qte_remise < l.quantity
     ) then
    update public.orders o set picked_up_at = now()
    where o.id = p_order_id and o.picked_up_at is null and o.devis = false and o.is_restock = false and o.cancelled_at is null;
  end if;
end;
$$;
revoke execute on function public.sav_refresh_order_pickup(uuid) from public, anon, authenticated;

create or replace function public.orders_sav_flow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.sav_settings;
  v_token text;
begin
  if new.workflow_status = 'DELIVERED' and old.workflow_status is distinct from 'DELIVERED' and new.picked_up_at is null then
    new.picked_up_at := now();
  end if;
  if new.picked_up_at is not null and old.picked_up_at is null
     and new.devis = false and new.is_restock = false and new.cancelled_at is null
     and (new.client_id is null or not public.client_is_garage(new.client_id)) then
    v_settings := public.sav_settings_for(new.organization_id);
    if v_settings.auto_sms_satisfaction then
      insert into public.satisfaction_surveys (organization_id, order_id, client_id)
      values (new.organization_id, new.id, new.client_id)
      on conflict do nothing
      returning token into v_token;
      if v_token is not null then
        perform public.sav_enqueue_sms(new.organization_id, 'SATISFACTION', new.id, new.client_id,
          jsonb_build_object('commande', new.ref_demande, 'token', v_token),
          'SATISFACTION:' || new.id::text, now() + interval '3 days', 'orders', new.id);
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orders_sav_flow on public.orders;
create trigger orders_sav_flow before update of workflow_status, picked_up_at on public.orders
  for each row execute function public.orders_sav_flow();

create or replace function public.order_lines_sav_flow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_settings public.sav_settings;
  v_pending integer;
  v_to_collect integer;
  v_is_garage boolean;
  v_eta date;
  v_base date;
  v_today date := timezone('Europe/Paris', now())::date;
  v_late boolean;
begin
  if new.reception_status is not distinct from old.reception_status
     and new.prevue_le is not distinct from old.prevue_le
     and new.pickup_status is not distinct from old.pickup_status
     and new.qte_remise is not distinct from old.qte_remise then
    return null;
  end if;
  select * into v_order from public.orders o where o.id = new.order_id;
  if not found or v_order.is_restock or v_order.devis or v_order.cancelled_at is not null then
    return null;
  end if;
  v_is_garage := v_order.client_id is not null and public.client_is_garage(v_order.client_id);
  v_settings := public.sav_settings_for(new.organization_id);

  -- a) Retrait.
  if new.qte_remise is distinct from old.qte_remise then
    perform public.sav_refresh_order_pickup(new.order_id);
  end if;

  -- b) Commande prête : plus aucune pièce attendue, au moins une à retirer.
  if new.reception_status = 'RECEIVED' and old.reception_status is distinct from 'RECEIVED' then
    select count(*) filter (where l.reception_status in ('PENDING', 'BACKORDER', 'PARTIAL')),
           count(*) filter (where l.reception_status = 'RECEIVED' and l.qte_remise < l.quantity)
    into v_pending, v_to_collect
    from public.order_lines l where l.order_id = new.order_id;
    if v_pending = 0 and v_to_collect > 0 then
      update public.orders o set ready_at = now() where o.id = new.order_id and o.ready_at is null;
      if v_settings.auto_sms_ready and not v_is_garage and not exists (
        select 1 from public.sms_notifications n
        where n.order_id = new.order_id and n.status = 'ENVOYE' and coalesce(n.kind, 'READY') = 'READY'
          and n.created_at > now() - interval '30 days'
      ) then
        perform public.sav_enqueue_sms(new.organization_id, 'READY', new.order_id, v_order.client_id,
          jsonb_build_object('commande', v_order.ref_demande), 'READY:' || new.order_id::text, null, 'orders', new.order_id);
      end if;
    end if;
  end if;

  -- c) Retard : reliquat, pièce indisponible chez le fournisseur, tournée reportée.
  v_late := (new.reception_status = 'BACKORDER' and old.reception_status is distinct from 'BACKORDER')
    or (new.pickup_status = 'UNAVAILABLE' and old.pickup_status is distinct from 'UNAVAILABLE')
    or (new.prevue_le is not null and old.prevue_le is not null and new.reception_status in ('PENDING', 'BACKORDER', 'PARTIAL')
        and timezone('Europe/Paris', new.prevue_le)::date > timezone('Europe/Paris', old.prevue_le)::date);
  if v_late and not v_is_garage then
    select max(timezone('Europe/Paris', l.prevue_le)::date) into v_eta
    from public.order_lines l
    where l.order_id = new.order_id and l.reception_status in ('PENDING', 'BACKORDER', 'PARTIAL');
    v_base := coalesce(v_order.promise_revised_date, v_order.promised_date, timezone('Europe/Paris', old.prevue_le)::date);
    if v_eta is not null and v_eta > v_today and (v_base is null or v_eta > v_base) then
      update public.orders o set promise_revised_date = v_eta where o.id = new.order_id;
      if v_settings.auto_sms_delay then
        perform public.sav_enqueue_sms(new.organization_id, 'DELAY', new.order_id, v_order.client_id,
          jsonb_build_object('commande', v_order.ref_demande, 'date', to_char(v_eta, 'DD/MM')),
          'DELAY:' || new.order_id::text || ':' || v_eta::text, null, 'orders', new.order_id);
      else
        perform public.notify(new.organization_id, 'STAFF', 'CLIENT_DELAY',
          format('Retard à annoncer : commande %s', v_order.ref_demande),
          format('%s — nouvelle date prévue le %s. Prévenez le client avant qu''il ne rappelle.', new.nom_produit, to_char(v_eta, 'DD/MM')),
          '/dashboard/commandes/' || new.order_id::text, 'orders', new.order_id, null, null,
          'CLIENT_DELAY:' || new.order_id::text || ':' || v_eta::text);
      end if;
    elsif new.reception_status = 'BACKORDER' or new.pickup_status = 'UNAVAILABLE' then
      if v_settings.auto_sms_delay then
        perform public.sav_enqueue_sms(new.organization_id, 'DELAY_NODATE', new.order_id, v_order.client_id,
          jsonb_build_object('commande', v_order.ref_demande), 'DELAY:' || new.order_id::text || ':nodate:' || v_today::text,
          null, 'orders', new.order_id);
      else
        perform public.notify(new.organization_id, 'STAFF', 'CLIENT_DELAY',
          format('Retard à annoncer : commande %s', v_order.ref_demande),
          format('%s est en retard chez le fournisseur. Prévenez le client avant qu''il ne rappelle.', new.nom_produit),
          '/dashboard/commandes/' || new.order_id::text, 'orders', new.order_id, null, null,
          'CLIENT_DELAY:' || new.order_id::text || ':nodate:' || v_today::text);
      end if;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists order_lines_sav_flow on public.order_lines;
create trigger order_lines_sav_flow
  after update of reception_status, prevue_le, pickup_status, qte_remise on public.order_lines
  for each row execute function public.order_lines_sav_flow();

-- set_order_sav_fields tourne juste après la création : une vente comptoir où
-- tout est remis d'emblée est « retirée » tout de suite.
create or replace function public.finalize_order_sav(p_order_id uuid)
returns void
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
  if not exists (select 1 from public.orders o where o.id = p_order_id and o.organization_id = v_org) then
    raise exception 'Order not found.';
  end if;
  -- Date promise par défaut : l'arrivée prévue de la dernière pièce attendue.
  update public.orders o
  set promised_date = (
    select max(timezone('Europe/Paris', l.prevue_le)::date) from public.order_lines l
    where l.order_id = o.id and l.reception_status in ('PENDING', 'BACKORDER', 'PARTIAL')
  )
  where o.id = p_order_id and o.promised_date is null;
  perform public.sav_refresh_order_pickup(p_order_id);
end;
$$;
revoke execute on function public.finalize_order_sav(uuid) from public, anon;
grant execute on function public.finalize_order_sav(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Retours : motif codé et fenêtre de retour fournisseur
-- ---------------------------------------------------------------------------

create or replace function public.sales_returns_sav_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier uuid := new.supplier_id;
  v_days integer;
  v_from date;
begin
  if new.supplier_deadline is null then
    if v_supplier is null and new.order_line_id is not null then
      select l.supplier_id into v_supplier from public.order_lines l where l.id = new.order_line_id;
    end if;
    if v_supplier is not null then
      select s.return_window_days into v_days from public.suppliers s where s.id = v_supplier;
      if v_days is not null then
        -- La fenêtre du grossiste court depuis la réception de la pièce.
        select coalesce(timezone('Europe/Paris', l.received_at)::date, o.date_commande) into v_from
        from public.order_lines l join public.orders o on o.id = l.order_id where l.id = new.order_line_id;
        new.supplier_deadline := coalesce(v_from, current_date) + v_days;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sales_returns_sav_defaults on public.sales_returns;
create trigger sales_returns_sav_defaults before insert on public.sales_returns
  for each row execute function public.sales_returns_sav_defaults();

-- Qualifie les retours créés pour des lignes (ou des retours donnés) : motif,
-- état de la pièce, frais de reprise.
create or replace function public.qualify_returns(
  p_return_ids uuid[], p_line_ids uuid[], p_motif_code text, p_etat text, p_frais numeric
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_n integer;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_motif_code is not null and p_motif_code not in
     ('ERREUR_VENDEUR', 'MAUVAISE_IDENTIFICATION', 'ERREUR_CLIENT', 'NON_CONFORME', 'DEFECTUEUSE', 'ANNULATION') then
    raise exception 'Invalid return reason code.';
  end if;
  if p_etat is not null and p_etat not in ('NEUVE_EMBALLEE', 'EMBALLAGE_ABIME', 'MONTEE', 'ENDOMMAGEE') then
    raise exception 'Invalid part condition.';
  end if;
  update public.sales_returns r
  set motif_code = coalesce(p_motif_code, r.motif_code),
      etat_piece = coalesce(p_etat, r.etat_piece),
      frais = coalesce(greatest(p_frais, 0), r.frais)
  where r.organization_id = v_org
    and (r.id = any(coalesce(p_return_ids, '{}'::uuid[])) or r.order_line_id = any(coalesce(p_line_ids, '{}'::uuid[])));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.qualify_returns(uuid[], uuid[], text, text, numeric) from public, anon;
grant execute on function public.qualify_returns(uuid[], uuid[], text, text, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Consignes : la double boucle
-- ---------------------------------------------------------------------------

create or replace function public.consignment_entries_sav_flow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier uuid;
  v_days integer;
begin
  if tg_op = 'INSERT' then
    -- Date limite de retour annoncée au client à la vente.
    if new.echeance is null and new.status = 'ACTIF' then
      new.echeance := current_date + (public.sav_settings_for(new.organization_id)).consigne_client_days;
    end if;
    if new.supplier_id is null and new.order_line_id is not null then
      select l.supplier_id into new.supplier_id from public.order_lines l where l.id = new.order_line_id;
    end if;
    return new;
  end if;

  if new.status = 'RENDUE' and old.status is distinct from 'RENDUE' then
    -- Le client a rapporté le cœur : la seconde boucle démarre.
    new.returned_at := coalesce(new.returned_at, now());
    v_supplier := new.supplier_id;
    if v_supplier is null and new.order_line_id is not null then
      select l.supplier_id into v_supplier from public.order_lines l where l.id = new.order_line_id;
      new.supplier_id := v_supplier;
    end if;
    if v_supplier is not null and new.supplier_status is null then
      new.supplier_status := 'A_RENVOYER';
      select s.core_return_days into v_days from public.suppliers s where s.id = v_supplier;
      if v_days is not null and new.supplier_deadline is null then
        new.supplier_deadline := current_date + v_days;
      end if;
    end if;
  elsif new.status = 'ACTIF' and old.status is distinct from 'ACTIF' then
    -- Réouverture (erreur de saisie) : le cœur n'est pas revenu.
    new.returned_at := null;
    new.core_state := null;
    if new.supplier_status = 'A_RENVOYER' then
      new.supplier_status := null;
      new.supplier_deadline := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists consignment_entries_sav_flow on public.consignment_entries;
create trigger consignment_entries_sav_flow before insert or update on public.consignment_entries
  for each row execute function public.consignment_entries_sav_flow();

alter table public.consignment_entries disable trigger audit_consignment_entries;
update public.consignment_entries e
set echeance = coalesce(e.echeance, (timezone('Europe/Paris', e.created_at)::date + 30)),
    supplier_id = coalesce(e.supplier_id, (select l.supplier_id from public.order_lines l where l.id = e.order_line_id))
where e.status = 'ACTIF' and (e.echeance is null or e.supplier_id is null);
alter table public.consignment_entries enable trigger audit_consignment_entries;

-- Reprise du cœur au comptoir : état constaté (et photo) + remboursement de la caution.
create or replace function public.return_consigne_core(p_entry_id uuid, p_state text, p_photo_path text default null)
returns public.consignment_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_entry public.consignment_entries;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_state not in ('COMPLET', 'INCOMPLET', 'CASSE', 'VIDE') then
    raise exception 'Invalid core condition.';
  end if;
  if p_photo_path is not null and p_photo_path not like v_org::text || '/%' then
    raise exception 'Invalid file path.';
  end if;
  update public.consignment_entries e
  set status = 'RENDUE', core_state = p_state, core_photo_path = coalesce(p_photo_path, e.core_photo_path)
  where e.id = p_entry_id and e.organization_id = v_org
  returning * into v_entry;
  if not found then
    raise exception 'Consignment entry not found.';
  end if;
  return v_entry;
end;
$$;
revoke execute on function public.return_consigne_core(uuid, text, text) from public, anon;
grant execute on function public.return_consigne_core(uuid, text, text) to authenticated;

-- Côté fournisseur : renvoyé, avoir consigne reçu, ou cœur refusé.
create or replace function public.set_consigne_supplier_status(
  p_entry_id uuid, p_status text, p_credit_amount numeric default null, p_deadline date default null
)
returns public.consignment_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_entry public.consignment_entries;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_status is not null and p_status not in ('A_RENVOYER', 'RENVOYE', 'AVOIR_RECU', 'REFUSE') then
    raise exception 'Invalid supplier status.';
  end if;
  update public.consignment_entries e
  set supplier_status = coalesce(p_status, e.supplier_status),
      supplier_sent_at = case
        when p_status in ('RENVOYE', 'AVOIR_RECU', 'REFUSE') then coalesce(e.supplier_sent_at, now())
        when p_status = 'A_RENVOYER' then null else e.supplier_sent_at end,
      supplier_credit_amount = case
        when p_status = 'AVOIR_RECU' then coalesce(p_credit_amount, e.supplier_credit_amount, e.montant)
        when p_status in ('A_RENVOYER', 'RENVOYE', 'REFUSE') then null else e.supplier_credit_amount end,
      supplier_credit_at = case when p_status = 'AVOIR_RECU' then coalesce(e.supplier_credit_at, now())
                                when p_status is not null then null else e.supplier_credit_at end,
      supplier_deadline = coalesce(p_deadline, e.supplier_deadline)
  where e.id = p_entry_id and e.organization_id = v_org
  returning * into v_entry;
  if not found then
    raise exception 'Consignment entry not found.';
  end if;
  return v_entry;
end;
$$;
revoke execute on function public.set_consigne_supplier_status(uuid, text, numeric, date) from public, anon;
grant execute on function public.set_consigne_supplier_status(uuid, text, numeric, date) to authenticated;

-- Le cœur repart par la tournée : la consigne devient un retour fournisseur
-- (type CONSIGNE) que le comptoir confie au livreur depuis « Retours ».
create or replace function public.consigne_to_supplier_return(p_entry_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_entry public.consignment_entries;
  v_year integer := extract(year from current_date);
  v_seq integer;
  v_id uuid;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  select * into v_entry from public.consignment_entries e where e.id = p_entry_id and e.organization_id = v_org for update;
  if not found then
    raise exception 'Consignment entry not found.';
  end if;
  if v_entry.return_id is not null then
    return v_entry.return_id;
  end if;
  if v_entry.status <> 'RENDUE' then
    raise exception 'The core has not been brought back yet.';
  end if;
  if v_entry.supplier_id is null then
    raise exception 'This consignment has no supplier.';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_org::text || ':returns:' || v_year::text));
  select coalesce(max(public.ref_seq(ref)), 0) + 1 into v_seq
  from public.sales_returns where organization_id = v_org and ref like format('RET-%s-%%', v_year);

  insert into public.sales_returns (
    organization_id, client_id, order_id, ref, designation, reason, motif,
    type_retour, statut_traitement, decote_pct, montant, supplier_id, supplier_deadline
  ) values (
    v_org, null, v_entry.order_id, format('RET-%s-%s', v_year, lpad(v_seq::text, 5, '0')),
    format('Cœur consigné — %s', v_entry.description), format('Renvoi de consigne %s', coalesce(v_entry.num, '')),
    'Renvoi de consigne', 'CONSIGNE', 'A_TRAITER', 0, coalesce(v_entry.montant, 0), v_entry.supplier_id, v_entry.supplier_deadline
  ) returning id into v_id;
  update public.consignment_entries e set return_id = v_id where e.id = v_entry.id;
  return v_id;
end;
$$;
revoke execute on function public.consigne_to_supplier_return(uuid) from public, anon;
grant execute on function public.consigne_to_supplier_return(uuid) to authenticated;

-- Le livreur a déposé le cœur chez le fournisseur : la consigne passe « renvoyée ».
create or replace function public.sales_returns_consigne_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.type_retour = 'CONSIGNE' and new.leg_status = 'FAIT' and old.leg_status is distinct from 'FAIT'
     and new.livreur_leg = 'STORE_TO_SUPPLIER' then
    update public.consignment_entries e
    set supplier_status = 'RENVOYE', supplier_sent_at = coalesce(e.supplier_sent_at, now())
    where e.return_id = new.id and e.supplier_status = 'A_RENVOYER';
  end if;
  return null;
end;
$$;

drop trigger if exists sales_returns_consigne_sync on public.sales_returns;
create trigger sales_returns_consigne_sync after update of leg_status on public.sales_returns
  for each row execute function public.sales_returns_consigne_sync();

-- Message manuel depuis le comptoir : solde d'avoir, rappel de consigne.
create or replace function public.queue_client_sms(p_kind text, p_entity_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_credit public.credit_notes;
  v_entry public.consignment_entries;
  v_day text := to_char(timezone('Europe/Paris', now()), 'YYYY-MM-DD');
  v_ok boolean;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_kind = 'AVOIR_BALANCE' then
    select * into v_credit from public.credit_notes c where c.id = p_entity_id and c.organization_id = v_org;
    if not found or v_credit.client_id is null or v_credit.amount - v_credit.used_amount <= 0 then
      raise exception 'No usable credit note for this client.';
    end if;
    v_ok := public.sav_enqueue_sms(v_org, 'AVOIR_BALANCE', null, v_credit.client_id,
      jsonb_build_object(
        'montant', to_char((select sum(c.amount - c.used_amount) from public.credit_notes c
                            where c.client_id = v_credit.client_id and c.organization_id = v_org and c.statut in ('EN_COURS', 'PARTIEL')), 'FM999G990D00'),
        'date', to_char(v_credit.echeance, 'DD/MM/YYYY'),
        'token', (select c.public_token from public.clients c where c.id = v_credit.client_id)),
      'AVOIR_BALANCE:' || v_credit.client_id::text || ':' || v_day, null, 'credit_notes', v_credit.id);
  elsif p_kind = 'CONSIGNE_REMINDER' then
    select * into v_entry from public.consignment_entries e where e.id = p_entity_id and e.organization_id = v_org;
    if not found or v_entry.status <> 'ACTIF' or v_entry.client_id is null then
      raise exception 'This consignment is not awaiting a core.';
    end if;
    v_ok := public.sav_enqueue_sms(v_org, 'CONSIGNE_REMINDER', v_entry.order_id, v_entry.client_id,
      jsonb_build_object('piece', v_entry.description, 'date', to_char(v_entry.echeance, 'DD/MM'),
                         'montant', to_char(coalesce(v_entry.montant, 0), 'FM999G990D00')),
      'CONSIGNE_REMINDER:' || v_entry.id::text || ':' || v_day, null, 'consignment_entries', v_entry.id);
  else
    raise exception 'Unsupported message kind.';
  end if;
  if not v_ok then
    raise exception 'No message queued: no phone number, unsubscribed client, or already sent today.';
  end if;
  return true;
end;
$$;
revoke execute on function public.queue_client_sms(text, uuid) from public, anon;
grant execute on function public.queue_client_sms(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Commandes prêtes et jamais retirées
-- ---------------------------------------------------------------------------

create or replace function public.sav_orders_awaiting_pickup(p_org uuid)
returns table (order_id uuid, organization_id uuid, client_id uuid, ref_demande text, ready_since timestamptz, value numeric)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.organization_id, o.client_id, o.ref_demande::text,
         coalesce(o.ready_at, max(l.received_at)),
         coalesce(sum(greatest(l.quantity - l.qte_remise, 0) * l.prix_vente_unitaire) filter (where l.reception_status = 'RECEIVED'), 0)
  from public.orders o
  join public.order_lines l on l.order_id = o.id
  where (p_org is null or o.organization_id = p_org)
    and o.devis = false and o.is_restock = false and o.cancelled_at is null
    and o.workflow_status <> 'DELIVERED' and o.picked_up_at is null
    and (o.client_id is null or not public.client_is_garage(o.client_id))
  group by o.id
  having count(*) filter (where l.reception_status in ('PENDING', 'BACKORDER', 'PARTIAL')) = 0
     and count(*) filter (where l.reception_status = 'RECEIVED' and l.qte_remise < l.quantity) > 0
     and coalesce(o.ready_at, max(l.received_at)) is not null;
$$;
revoke execute on function public.sav_orders_awaiting_pickup(uuid) from public, anon, authenticated;

-- Relance d'entretien : mois après la vente où l'on écrit au client.
create or replace function public.maintenance_relance_months(p_famille text)
returns integer
language sql
immutable
as $$
  select case p_famille
    when 'PLAQUETTES' then 20
    when 'VIDANGE' then 10
    when 'FILTRATION' then 11
    when 'BATTERIE' then 42
    when 'AMORTISSEURS' then 48
    when 'DISTRIBUTION' then 54
    when 'ESSUIE_GLACE' then 11
    else null
  end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Le job quotidien après-vente
-- ---------------------------------------------------------------------------

create or replace function public.generate_sav_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := timezone('Europe/Paris', now())::date;
  v_count integer := 0;
  v_settings public.sav_settings;
  v_days integer;
  v_step integer;
  v_email text;
  r record;
begin
  -- a) Pièce arrivée, jamais retirée : J+3, J+7, puis J+15.
  for r in select * from public.sav_orders_awaiting_pickup(null) loop
    v_days := v_today - timezone('Europe/Paris', r.ready_since)::date;
    v_step := case when v_days between 3 and 5 then 3 when v_days between 7 and 9 then 7 when v_days between 15 and 17 then 15 end;
    continue when v_step is null;
    v_settings := public.sav_settings_for(r.organization_id);
    if v_settings.auto_sms_pickup_reminders then
      if public.sav_enqueue_sms(r.organization_id, 'PICKUP_' || v_step::text, r.order_id, r.client_id,
           jsonb_build_object('commande', r.ref_demande), 'PICKUP_' || v_step::text || ':' || r.order_id::text,
           null, 'orders', r.order_id) then
        v_count := v_count + 1;
      end if;
    end if;
    if v_step = 15 then
      perform public.notify(r.organization_id, 'STAFF', 'PICKUP_EXPIRED',
        format('Non retirée depuis 15 jours : %s', r.ref_demande),
        format('%s € de pièces sur l''étagère. Proposez un remboursement ou remettez en stock.', to_char(r.value, 'FM999G999G990D00')),
        '/dashboard/commandes/' || r.order_id::text, 'orders', r.order_id, null, null, 'J15:' || r.order_id::text);
    end if;
  end loop;

  -- b) Consigne non rendue à J-10 de la limite.
  for r in
    select e.* from public.consignment_entries e
    where e.status = 'ACTIF' and e.client_id is not null and e.echeance is not null
      and e.echeance - 10 <= v_today and e.echeance >= v_today
  loop
    v_settings := public.sav_settings_for(r.organization_id);
    if v_settings.auto_sms_consigne then
      if public.sav_enqueue_sms(r.organization_id, 'CONSIGNE_REMINDER', r.order_id, r.client_id,
           jsonb_build_object('piece', r.description, 'date', to_char(r.echeance, 'DD/MM'),
                              'montant', to_char(coalesce(r.montant, 0), 'FM999G990D00')),
           'CONSIGNE_J10:' || r.id::text, null, 'consignment_entries', r.id) then
        v_count := v_count + 1;
      end if;
    end if;
  end loop;

  -- c) Dossier sans réponse du fournisseur : relance avec le numéro de dossier.
  for r in
    select c.*, s.name as supplier_name, s.sav_email, s.warranty_reminder_days
    from public.sav_cases c
    join public.suppliers s on s.id = c.supplier_id
    where c.supplier_status in ('DECLARE', 'EN_ATTENTE') and c.closed_at is null
      and coalesce(c.supplier_last_reminder_at, c.supplier_declared_at, c.opened_at)
          < now() - make_interval(days => greatest(coalesce(s.warranty_reminder_days, 15), 1))
  loop
    v_settings := public.sav_settings_for(r.organization_id);
    v_email := case when v_settings.auto_supplier_reminders then nullif(trim(coalesce(r.sav_email, '')), '') end;
    update public.sav_cases c
    set supplier_last_reminder_at = now(), supplier_reminder_count = c.supplier_reminder_count + 1
    where c.id = r.id;
    insert into public.sav_case_events (organization_id, case_id, kind, body, visible_to_client, actor_name, email_to, meta)
    values (r.organization_id, r.id, 'SUPPLIER_REMINDER',
      format('Relance n° %s de %s%s.', r.supplier_reminder_count + 1, r.supplier_name,
             case when v_email is not null then ' envoyée par e-mail' else ' à faire (pas d''e-mail SAV sur la fiche fournisseur)' end),
      false, 'Système', v_email,
      jsonb_build_object('supplier', r.supplier_name, 'case_number', r.supplier_case_number, 'ref', r.ref,
                         'designation', r.designation, 'reference', r.reference, 'serial_number', r.serial_number,
                         'declared_at', r.supplier_declared_at));
    perform public.notify(r.organization_id, 'STAFF', 'SAV_SUPPLIER_LATE',
      format('%s ne répond pas : dossier %s', r.supplier_name, r.ref),
      format('%s — déclaré le %s%s.', r.designation, to_char(coalesce(r.supplier_declared_at, r.opened_at), 'DD/MM/YYYY'),
             coalesce(', dossier n° ' || r.supplier_case_number, '')),
      '/dashboard/sav/' || r.id::text, 'sav_cases', r.id, null, null,
      'SAV_SUPPLIER_LATE:' || r.id::text || ':' || (r.supplier_reminder_count + 1)::text);
    v_count := v_count + 1;
  end loop;

  -- d) Date limite de retour fournisseur à J-5 (retours et cœurs consignés).
  for r in
    select x.id, x.organization_id, x.ref, x.designation, x.supplier_deadline, s.name as supplier_name
    from public.sales_returns x
    join public.suppliers s on s.id = x.supplier_id
    where x.supplier_deadline is not null and x.supplier_deadline between v_today and v_today + 5
      and x.statut_traitement in ('A_TRAITER', 'DEMANDE_ENVOYEE', 'A_RECUPERER') and coalesce(x.leg_status, '') <> 'FAIT'
  loop
    perform public.notify(r.organization_id, 'STAFF', 'RETURN_DEADLINE',
      format('Retour %s : à renvoyer à %s avant le %s', coalesce(r.ref, ''), r.supplier_name, to_char(r.supplier_deadline, 'DD/MM')),
      format('%s — passé ce délai, la pièce reste à la charge du magasin.', coalesce(r.designation, '')),
      '/dashboard/retours', 'sales_returns', r.id, null, null, 'RETURN_DEADLINE:' || r.id::text);
  end loop;
  for r in
    select e.id, e.organization_id, e.num, e.description, e.supplier_deadline, e.montant, s.name as supplier_name
    from public.consignment_entries e
    join public.suppliers s on s.id = e.supplier_id
    where e.supplier_status = 'A_RENVOYER' and e.supplier_deadline is not null
      and e.supplier_deadline between v_today and v_today + 5
  loop
    perform public.notify(r.organization_id, 'STAFF', 'CORE_DEADLINE',
      format('Cœur à renvoyer à %s avant le %s', r.supplier_name, to_char(r.supplier_deadline, 'DD/MM')),
      format('%s — %s € de consigne fournisseur en jeu.', r.description, to_char(coalesce(r.montant, 0), 'FM999G999G990D00')),
      '/dashboard/consignes', 'consignment_entries', r.id, null, null, 'CORE_DEADLINE:' || r.id::text);
  end loop;

  -- e) Avoir dormant.
  for r in
    select cn.*, c.public_token
    from public.credit_notes cn
    join public.clients c on c.id = cn.client_id
    join public.sav_settings st on st.organization_id = cn.organization_id
    where cn.statut in ('EN_COURS', 'PARTIEL') and cn.amount - cn.used_amount > 0
      and (cn.echeance is null or cn.echeance >= v_today)
      and cn.updated_at < now() - make_interval(months => st.dormant_credit_months)
      and st.auto_sms_avoir
  loop
    if public.sav_enqueue_sms(r.organization_id, 'AVOIR_DORMANT', null, r.client_id,
         jsonb_build_object('montant', to_char(r.amount - r.used_amount, 'FM999G990D00'),
                            'date', to_char(r.echeance, 'DD/MM/YYYY'), 'token', r.public_token),
         'AVOIR_DORMANT:' || r.id::text, null, 'credit_notes', r.id) then
      v_count := v_count + 1;
    end if;
  end loop;

  -- f) Relance d'entretien : consentement obligatoire, 40 messages par magasin et par jour.
  for r in
    select * from (
      select l.id as line_id, o.id as order_id, o.organization_id, o.client_id, o.vehicle_model, o.immatriculation,
             l.famille, c.public_token,
             row_number() over (partition by o.organization_id order by o.date_commande) as rn
      from public.order_lines l
      join public.orders o on o.id = l.order_id
      join public.clients c on c.id = o.client_id
      join public.sav_settings st on st.organization_id = o.organization_id
      where st.auto_sms_maintenance
        and c.sms_marketing_consent and c.sms_opt_out_at is null and c.is_garage = false
        and o.devis = false and o.is_restock = false and o.cancelled_at is null
        and public.maintenance_relance_months(l.famille) is not null
        and (o.date_commande + make_interval(months => public.maintenance_relance_months(l.famille)))::date
            between v_today - 30 and v_today
        and not exists (select 1 from public.sales_returns x where x.order_line_id = l.id)
        and not exists (select 1 from public.sms_notifications n
                        where n.organization_id = o.organization_id and n.dedupe_key = 'MAINT:' || l.id::text)
    ) q where q.rn <= 40
  loop
    if public.sav_enqueue_sms(r.organization_id, 'MAINTENANCE', r.order_id, r.client_id,
         jsonb_build_object('famille', r.famille,
                            'vehicule', coalesce(nullif(trim(coalesce(r.vehicle_model, '')), ''), nullif(trim(coalesce(r.immatriculation, '')), ''), ''),
                            'token', r.public_token),
         'MAINT:' || r.line_id::text, null, 'order_lines', r.line_id) then
      v_count := v_count + 1;
    end if;
  end loop;

  -- g) Litige garage sans première réponse dans le délai d'engagement.
  for r in
    select c.* from public.sav_cases c
    where c.closed_at is null and c.first_response_at is null and c.sla_due_at is not null and c.sla_due_at < now()
  loop
    perform public.notify(r.organization_id, 'STAFF', 'SAV_SLA',
      format('Délai dépassé : dossier %s sans réponse', r.ref),
      format('%s attend une réponse depuis le %s.', coalesce(public.client_name(r.client_id), 'Le client'), to_char(r.opened_at, 'DD/MM à HH24:MI')),
      '/dashboard/sav/' || r.id::text, 'sav_cases', r.id, null, null, 'SAV_SLA:' || r.id::text);
  end loop;

  return v_count;
end;
$$;
revoke execute on function public.generate_sav_notifications() from public, anon, authenticated;
grant execute on function public.generate_sav_notifications() to service_role;

-- ---------------------------------------------------------------------------
-- 8) Le tableau de bord après-vente
-- ---------------------------------------------------------------------------

create or replace function public.sav_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_today date := timezone('Europe/Paris', now())::date;
  v_since date := (timezone('Europe/Paris', now())::date - interval '6 months')::date;
  v_year date := (timezone('Europe/Paris', now())::date - interval '12 months')::date;
  v_dormant integer;
  v_result jsonb;
begin
  if v_org is null or not public.is_counter_staff() then
    raise exception 'Staff access is required.';
  end if;
  select coalesce((select s.dormant_credit_months from public.sav_settings s where s.organization_id = v_org), 6) into v_dormant;

  select jsonb_build_object(
    'immobilise', (
      select jsonb_build_object(
        'consignes_client', jsonb_build_object(
          'amount', coalesce(sum(e.montant) filter (where e.status = 'ACTIF'), 0),
          'count', count(*) filter (where e.status = 'ACTIF')),
        'consignes_fournisseur', jsonb_build_object(
          'amount', coalesce(sum(e.montant) filter (where e.supplier_status in ('A_RENVOYER', 'RENVOYE')), 0),
          'count', count(*) filter (where e.supplier_status in ('A_RENVOYER', 'RENVOYE'))),
        'at_risk', jsonb_build_object(
          'amount', coalesce(sum(e.montant) filter (where e.supplier_status = 'A_RENVOYER' and e.supplier_deadline <= v_today + 15), 0),
          'count', count(*) filter (where e.supplier_status = 'A_RENVOYER' and e.supplier_deadline <= v_today + 15)),
        'client_late', jsonb_build_object(
          'amount', coalesce(sum(e.montant) filter (where e.status = 'ACTIF' and e.echeance < v_today), 0),
          'count', count(*) filter (where e.status = 'ACTIF' and e.echeance < v_today))
      ) from public.consignment_entries e where e.organization_id = v_org
    ),
    'garanties', (
      select jsonb_build_object(
        'amount', coalesce(sum(c.part_value) filter (where c.supplier_status in ('A_DECLARER', 'DECLARE', 'EN_ATTENTE', 'ACCORDE')), 0),
        'count', count(*) filter (where c.supplier_status in ('A_DECLARER', 'DECLARE', 'EN_ATTENTE', 'ACCORDE')),
        'open', count(*) filter (where c.closed_at is null),
        'to_declare', count(*) filter (where c.supplier_status = 'A_DECLARER')
      ) from public.sav_cases c where c.organization_id = v_org
    ),
    'late', jsonb_build_object(
      'supplier_no_answer', (
        select count(*) from public.sav_cases c left join public.suppliers s on s.id = c.supplier_id
        where c.organization_id = v_org and c.closed_at is null and c.supplier_status in ('DECLARE', 'EN_ATTENTE')
          and coalesce(c.supplier_declared_at, c.opened_at) < now() - make_interval(days => coalesce(s.warranty_reminder_days, 15))),
      'sla', (
        select count(*) from public.sav_cases c
        where c.organization_id = v_org and c.closed_at is null and c.first_response_at is null and c.sla_due_at < now()),
      'returns_deadline', (
        select count(*) from public.sales_returns r
        where r.organization_id = v_org and r.supplier_id is not null and r.supplier_deadline is not null and r.supplier_deadline < v_today
          and r.statut_traitement in ('A_TRAITER', 'DEMANDE_ENVOYEE', 'A_RECUPERER') and coalesce(r.leg_status, '') <> 'FAIT'),
      'cores_deadline', (
        select count(*) from public.consignment_entries e
        where e.organization_id = v_org and e.supplier_status = 'A_RENVOYER' and e.supplier_deadline < v_today)
    ),
    'pickup', (
      select jsonb_build_object(
        'count', count(*), 'value', coalesce(sum(p.value), 0),
        'oldest_days', coalesce(max(v_today - timezone('Europe/Paris', p.ready_since)::date), 0),
        'avg_days', coalesce(round(avg(v_today - timezone('Europe/Paris', p.ready_since)::date)::numeric, 1), 0),
        'over_15', count(*) filter (where v_today - timezone('Europe/Paris', p.ready_since)::date >= 15)
      ) from public.sav_orders_awaiting_pickup(v_org) p
    ),
    'delay', (
      select jsonb_build_object(
        'avg_days', round((avg(extract(epoch from (c.closed_at - c.opened_at)) / 86400.0) filter (where c.closed_at is not null and c.opened_at >= v_since))::numeric, 1),
        'closed', count(*) filter (where c.closed_at is not null and c.opened_at >= v_since),
        'first_response_hours', round((avg(extract(epoch from (c.first_response_at - c.opened_at)) / 3600.0) filter (where c.first_response_at is not null and c.origin = 'GARAGE' and c.opened_at >= v_since))::numeric, 1)
      ) from public.sav_cases c where c.organization_id = v_org
    ),
    'credits', (
      select jsonb_build_object(
        'open_amount', coalesce(sum(cn.amount - cn.used_amount), 0),
        'open_count', count(*),
        'dormant_amount', coalesce(sum(cn.amount - cn.used_amount) filter (where cn.updated_at < now() - make_interval(months => v_dormant)), 0),
        'dormant_count', count(*) filter (where cn.updated_at < now() - make_interval(months => v_dormant))
      ) from public.credit_notes cn
      where cn.organization_id = v_org and cn.statut in ('EN_COURS', 'PARTIEL') and cn.amount - cn.used_amount > 0
    ),
    'satisfaction', (
      select jsonb_build_object(
        'sent', count(*), 'yes', count(*) filter (where s.answer = 'OUI'), 'no', count(*) filter (where s.answer = 'NON')
      ) from public.satisfaction_surveys s where s.organization_id = v_org and s.created_at >= v_since
    ),
    'return_rate_by_supplier', coalesce((
      select jsonb_agg(jsonb_build_object('supplier', q.name, 'lines', q.lines, 'returns', q.returns, 'warranties', q.warranties,
                                          'rate', round(100.0 * (q.returns + q.warranties) / nullif(q.lines, 0), 1))
                       order by (q.returns + q.warranties)::numeric / nullif(q.lines, 0) desc nulls last)
      from (
        select s.name, count(l.id) as lines,
               count(l.id) filter (where exists (select 1 from public.sales_returns r where r.order_line_id = l.id)) as returns,
               count(l.id) filter (where exists (select 1 from public.sav_cases k where k.order_line_id = l.id and k.type = 'GARANTIE')) as warranties
        from public.order_lines l
        join public.orders o on o.id = l.order_id
        join public.suppliers s on s.id = l.supplier_id
        where o.organization_id = v_org and o.devis = false and o.is_restock = false and o.cancelled_at is null and o.date_commande >= v_since
        group by s.name
        having count(l.id) >= 1
      ) q
    ), '[]'::jsonb),
    'warranty_by_famille', coalesce((
      select jsonb_agg(jsonb_build_object('famille', q.famille, 'lines', q.lines, 'cases', q.cases,
                                          'rate', round(100.0 * q.cases / nullif(q.lines, 0), 1))
                       order by q.cases desc, q.lines desc)
      from (
        select coalesce(l.famille, 'AUTRE') as famille, count(l.id) as lines,
               count(l.id) filter (where exists (select 1 from public.sav_cases k where k.order_line_id = l.id and k.type = 'GARANTIE')) as cases
        from public.order_lines l join public.orders o on o.id = l.order_id
        where o.organization_id = v_org and o.devis = false and o.is_restock = false and o.cancelled_at is null and o.date_commande >= v_year
        group by coalesce(l.famille, 'AUTRE')
      ) q where q.cases > 0
    ), '[]'::jsonb),
    'warranty_by_marque', coalesce((
      select jsonb_agg(jsonb_build_object('marque', q.marque, 'cases', q.cases, 'amount', q.amount) order by q.cases desc)
      from (
        select coalesce(nullif(upper(k.marque), ''), 'Marque non renseignée') as marque, count(*) as cases, coalesce(sum(k.part_value), 0) as amount
        from public.sav_cases k where k.organization_id = v_org and k.type = 'GARANTIE' and k.opened_at >= v_year
        group by 1
      ) q
    ), '[]'::jsonb),
    'supplier_response', coalesce((
      select jsonb_agg(jsonb_build_object('supplier', q.name, 'avg_days', q.avg_days, 'answered', q.answered, 'pending', q.pending)
                       order by q.avg_days desc nulls last)
      from (
        select s.name,
               round((avg(extract(epoch from (k.supplier_answered_at - k.supplier_declared_at)) / 86400.0)
                      filter (where k.supplier_answered_at is not null and k.supplier_declared_at is not null))::numeric, 1) as avg_days,
               count(*) filter (where k.supplier_answered_at is not null) as answered,
               count(*) filter (where k.supplier_status in ('DECLARE', 'EN_ATTENTE')) as pending
        from public.sav_cases k join public.suppliers s on s.id = k.supplier_id
        where k.organization_id = v_org and k.supplier_declared_at is not null
        group by s.name
      ) q
    ), '[]'::jsonb),
    'motifs', coalesce((
      select jsonb_agg(jsonb_build_object('motif_code', q.motif_code, 'count', q.n, 'amount', q.amount) order by q.n desc)
      from (
        select coalesce(r.motif_code, 'NON_CODE') as motif_code, count(*) as n, coalesce(sum(r.montant), 0) as amount
        from public.sales_returns r
        where r.organization_id = v_org and r.type_retour <> 'CONSIGNE' and r.created_at >= v_since
        group by 1
      ) q
    ), '[]'::jsonb),
    'motifs_by_vendeur', coalesce((
      select jsonb_agg(jsonb_build_object('vendeur', q.vendeur, 'returns', q.n, 'erreurs_reference', q.err, 'sales', q.sales) order by q.err desc, q.n desc)
      from (
        select coalesce(p.display_name, 'Vendeur') as vendeur,
               count(r.id) as n,
               count(r.id) filter (where r.motif_code in ('ERREUR_VENDEUR', 'MAUVAISE_IDENTIFICATION')) as err,
               (select count(*) from public.orders o2 where o2.organization_id = v_org and o2.vendeur_id = o.vendeur_id
                  and o2.devis = false and o2.is_restock = false and o2.date_commande >= v_since) as sales
        from public.sales_returns r
        join public.orders o on o.id = r.order_id
        left join public.profiles p on p.user_id = o.vendeur_id
        where r.organization_id = v_org and r.type_retour <> 'CONSIGNE' and r.created_at >= v_since
        group by o.vendeur_id, p.display_name
      ) q
    ), '[]'::jsonb),
    'cost', (
      select jsonb_build_object(
        'gestures', g.gestures, 'uncovered_warranty', g.uncovered, 'lost_cores', lc.lost, 'ca', ca.total,
        'total', g.gestures + g.uncovered + lc.lost,
        'pct', round(100.0 * (g.gestures + g.uncovered + lc.lost) / nullif(ca.total, 0), 2)
      )
      from (
        select coalesce(sum(k.gesture_amount) filter (where coalesce(k.gesture_budget, 'MAGASIN') <> 'FOURNISSEUR'), 0) as gestures,
               coalesce(sum(greatest(coalesce(k.part_value, 0) - coalesce(k.supplier_credit_amount, 0), 0))
                        filter (where k.type = 'GARANTIE' and k.client_status in ('REMPLACE', 'REMBOURSE')
                                and coalesce(k.supplier_status, 'REFUSE') in ('REFUSE', 'SANS_SUITE', 'AVOIR_RECU')), 0) as uncovered
        from public.sav_cases k where k.organization_id = v_org and k.opened_at >= v_year
      ) g,
      (select coalesce(sum(e.montant), 0) as lost from public.consignment_entries e
        where e.organization_id = v_org and e.supplier_status = 'REFUSE' and e.created_at >= v_year) lc,
      (select coalesce(sum(o.montant_total), 0) as total from public.orders o
        where o.organization_id = v_org and o.devis = false and o.is_restock = false and o.cancelled_at is null and o.date_commande >= v_year) ca
    )
  ) into v_result;
  return v_result;
end;
$$;
revoke execute on function public.sav_dashboard() from public, anon;
grant execute on function public.sav_dashboard() to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Le job planifié existant appelle désormais l'après-vente
-- ---------------------------------------------------------------------------
-- (corps inchangé, plus l'appel à generate_sav_notifications avant le bilan)

create or replace function public.generate_scheduled_notifications()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := timezone('Europe/Paris', now())::date;
  v_before integer;
  v_after integer;
  r record;
begin
  select count(*) into v_before from public.notifications;

  -- Avoirs périmés : le statut EXPIRE n'était jamais écrit.
  update public.credit_notes
  set statut = 'EXPIRE'::public.credit_status, updated_at = now()
  where echeance is not null and echeance < v_today and statut in ('EN_COURS', 'PARTIEL');

  -- Avoir qui expire dans 30 jours (garages).
  for r in
    select cn.* from public.credit_notes cn
    where cn.statut in ('EN_COURS', 'PARTIEL') and cn.echeance between v_today and v_today + 30
      and cn.amount - cn.used_amount > 0 and cn.client_id is not null and public.client_is_garage(cn.client_id)
  loop
    perform public.notify(r.organization_id, 'CLIENT', 'AVOIR_EXPIRING',
      format('Votre avoir %s expire le %s', coalesce(r.num, ''), to_char(r.echeance, 'DD/MM/YYYY')),
      format('Il reste %s € à utiliser.', to_char(r.amount - r.used_amount, 'FM999G999G990D00')),
      '/garagiste/dashboard/factures', 'credit_notes', r.id, r.client_id, null, 'AVOIR_EXPIRING:' || r.id::text);
  end loop;

  -- Échéance dans 3 jours (commandes en compte).
  for r in
    select o.* from public.orders o
    where o.mode_paiement = 'EN_COMPTE' and o.solde_restant > 0 and o.devis = false and o.echeance = v_today + 3
  loop
    perform public.notify(r.organization_id, 'CLIENT', 'DUE_SOON',
      format('Échéance le %s : %s €', to_char(r.echeance, 'DD/MM/YYYY'), to_char(r.solde_restant, 'FM999G999G990D00')),
      format('Commande %s.', r.ref_demande), '/garagiste/dashboard/factures', 'orders', r.id, r.client_id, null, 'DUE_SOON:' || r.id::text);
  end loop;

  -- Impayés échus : un rappel par garage et par semaine, côté magasin et côté garage.
  for r in
    select o.organization_id, o.client_id, sum(o.solde_restant) as due, count(*) as n
    from public.orders o
    where o.solde_restant > 0 and o.devis = false and o.is_restock = false
      and o.echeance is not null and o.echeance < v_today and o.client_id is not null
    group by o.organization_id, o.client_id
  loop
    perform public.notify(r.organization_id, 'STAFF', 'OVERDUE',
      format('Impayé : %s doit %s € échus', public.client_name(r.client_id), to_char(r.due, 'FM999G999G990D00')),
      format('%s commande(s) au-delà de l''échéance.', r.n), '/dashboard/garages/' || r.client_id::text, 'clients', r.client_id,
      null, null, 'OVERDUE_STAFF:' || r.client_id::text || ':' || to_char(v_today, 'IYYY-IW'));
    if public.client_is_garage(r.client_id) then
      perform public.notify(r.organization_id, 'CLIENT', 'OVERDUE',
        format('Règlement en retard : %s €', to_char(r.due, 'FM999G999G990D00')),
        format('%s commande(s) ont dépassé leur échéance. Merci de régulariser votre compte.', r.n),
        '/garagiste/dashboard/factures', 'clients', r.client_id, r.client_id, null,
        'OVERDUE_CLIENT:' || r.client_id::text || ':' || to_char(v_today, 'IYYY-IW'));
    end if;
  end loop;

  -- Devis garage sans réponse depuis 48 h.
  for r in
    select o.* from public.orders o
    where o.devis = true and coalesce(o.devis_status, 'REQUESTED') = 'REQUESTED'
      and o.client_id is not null and o."createdAt" < now() - interval '48 hours'
  loop
    perform public.notify(r.organization_id, 'STAFF', 'QUOTE_UNANSWERED',
      format('Devis %s sans réponse depuis 2 jours', r.ref_demande),
      format('%s attend votre chiffrage.', public.client_name(r.client_id)), '/dashboard/garages', 'orders', r.id,
      null, null, 'QUOTE_UNANSWERED:' || r.id::text);
  end loop;

  -- Rappel J+7 : pièces reçues, jamais retirées ni livrées (clients particuliers).
  for r in
    select o.id, o.organization_id, o.ref_demande, o.client_id
    from public.orders o
    where o.devis = false and o.is_restock = false
      and o.workflow_status <> 'DELIVERED'
      and (o.client_id is null or not public.client_is_garage(o.client_id))
      and not exists (select 1 from public.order_lines l where l.order_id = o.id and l.reception_status in ('PENDING', 'BACKORDER'))
      and exists (select 1 from public.order_lines l where l.order_id = o.id and l.reception_status = 'RECEIVED')
      and not exists (select 1 from public.order_lines l where l.order_id = o.id and l.reception_status = 'RECEIVED' and l.qte_remise < l.quantity and false)
      and (select max(l.received_at) from public.order_lines l where l.order_id = o.id) < now() - interval '7 days'
      and exists (select 1 from public.order_lines l where l.order_id = o.id and l.qte_remise < l.quantity)
  loop
    perform public.notify(r.organization_id, 'STAFF', 'PICKUP_REMINDER',
      format('Rappel J+7 : pièces non retirées (%s)', r.ref_demande),
      'Les pièces sont prêtes depuis 7 jours. Relancez le client (SMS depuis « Commande à préparer »).',
      '/dashboard/commandes?tab=apreparer', 'orders', r.id, null, null, 'J7:' || r.id::text);
  end loop;

  -- Après-vente : relances de retrait, consignes, garanties, avoirs dormants, entretien.
  begin
    perform public.generate_sav_notifications();
  exception when others then
    raise warning 'generate_sav_notifications failed: %', sqlerrm;
  end;

  select count(*) into v_after from public.notifications;
  insert into public.system_jobs (name, last_run_at, last_result)
  values ('scheduled_notifications', now(), (v_after - v_before)::text || ' inserted')
  on conflict (name) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result;
  return v_after - v_before;
end;
$$;
revoke execute on function public.generate_scheduled_notifications() from public, anon, authenticated;
grant execute on function public.generate_scheduled_notifications() to service_role;

notify pgrst, 'reload schema';
