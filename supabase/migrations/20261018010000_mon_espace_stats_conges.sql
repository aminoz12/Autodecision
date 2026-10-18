-- Mon espace : stats personnelles et congés des caissiers et livreurs (2026-10-18).
--
--  1. leave_requests / leave_allowances : demandes de congé (payé, récupération,
--     sans solde, maladie, autre) en jours ouvrés français, droits annuels
--     (25 j par défaut, modifiables par l'administrateur).
--  2. fr_business_days : jours ouvrés (lun.–ven. hors fériés français, Pâques
--     incluse) — même calcul que lib/conges.ts côté navigateur.
--  3. Notifications « USER » : personnelles (user_id), pour prévenir les
--     administrateurs d'une demande et l'employé d'une réponse.
--  4. RPC employé : request_leave, cancel_leave, my_leave_space.
--     RPC admin  : decide_leave, admin_add_absence, set_leave_allowance,
--     admin_leave_board.
--  5. RPC stats : my_counter_stats (CA, ventes, devis, classement, pointages)
--     et my_livreur_stats (livraisons, échecs, pièces récupérées, tournées).
--     Un livreur ne lit toujours rien directement : tout passe par ces RPC.

-- ---------------------------------------------------------------------
-- 0. Helpers : administrateur du magasin, jours ouvrés
-- ---------------------------------------------------------------------
create or replace function public.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid()
      and p.role = 'ADMIN'::public.user_role
      and p.client_id is null
      and p.livreur_id is null
  );
$$;
revoke execute on function public.is_org_admin() from public, anon;
grant execute on function public.is_org_admin() to authenticated;

-- Dimanche de Pâques (algorithme de Meeus/Jones/Butcher).
create or replace function public.fr_easter(p_year integer)
returns date
language plpgsql
immutable
as $$
declare
  a int := p_year % 19;
  b int := p_year / 100;
  c int := p_year % 100;
  d int := b / 4;
  e int := b % 4;
  f int := (b + 8) / 25;
  g int;
  h int;
  i int := c / 4;
  k int := c % 4;
  l int;
  m int;
  n int;
begin
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  n := h + l - 7 * m + 114;
  return make_date(p_year, n / 31, (n % 31) + 1);
end;
$$;

create or replace function public.fr_public_holidays(p_year integer)
returns setof date
language sql
immutable
as $$
  select unnest(array[
    make_date(p_year, 1, 1), make_date(p_year, 5, 1), make_date(p_year, 5, 8), make_date(p_year, 7, 14),
    make_date(p_year, 8, 15), make_date(p_year, 11, 1), make_date(p_year, 11, 11), make_date(p_year, 12, 25),
    public.fr_easter(p_year) + 1, public.fr_easter(p_year) + 39, public.fr_easter(p_year) + 50
  ]);
$$;

-- Jours ouvrés entre deux dates incluses (lundi–vendredi hors jours fériés).
create or replace function public.fr_business_days(p_from date, p_to date)
returns integer
language sql
immutable
as $$
  select count(*)::int
  from generate_series(p_from, p_to, interval '1 day') d
  where extract(isodow from d) < 6
    and d::date not in (
      select public.fr_public_holidays(y)
      from generate_series(extract(year from p_from)::int, extract(year from p_to)::int) y
    );
$$;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('CONGE_PAYE', 'RECUPERATION', 'SANS_SOLDE', 'MALADIE', 'AUTRE')),
  date_from date not null,
  date_to date not null,
  days numeric(5,1) not null check (days >= 0),
  comment text,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REFUSED', 'CANCELLED')),
  created_by uuid references auth.users (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_requests_dates_check check (date_to >= date_from)
);
create index if not exists leave_requests_user_idx on public.leave_requests (user_id, date_from desc);
create index if not exists leave_requests_org_idx on public.leave_requests (organization_id, date_from desc);
create index if not exists leave_requests_org_pending_idx on public.leave_requests (organization_id, created_at) where status = 'PENDING';

