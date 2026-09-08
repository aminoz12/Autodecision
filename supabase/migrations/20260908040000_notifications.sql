-- Notifications backbone (audit 2026-09-07, chantier 7).
--
--  * notifications: one row per event and audience (STAFF of the org, the
--    CLIENT/garage portal, or one LIVREUR user). Read in-app (bell + Realtime)
--    and fanned out by email through /api/notifications/dispatch when
--    email_to is set (Resend, env-gated).
--  * Row triggers on orders / order_lines / sales_returns / payments /
--    invoices / credit_notes write the events that used to go nowhere.
--  * generate_scheduled_notifications(): daily reminders (rappel J+7 pièces
--    non retirées, échéance J-3, impayés, avoirs qui expirent, devis sans
--    réponse) + expiry of credit notes (statut EXPIRE, never written before).
--    Scheduled with pg_cron when available; the dispatch route also runs it
--    at most once an hour as a fallback.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  audience text not null check (audience in ('STAFF', 'CLIENT', 'LIVREUR')),
  client_id uuid references public.clients (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  href text,
  entity text,
  entity_id uuid,
  dedupe_key text,
  read_at timestamptz,
  email_to text,
  email_sent_at timestamptz,
  email_error text,
  created_at timestamptz not null default now()
);
create index if not exists notifications_org_created_idx on public.notifications (organization_id, created_at desc);
create index if not exists notifications_client_idx on public.notifications (client_id, created_at desc) where client_id is not null;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc) where user_id is not null;
create unique index if not exists notifications_dedupe_idx on public.notifications (organization_id, dedupe_key) where dedupe_key is not null;
create index if not exists notifications_email_outbox_idx on public.notifications (created_at) where email_to is not null and email_sent_at is null;

alter table public.notifications enable row level security;
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select
  using (
    organization_id = public.current_user_org_id()
    and (
      (audience = 'STAFF' and public.is_counter_staff())
      or (audience = 'CLIENT' and client_id is not null and client_id = public.current_user_client_id())
      or (audience = 'LIVREUR' and user_id = auth.uid())
    )
  );
revoke all on public.notifications from public, anon, authenticated;
grant select on public.notifications to authenticated;