create table if not exists public.leave_allowances (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  year integer not null,
  days numeric(5,1) not null default 25 check (days >= 0),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id, year)
);

alter table public.leave_requests enable row level security;
alter table public.leave_allowances enable row level security;
revoke all on public.leave_requests from public, anon, authenticated;
revoke all on public.leave_allowances from public, anon, authenticated;
grant select on public.leave_requests to authenticated;
grant select on public.leave_allowances to authenticated;

drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests for select
  using (
    organization_id = (select public.current_user_org_id())
    and (user_id = (select auth.uid()) or (select public.is_org_admin()))
  );
drop policy if exists leave_allowances_select on public.leave_allowances;
create policy leave_allowances_select on public.leave_allowances for select
  using (
    organization_id = (select public.current_user_org_id())
    and (user_id = (select auth.uid()) or (select public.is_org_admin()))
  );

-- ---------------------------------------------------------------------
-- 2. Notifications personnelles (audience USER)
-- ---------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_audience_check;
alter table public.notifications
  add constraint notifications_audience_check check (audience in ('STAFF', 'CLIENT', 'LIVREUR', 'USER'));

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select
  using (
    organization_id = (select public.current_user_org_id())
    and (
      (audience = 'STAFF' and (select public.is_counter_staff()))
      or (audience = 'CLIENT' and client_id is not null and client_id = (select public.current_user_client_id()))
      or (audience in ('LIVREUR', 'USER') and user_id = (select auth.uid()))
    )
  );

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
  elsif p_audience in ('LIVREUR', 'USER') then
    if p_user is null then return; end if;
    select u.email into v_email from auth.users u where u.id = p_user;
  end if;
  insert into public.notifications (organization_id, audience, client_id, user_id, type, title, body, href, entity, entity_id, dedupe_key, email_to)
  values (p_org, p_audience, case when p_audience = 'CLIENT' then p_client end, case when p_audience in ('LIVREUR', 'USER') then p_user end,
          p_type, p_title, p_body, p_href, p_entity, p_entity_id, p_dedupe, nullif(trim(coalesce(v_email, '')), ''))
  on conflict do nothing;
end;
$$;
revoke execute on function public.notify(uuid, text, text, text, text, text, text, uuid, uuid, uuid, text) from public, anon, authenticated;

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
      or (n.audience in ('LIVREUR', 'USER') and n.user_id = auth.uid())
    );
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Internes : libellés, solde, destinataires
-- ---------------------------------------------------------------------
create or replace function public.leave_type_label(p_type text)
returns text
language sql
immutable
as $$
  select case p_type
    when 'CONGE_PAYE' then 'Congé payé'
    when 'RECUPERATION' then 'Récupération'
    when 'SANS_SOLDE' then 'Congé sans solde'
    when 'MALADIE' then 'Arrêt maladie'
    else 'Absence' end;
$$;

create or replace function public.leave_period_label(p_from date, p_to date)
returns text
language sql
immutable
as $$
  select case when p_from = p_to
    then to_char(p_from, 'DD/MM/YYYY')
    else to_char(p_from, 'DD/MM') || ' → ' || to_char(p_to, 'DD/MM/YYYY') end;
$$;

-- Solde de congés payés d'une personne pour une année (année de la date de début).
create or replace function public.leave_balance(p_org uuid, p_user uuid, p_year integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_allowance numeric;
  v_taken numeric := 0;
  v_planned numeric := 0;
  v_pending numeric := 0;
begin
  select a.days into v_allowance from public.leave_allowances a
  where a.organization_id = p_org and a.user_id = p_user and a.year = p_year;
  v_allowance := coalesce(v_allowance, 25);

  select
    coalesce(sum(r.days) filter (where r.status = 'APPROVED' and r.date_to < v_today), 0),
    coalesce(sum(r.days) filter (where r.status = 'APPROVED' and r.date_to >= v_today), 0),
    coalesce(sum(r.days) filter (where r.status = 'PENDING'), 0)
  into v_taken, v_planned, v_pending
  from public.leave_requests r
  where r.organization_id = p_org and r.user_id = p_user
    and r.type = 'CONGE_PAYE'
    and extract(year from r.date_from)::int = p_year;

  return jsonb_build_object(
    'year', p_year,
    'allowance', v_allowance,
    'taken', v_taken,
    'planned', v_planned,
    'pending', v_pending,
    'remaining', v_allowance - v_taken - v_planned - v_pending
  );
end;
$$;
revoke execute on function public.leave_balance(uuid, uuid, integer) from public, anon, authenticated;

-- Les administrateurs d'un magasin (membres ADMIN, un seul login pour plusieurs magasins).
create or replace function public.notify_org_admins(p_org uuid, p_type text, p_title text, p_body text, p_entity_id uuid, p_dedupe text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
begin
  for v_admin in
    select distinct p.user_id
    from public.profiles p
    left join public.organization_members m on m.user_id = p.user_id
    where p.role = 'ADMIN'::public.user_role and p.client_id is null and p.livreur_id is null
      and (p.organization_id = p_org or m.organization_id = p_org)
  loop
    perform public.notify(p_org, 'USER', p_type, p_title, p_body, '/admin?tab=conges', 'leave_request', p_entity_id,
                          null, v_admin, case when p_dedupe is null then null else p_dedupe || ':' || v_admin::text end);
  end loop;
end;
$$;
revoke execute on function public.notify_org_admins(uuid, text, text, text, uuid, text) from public, anon, authenticated;

-- Où l'employé voit ses congés : l'espace livreur ou « Mon espace » du comptoir.
create or replace function public.leave_home_href(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when exists (select 1 from public.profiles p where p.user_id = p_user and p.role = 'LIVREUR'::public.user_role)
    then '/livreur?tab=espace' else '/dashboard/mon-espace' end;
$$;
revoke execute on function public.leave_home_href(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. RPC employé
-- ---------------------------------------------------------------------
create or replace function public.request_leave(p_type text, p_from date, p_to date, p_comment text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_user uuid := auth.uid();
  v_profile public.profiles;
  v_days integer;
  v_remaining numeric;
  v_id uuid;
  v_today date := (now() at time zone 'Europe/Paris')::date;
begin
  select * into v_profile from public.profiles p where p.user_id = v_user;
  if v_org is null or v_profile.user_id is null or v_profile.client_id is not null then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_type not in ('CONGE_PAYE', 'RECUPERATION', 'SANS_SOLDE', 'MALADIE', 'AUTRE') then
    raise exception 'Type d''absence inconnu.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Les dates ne sont pas valides.';
  end if;
  if p_from < v_today - 60 then
    raise exception 'La date de début est trop ancienne.';
  end if;
  if p_to > v_today + 400 then
    raise exception 'La date de fin est trop lointaine.';
  end if;
  v_days := public.fr_business_days(p_from, p_to);
  if v_days = 0 then
    raise exception 'Aucun jour ouvré sur cette période.';
  end if;
  if exists (
    select 1 from public.leave_requests r
    where r.user_id = v_user and r.organization_id = v_org
      and r.status in ('PENDING', 'APPROVED')
      and r.date_from <= p_to and r.date_to >= p_from
  ) then
    raise exception 'Vous avez déjà une demande sur ces dates.';
  end if;
  if p_type = 'CONGE_PAYE' then
    v_remaining := (public.leave_balance(v_org, v_user, extract(year from p_from)::int) ->> 'remaining')::numeric;
    if v_remaining < v_days then
      raise exception 'Solde insuffisant : il vous reste % jour(s) de congés payés.', v_remaining;
    end if;
  end if;

  insert into public.leave_requests (organization_id, user_id, type, date_from, date_to, days, comment, created_by)
  values (v_org, v_user, p_type, p_from, p_to, v_days, nullif(trim(coalesce(p_comment, '')), ''), v_user)
  returning id into v_id;

  perform public.notify_org_admins(
    v_org, 'LEAVE_REQUEST',
    'Demande de congé : ' || coalesce(nullif(trim(v_profile.display_name), ''), 'un membre de l''équipe'),
    public.leave_type_label(p_type) || ' · ' || public.leave_period_label(p_from, p_to) || ' · ' || v_days || ' jour' || case when v_days > 1 then 's' else '' end,
    v_id, 'leave:' || v_id::text
  );
  return v_id;
end;
$$;
revoke execute on function public.request_leave(text, date, date, text) from public, anon;
grant execute on function public.request_leave(text, date, date, text) to authenticated;

create or replace function public.cancel_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_user uuid := auth.uid();
  v_row public.leave_requests;
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_name text;
begin
  select * into v_row from public.leave_requests r where r.id = p_id and r.organization_id = v_org and r.user_id = v_user for update;
  if v_row.id is null then
    raise exception 'Demande introuvable.';
  end if;
  -- An absence entered by the administrator (arrêt maladie…) is not the employee's to cancel.
  if v_row.created_by is distinct from v_user then
    raise exception 'Cette absence a été saisie par votre responsable : demandez-lui de la modifier.';
  end if;
  if v_row.status = 'PENDING' or (v_row.status = 'APPROVED' and v_row.date_from > v_today) then
    update public.leave_requests set status = 'CANCELLED', updated_at = now() where id = p_id;
  else
    raise exception 'Cette demande ne peut plus être annulée.';
  end if;
  if v_row.status = 'APPROVED' then
    select nullif(trim(p.display_name), '') into v_name from public.profiles p where p.user_id = v_user;
    perform public.notify_org_admins(
      v_org, 'LEAVE_CANCELLED',
      'Congé annulé : ' || coalesce(v_name, 'un membre de l''équipe'),
      public.leave_type_label(v_row.type) || ' · ' || public.leave_period_label(v_row.date_from, v_row.date_to),
      p_id, 'leave-cancel:' || p_id::text
    );
  end if;
end;
$$;
revoke execute on function public.cancel_leave(uuid) from public, anon;
grant execute on function public.cancel_leave(uuid) to authenticated;

-- Solde de l'année + toutes les demandes de la personne (les plus récentes d'abord).
create or replace function public.my_leave_space(p_year integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_user uuid := auth.uid();
  v_year integer := coalesce(p_year, extract(year from (now() at time zone 'Europe/Paris'))::int);
begin
  if v_org is null or v_user is null or public.current_user_client_id() is not null then
    raise exception 'Staff access is required.';
  end if;
  return jsonb_build_object(
    'balance', public.leave_balance(v_org, v_user, v_year),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'type', r.type, 'date_from', r.date_from, 'date_to', r.date_to, 'days', r.days,
        'comment', r.comment, 'status', r.status, 'created_at', r.created_at,
        'decided_at', r.decided_at, 'decision_note', r.decision_note,
        'decided_by', (select nullif(trim(p.display_name), '') from public.profiles p where p.user_id = r.decided_by)
      ) order by r.date_from desc, r.created_at desc)
      from public.leave_requests r
      where r.organization_id = v_org and r.user_id = v_user
    ), '[]'::jsonb)
  );
end;
$$;
revoke execute on function public.my_leave_space(integer) from public, anon;
grant execute on function public.my_leave_space(integer) to authenticated;

-- ---------------------------------------------------------------------
-- 5. RPC administrateur
-- ---------------------------------------------------------------------
create or replace function public.decide_leave(p_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_row public.leave_requests;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if v_org is null or not public.is_org_admin() then
    raise exception 'Admin access is required.';
  end if;
  select * into v_row from public.leave_requests r where r.id = p_id and r.organization_id = v_org for update;
  if v_row.id is null then
    raise exception 'Demande introuvable.';
  end if;
  if v_row.status <> 'PENDING' then
    raise exception 'Cette demande a déjà été traitée.';
  end if;
  update public.leave_requests
  set status = case when p_approve then 'APPROVED' else 'REFUSED' end,
      decided_by = auth.uid(), decided_at = now(), decision_note = v_note, updated_at = now()
  where id = p_id;

  perform public.notify(
    v_org, 'USER', case when p_approve then 'LEAVE_APPROVED' else 'LEAVE_REFUSED' end,
    case when p_approve then 'Congé validé' else 'Congé refusé' end,
    public.leave_type_label(v_row.type) || ' · ' || public.leave_period_label(v_row.date_from, v_row.date_to)
      || case when v_note is null then '' else ' — « ' || v_note || ' »' end,
    public.leave_home_href(v_row.user_id), 'leave_request', p_id, null, v_row.user_id, 'leave-decision:' || p_id::text
  );
end;
$$;
revoke execute on function public.decide_leave(uuid, boolean, text) from public, anon;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;

-- Absence saisie par l'administrateur (maladie, congé posé à l'oral…) : validée d'office.
create or replace function public.admin_add_absence(p_user uuid, p_type text, p_from date, p_to date, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_days integer;
  v_id uuid;
begin
  if v_org is null or not public.is_org_admin() then
    raise exception 'Admin access is required.';
  end if;
  if not exists (
    select 1 from public.profiles p
    left join public.organization_members m on m.user_id = p.user_id
    where p.user_id = p_user and p.client_id is null and (p.organization_id = v_org or m.organization_id = v_org)
  ) then
    raise exception 'Cette personne ne fait pas partie du magasin.';
  end if;
  if p_type not in ('CONGE_PAYE', 'RECUPERATION', 'SANS_SOLDE', 'MALADIE', 'AUTRE') then
    raise exception 'Type d''absence inconnu.';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Les dates ne sont pas valides.';
  end if;
  v_days := public.fr_business_days(p_from, p_to);
  if v_days = 0 then
    raise exception 'Aucun jour ouvré sur cette période.';
  end if;
  if exists (
    select 1 from public.leave_requests r
    where r.user_id = p_user and r.organization_id = v_org
      and r.status in ('PENDING', 'APPROVED')
      and r.date_from <= p_to and r.date_to >= p_from
  ) then
    raise exception 'Cette personne a déjà une absence sur ces dates.';
  end if;
  insert into public.leave_requests (organization_id, user_id, type, date_from, date_to, days, comment, status, created_by, decided_by, decided_at)
  values (v_org, p_user, p_type, p_from, p_to, v_days, nullif(trim(coalesce(p_note, '')), ''), 'APPROVED', auth.uid(), auth.uid(), now())
  returning id into v_id;

  perform public.notify(
    v_org, 'USER', 'LEAVE_APPROVED', 'Absence enregistrée',
    public.leave_type_label(p_type) || ' · ' || public.leave_period_label(p_from, p_to) || ' · ' || v_days || ' jour' || case when v_days > 1 then 's' else '' end,
    public.leave_home_href(p_user), 'leave_request', v_id, null, p_user, 'leave-decision:' || v_id::text
  );
  return v_id;
end;
$$;
revoke execute on function public.admin_add_absence(uuid, text, date, date, text) from public, anon;
grant execute on function public.admin_add_absence(uuid, text, date, date, text) to authenticated;

create or replace function public.set_leave_allowance(p_user uuid, p_year integer, p_days numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  if v_org is null or not public.is_org_admin() then
    raise exception 'Admin access is required.';
  end if;
  if p_days is null or p_days < 0 or p_days > 99 then
    raise exception 'Nombre de jours invalide.';
  end if;
  if not exists (
    select 1 from public.profiles p
    left join public.organization_members m on m.user_id = p.user_id
    where p.user_id = p_user and p.client_id is null and (p.organization_id = v_org or m.organization_id = v_org)
  ) then
    raise exception 'Cette personne ne fait pas partie du magasin.';
  end if;
  insert into public.leave_allowances (organization_id, user_id, year, days)
  values (v_org, p_user, p_year, p_days)
  on conflict (organization_id, user_id, year) do update set days = excluded.days, updated_at = now();
end;
$$;
revoke execute on function public.set_leave_allowance(uuid, integer, numeric) from public, anon;
grant execute on function public.set_leave_allowance(uuid, integer, numeric) to authenticated;

-- Tout ce que l'écran « Congés » de l'administrateur affiche.
create or replace function public.admin_leave_board(p_year integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_year integer := coalesce(p_year, extract(year from (now() at time zone 'Europe/Paris'))::int);
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_pending jsonb;
  v_balances jsonb;
  v_absences jsonb;
begin
  if v_org is null or not public.is_org_admin() then
    raise exception 'Admin access is required.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'user_id', r.user_id,
    'name', coalesce(nullif(trim(p.display_name), ''), 'Membre'),
    'role', p.role,
    'type', r.type, 'date_from', r.date_from, 'date_to', r.date_to, 'days', r.days,
    'comment', r.comment, 'created_at', r.created_at,
    'remaining', case when r.type = 'CONGE_PAYE'
      then (public.leave_balance(v_org, r.user_id, extract(year from r.date_from)::int) ->> 'remaining')::numeric end,
    'overlaps', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', coalesce(nullif(trim(p2.display_name), ''), 'Membre'),
        'date_from', o.date_from, 'date_to', o.date_to, 'status', o.status
      ) order by o.date_from)
      from public.leave_requests o
      left join public.profiles p2 on p2.user_id = o.user_id
      where o.organization_id = v_org and o.id <> r.id and o.user_id <> r.user_id
        and o.status in ('PENDING', 'APPROVED')
        and o.date_from <= r.date_to and o.date_to >= r.date_from
    ), '[]'::jsonb)
  ) order by r.created_at), '[]'::jsonb)
  into v_pending
  from public.leave_requests r
  left join public.profiles p on p.user_id = r.user_id
  where r.organization_id = v_org and r.status = 'PENDING';

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', p.user_id,
    'name', coalesce(nullif(trim(p.display_name), ''), 'Membre'),
    'role', p.role,
    'balance', public.leave_balance(v_org, p.user_id, v_year)
  ) order by p.role, p.display_name), '[]'::jsonb)
  into v_balances
  from public.profiles p
  where p.organization_id = v_org and p.client_id is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'user_id', r.user_id,
    'name', coalesce(nullif(trim(p.display_name), ''), 'Membre'),
    'role', p.role,
    'type', r.type, 'date_from', r.date_from, 'date_to', r.date_to, 'days', r.days, 'status', r.status
  ) order by r.date_from), '[]'::jsonb)
  into v_absences
  from public.leave_requests r
  left join public.profiles p on p.user_id = r.user_id
  where r.organization_id = v_org and r.status in ('PENDING', 'APPROVED')
    and r.date_to >= v_today - 60 and r.date_from <= v_today + 400;

  return jsonb_build_object('year', v_year, 'today', v_today, 'pending', v_pending, 'balances', v_balances, 'absences', v_absences);