create table if not exists public.system_jobs (
  name text primary key,
  last_run_at timestamptz,
  last_result text
);
alter table public.system_jobs enable row level security;
revoke all on public.system_jobs from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Insert helper
-- ---------------------------------------------------------------------
create or replace function public.notify(
  p_org uuid, p_audience text, p_type text, p_title text, p_body text, p_href text,
  p_entity text default null, p_entity_id uuid default null,
  p_client uuid default null, p_user uuid default null, p_dedupe text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if p_audience = 'CLIENT' then
    if p_client is null then return; end if;
    select c.email into v_email from public.clients c where c.id = p_client;
  elsif p_audience = 'LIVREUR' then
    if p_user is null then return; end if;
    select u.email into v_email from auth.users u where u.id = p_user;
  end if;
  insert into public.notifications (organization_id, audience, client_id, user_id, type, title, body, href, entity, entity_id, dedupe_key, email_to)
  values (p_org, p_audience, case when p_audience = 'CLIENT' then p_client end, case when p_audience = 'LIVREUR' then p_user end,
          p_type, p_title, p_body, p_href, p_entity, p_entity_id, p_dedupe, nullif(trim(coalesce(v_email, '')), ''))
  on conflict do nothing;
end;
$$;
revoke execute on function public.notify(uuid, text, text, text, text, text, text, uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.client_is_garage(p_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.is_garage from public.clients c where c.id = p_client), false);
$$;
revoke execute on function public.client_is_garage(uuid) from public, anon, authenticated;

create or replace function public.client_name(p_client uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.name from public.clients c where c.id = p_client), 'Client');
$$;
revoke execute on function public.client_name(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Orders: devis, expédition, livraison
-- ---------------------------------------------------------------------
create or replace function public.orders_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_garage boolean := new.client_id is not null and public.client_is_garage(new.client_id);
  v_name text;
  v_livreur_user uuid;
begin
  if tg_op = 'INSERT' then
    if new.devis and v_garage and coalesce(new.devis_status, 'REQUESTED') = 'REQUESTED' then
      v_name := public.client_name(new.client_id);
      perform public.notify(new.organization_id, 'STAFF', 'QUOTE_REQUESTED',
        format('Nouveau devis : %s', v_name), format('%s demande un chiffrage (%s).', v_name, new.ref_demande),
        '/dashboard/garages', 'orders', new.id);
    end if;
    return null;
  end if;

  if new.devis_status is distinct from old.devis_status then
    if new.devis_status = 'QUOTED' and v_garage then
      perform public.notify(new.organization_id, 'CLIENT', 'QUOTE_ANSWERED',
        format('Devis %s chiffré', new.ref_demande), 'Votre magasin a répondu : consultez les prix et validez.',
        '/garagiste/dashboard/commandes', 'orders', new.id, new.client_id);
    elsif new.devis_status in ('ACCEPTED', 'REFUSED') and v_garage then
      v_name := public.client_name(new.client_id);
      perform public.notify(new.organization_id, 'STAFF', 'QUOTE_RESOLVED',
        format('Devis %s %s', new.ref_demande, case when new.devis_status = 'ACCEPTED' then 'accepté' else 'refusé' end),
        format('%s a %s le devis.', v_name, case when new.devis_status = 'ACCEPTED' then 'accepté' else 'refusé' end),
        case when new.devis_status = 'ACCEPTED' then '/dashboard/commandes?tab=alivrer' else '/dashboard/garages' end,
        'orders', new.id);
    end if;
  end if;

  if new.workflow_status is distinct from old.workflow_status then
    if new.workflow_status = 'IN_TRANSIT' then
      if v_garage then
        perform public.notify(new.organization_id, 'CLIENT', 'ORDER_SHIPPED',
          format('Commande %s en cours de livraison', new.ref_demande),
          case when new.date_envoi is not null then format('Livraison prévue vers %s.', to_char(new.date_envoi at time zone 'Europe/Paris', 'HH24"h"MI')) else 'Le livreur est en route.' end,
          '/garagiste/dashboard/commandes', 'orders', new.id, new.client_id);
      end if;
      if new.livreur_id is not null then
        select p.user_id into v_livreur_user from public.profiles p where p.livreur_id = new.livreur_id limit 1;
        if v_livreur_user is not null then
          perform public.notify(new.organization_id, 'LIVREUR', 'DELIVERY_ASSIGNED',
            format('Nouvelle livraison : %s', coalesce(public.client_name(new.client_id), 'client')),
            format('Commande %s à livrer.', new.ref_demande), '/livreur', 'orders', new.id, null, v_livreur_user);
        end if;
      end if;
    elsif new.workflow_status = 'DELIVERED' and v_garage then
      perform public.notify(new.organization_id, 'CLIENT', 'ORDER_DELIVERED',
        format('Commande %s livrée', new.ref_demande), 'Vos pièces ont été livrées.',
        '/garagiste/dashboard/commandes', 'orders', new.id, new.client_id);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists orders_notify on public.orders;
create trigger orders_notify after insert or update of devis_status, workflow_status on public.orders
  for each row execute function public.orders_notify();

-- ---------------------------------------------------------------------
-- Order lines: reliquat arrivé
-- ---------------------------------------------------------------------
create or replace function public.order_lines_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
begin
  if old.reception_status = 'BACKORDER' and new.reception_status = 'RECEIVED' then
    select * into v_order from public.orders o where o.id = new.order_id;
    perform public.notify(new.organization_id, 'STAFF', 'BACKORDER_RECEIVED',
      format('Reliquat reçu : %s', new.nom_produit), format('Commande %s — la pièce attendue est arrivée.', v_order.ref_demande),
      '/dashboard/commandes?tab=arecevoir', 'order_lines', new.id);
    if v_order.client_id is not null and public.client_is_garage(v_order.client_id) then
      perform public.notify(new.organization_id, 'CLIENT', 'BACKORDER_RECEIVED',
        format('Pièce en reliquat reçue : %s', new.nom_produit), format('Commande %s.', v_order.ref_demande),
        '/garagiste/dashboard/commandes', 'order_lines', new.id, v_order.client_id);
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists order_lines_notify on public.order_lines;
create trigger order_lines_notify after update of reception_status on public.order_lines
  for each row execute function public.order_lines_notify();

-- ---------------------------------------------------------------------
-- Returns
-- ---------------------------------------------------------------------
create or replace function public.sales_returns_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text;
begin
  if tg_op = 'INSERT' then
    if public.current_user_client_id() is not null and new.client_id is not null then
      perform public.notify(new.organization_id, 'STAFF', 'RETURN_REQUESTED',
        format('Retour demandé par %s', public.client_name(new.client_id)),
        format('%s — %s', coalesce(new.designation, new.ref), coalesce(new.reason, new.motif, '')),
        '/dashboard/retours', 'sales_returns', new.id);
    end if;
    return null;
  end if;
  if new.statut_traitement is distinct from old.statut_traitement
     and new.statut_traitement in ('ACCEPTE', 'REFUSE', 'AVOIR', 'REMBOURSE')
     and new.client_id is not null and public.client_is_garage(new.client_id) then
    v_label := case new.statut_traitement::text
      when 'ACCEPTE' then 'accepté' when 'REFUSE' then 'refusé'
      when 'AVOIR' then 'réglé par avoir' else 'remboursé' end;
    perform public.notify(new.organization_id, 'CLIENT', 'RETURN_SETTLED',
      format('Retour %s %s', coalesce(new.ref, ''), v_label), coalesce(new.designation, ''),
      '/garagiste/dashboard/retours', 'sales_returns', new.id, new.client_id);
  end if;
  return null;
end;
$$;
drop trigger if exists sales_returns_notify on public.sales_returns;
create trigger sales_returns_notify after insert or update of statut_traitement on public.sales_returns
  for each row execute function public.sales_returns_notify();

-- ---------------------------------------------------------------------
-- Payments, invoices, credit notes → garage portal
-- ---------------------------------------------------------------------
create or replace function public.payments_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind in ('ENCAISSEMENT', 'REGLEMENT_COMPTE') and new.client_id is not null and public.client_is_garage(new.client_id) then
    perform public.notify(new.organization_id, 'CLIENT', 'PAYMENT_RECEIVED',
      format('Règlement de %s € enregistré', to_char(new.amount, 'FM999G999G990D00')),
      format('Reçu par %s. Votre relevé est à jour.', case new.mode when 'ESPECES' then 'espèces' when 'CARTE' then 'carte' when 'VIREMENT' then 'virement' else 'chèque' end),
      '/garagiste/dashboard/factures', 'payments', new.id, new.client_id);
  end if;
  return null;
end;
$$;
drop trigger if exists payments_notify on public.payments;
create trigger payments_notify after insert on public.payments
  for each row execute function public.payments_notify();

create or replace function public.invoices_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_id is not null and public.client_is_garage(new.client_id) then
    perform public.notify(new.organization_id, 'CLIENT', 'INVOICE_ISSUED',
      format('%s %s disponible', case when new.kind = 'AVOIR' then 'Avoir' else 'Facture' end, new.number),
      format('Montant TTC : %s €.', to_char(coalesce((new.totals->>'ttc')::numeric, 0), 'FM999G999G990D00')),
      '/garagiste/dashboard/factures/' || new.id::text, 'invoices', new.id, new.client_id);
  end if;
  return null;
end;
$$;
drop trigger if exists invoices_notify on public.invoices;
create trigger invoices_notify after insert on public.invoices
  for each row execute function public.invoices_notify();

create or replace function public.credit_notes_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.client_id is not null and public.client_is_garage(new.client_id) then
    perform public.notify(new.organization_id, 'CLIENT', 'CREDIT_ISSUED',
      format('Avoir %s de %s €', coalesce(new.num, ''), to_char(new.amount, 'FM999G999G990D00')),
      case when new.echeance is not null then format('Valable jusqu''au %s.', to_char(new.echeance, 'DD/MM/YYYY')) else null end,
      '/garagiste/dashboard/factures', 'credit_notes', new.id, new.client_id);
  end if;
  return null;
end;
$$;
drop trigger if exists credit_notes_notify on public.credit_notes;
create trigger credit_notes_notify after insert on public.credit_notes
  for each row execute function public.credit_notes_notify();

-- ---------------------------------------------------------------------
-- Scheduled reminders (idempotent through dedupe_key)
-- ---------------------------------------------------------------------
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

  select count(*) into v_after from public.notifications;
  insert into public.system_jobs (name, last_run_at, last_result)
  values ('scheduled_notifications', now(), (v_after - v_before)::text || ' inserted')
  on conflict (name) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result;
  return v_after - v_before;
end;
$$;
revoke execute on function public.generate_scheduled_notifications() from public, anon, authenticated;
grant execute on function public.generate_scheduled_notifications() to service_role;

-- ---------------------------------------------------------------------
-- Mark as read (recipient only)
-- ---------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client uuid := public.current_user_client_id();
  v_staff boolean := public.is_counter_staff();
  v_n integer;
begin
  if v_org is null or auth.uid() is null then
    raise exception 'Authenticated access is required.';
  end if;
  update public.notifications n
  set read_at = now()
  where n.organization_id = v_org and n.read_at is null
    and (p_ids is null or n.id = any(p_ids))
    and (
      (n.audience = 'STAFF' and v_staff)
      or (n.audience = 'CLIENT' and v_client is not null and n.client_id = v_client)
      or (n.audience = 'LIVREUR' and n.user_id = auth.uid())
    );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- Realtime + daily schedule
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception when others then
  raise notice 'realtime publication: %', sqlerrm;
end $$;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'autodecision-scheduled-notifications';
  perform cron.schedule('autodecision-scheduled-notifications', '15 6 * * *', $job$select public.generate_scheduled_notifications();$job$);
exception when others then
  raise notice 'pg_cron not scheduled (%): the dispatch route runs the job hourly instead.', sqlerrm;
end $$;

notify pgrst, 'reload schema';