end;
$$;
revoke execute on function public.admin_leave_board(integer) from public, anon;
grant execute on function public.admin_leave_board(integer) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Stats personnelles
-- ---------------------------------------------------------------------
-- Comptoir : mes commandes (vendeur_id = moi, hors devis / réassort / annulées),
-- devis, pointages, classement parmi les vendeurs du magasin, période précédente.
create or replace function public.my_counter_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_user uuid := auth.uid();
  v_len integer := (p_to - p_from) + 1;
  v_prev_from date := p_from - v_len;
  v_prev_to date := p_from - 1;
  v_mine jsonb;
  v_prev jsonb;
  v_days jsonb;
  v_rank integer;
  v_sellers integer;
  v_team_ca numeric;
  v_my_ca numeric;
begin
  perform public.assert_counter_staff();
  if v_org is null or p_from is null or p_to is null or p_to < p_from or v_len > 400 then
    raise exception 'Période invalide.';
  end if;

  select jsonb_build_object(
    'orders', count(*),
    'ca', coalesce(sum(o.montant_total), 0),
    'panier_moyen', case when count(*) > 0 then round(coalesce(sum(o.montant_total), 0) / count(*), 2) else 0 end,
    'remises', coalesce(sum(o.remise_montant), 0)
  ) into v_mine
  from public.orders o
  where o.organization_id = v_org and o.vendeur_id = v_user
    and o.devis = false and o.is_restock = false and o.cancelled_at is null
    and o.date_commande between p_from and p_to;
  v_my_ca := (v_mine ->> 'ca')::numeric;

  select jsonb_build_object(
    'orders', count(*),
    'ca', coalesce(sum(o.montant_total), 0)
  ) into v_prev
  from public.orders o
  where o.organization_id = v_org and o.vendeur_id = v_user
    and o.devis = false and o.is_restock = false and o.cancelled_at is null
    and o.date_commande between v_prev_from and v_prev_to;

  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'ca', d.ca, 'orders', d.orders) order by d.day), '[]'::jsonb)
  into v_days
  from (
    select o.date_commande as day, coalesce(sum(o.montant_total), 0) as ca, count(*) as orders
    from public.orders o
    where o.organization_id = v_org and o.vendeur_id = v_user
      and o.devis = false and o.is_restock = false and o.cancelled_at is null
      and o.date_commande between p_from and p_to
    group by 1
  ) d;

  -- Classement au CA parmi les vendeurs du comptoir (les garages qui commandent eux-mêmes sont exclus).
  with sellers as (
    select o.vendeur_id, sum(o.montant_total) as ca
    from public.orders o
    join public.profiles p on p.user_id = o.vendeur_id
    where o.organization_id = v_org
      and p.client_id is null and p.livreur_id is null
      and o.devis = false and o.is_restock = false and o.cancelled_at is null
      and o.date_commande between p_from and p_to
    group by o.vendeur_id
  )
  select
    1 + count(*) filter (where s.ca > v_my_ca),
    count(*) + case when exists (select 1 from sellers s2 where s2.vendeur_id = v_user) then 0 else 1 end,
    coalesce(sum(s.ca), 0)
  into v_rank, v_sellers, v_team_ca
  from sellers s;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'orders', (v_mine ->> 'orders')::int,
    'ca', v_my_ca,
    'panier_moyen', (v_mine ->> 'panier_moyen')::numeric,
    'remises', (v_mine ->> 'remises')::numeric,
    'prev_orders', (v_prev ->> 'orders')::int,
    'prev_ca', (v_prev ->> 'ca')::numeric,
    'devis_total', (
      select count(*) from public.orders o
      where o.organization_id = v_org and o.vendeur_id = v_user and o.is_restock = false
        and (o.devis or o.devis_status is not null)
        and o.date_commande between p_from and p_to
    ),
    'devis_accepted', (
      select count(*) from public.orders o
      where o.organization_id = v_org and o.vendeur_id = v_user and o.is_restock = false
        and o.devis_status = 'ACCEPTED'
        and o.date_commande between p_from and p_to
    ),
    'lines_pointed', (
      select count(*) from public.order_lines l
      where l.organization_id = v_org and l.pointed_by = v_user
        and (l.pointed_at at time zone 'Europe/Paris')::date between p_from and p_to
    ),
    'lines_handed', (
      select count(*) from public.order_lines l
      where l.organization_id = v_org and l.handed_by = v_user
        and (l.handed_at at time zone 'Europe/Paris')::date between p_from and p_to
    ),
    'rank', v_rank,
    'sellers', v_sellers,
    'team_ca', v_team_ca,
    'days', v_days
  );
end;
$$;
revoke execute on function public.my_counter_stats(date, date) from public, anon;
grant execute on function public.my_counter_stats(date, date) to authenticated;

-- Livreur : livraisons faites, échecs, pièces récupérées chez les fournisseurs,
-- tournées terminées — sans aucun montant.
create or replace function public.my_livreur_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_user uuid := auth.uid();
  v_livreur uuid := public.current_user_livreur_id();
  v_linked uuid;
  v_len integer := (p_to - p_from) + 1;
  v_prev_from date := p_from - v_len;
  v_prev_to date := p_from - 1;
  v_delivered integer;
  v_prev_delivered integer;
  v_failed integer;
  v_pickups integer;
  v_tours integer;
  v_days jsonb;
begin
  select p.livreur_id into v_linked from public.profiles p where p.user_id = v_user;
  if v_org is null or v_linked is null then
    raise exception 'Livreur access is required.';
  end if;
  if v_livreur is null then
    raise exception 'Livreur access is disabled.';
  end if;
  perform public.assert_operational_access(v_org);
  if p_from is null or p_to is null or p_to < p_from or v_len > 400 then
    raise exception 'Période invalide.';
  end if;

  select count(*) into v_delivered
  from public.orders o
  where o.organization_id = v_org and o.workflow_status = 'DELIVERED'
    and (o.delivered_by = v_user or (o.delivered_by is null and o.livreur_id = v_livreur))
    and (o.delivered_at at time zone 'Europe/Paris')::date between p_from and p_to;

  select count(*) into v_prev_delivered
  from public.orders o
  where o.organization_id = v_org and o.workflow_status = 'DELIVERED'
    and (o.delivered_by = v_user or (o.delivered_by is null and o.livreur_id = v_livreur))
    and (o.delivered_at at time zone 'Europe/Paris')::date between v_prev_from and v_prev_to;

  select count(*) into v_failed
  from public.orders o
  where o.organization_id = v_org and o.livreur_id = v_livreur
    and (o.delivery_failed_at at time zone 'Europe/Paris')::date between p_from and p_to;

  select count(*) into v_pickups
  from public.order_lines l
  join public.delivery_tours t on t.id = l.tour_id
  where l.organization_id = v_org and t.livreur_id = v_livreur
    and l.pickup_status = 'PICKED_UP'
    and (l.pickup_at at time zone 'Europe/Paris')::date between p_from and p_to;

  select count(*) into v_tours
  from public.delivery_tours t
  where t.organization_id = v_org and t.livreur_id = v_livreur
    and t.status = 'TERMINEE' and t.tour_date between p_from and p_to;

  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'delivered', d.n) order by d.day), '[]'::jsonb)
  into v_days
  from (
    select (o.delivered_at at time zone 'Europe/Paris')::date as day, count(*) as n
    from public.orders o
    where o.organization_id = v_org and o.workflow_status = 'DELIVERED'
      and (o.delivered_by = v_user or (o.delivered_by is null and o.livreur_id = v_livreur))
      and (o.delivered_at at time zone 'Europe/Paris')::date between p_from and p_to
    group by 1
  ) d;

  return jsonb_build_object(
    'from', p_from, 'to', p_to,
    'delivered', v_delivered,
    'prev_delivered', v_prev_delivered,
    'failed', v_failed,
    'pickups', v_pickups,
    'tours', v_tours,
    'days', v_days
  );
end;
$$;
revoke execute on function public.my_livreur_stats(date, date) from public, anon;
grant execute on function public.my_livreur_stats(date, date) to authenticated;

notify pgrst, 'reload schema';
