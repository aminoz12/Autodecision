-- Tablette « Suivi des commandes » (2026-10-05).
--
-- Une tablette près du stock reste connectée sur un compte partagé (rôle
-- CAISSIER). Avant de pointer, le caissier touche son nom et tape son code à
-- 4 chiffres : chaque action est alors enregistrée à SON nom.
--
--  1. staff_pins : le code tablette de chaque membre (haché bcrypt), illisible
--     depuis l'API (aucune policy) ; 5 erreurs → bloqué 5 minutes.
--  2. tablet_actor_sessions : jeton remis après un code juste. La tablette
--     l'envoie dans l'en-tête HTTP « x-actor-token » de chaque requête.
--  3. current_actor_id() : la personne derrière la requête — celle du jeton
--     (même compte appareil, non expiré), sinon le compte connecté.
--  4. RPC : tablet_staff, set_staff_pin, clear_staff_pin, tablet_identify,
--     tablet_release.
--  5. Qui a pointé : order_lines.pointed_by/pointed_at (réception, partiel,
--     reliquat, non reçu), handed_by/handed_at (remis au client),
--     orders.dispatched_by/dispatched_at (confié au livreur) ; delivered_by
--     prend aussi la personne de la tablette. Rempli par triggers, donc pareil
--     depuis les ordinateurs du comptoir (le compte connecté).
--  6. audit_row : le journal note la personne (current_actor_id) au lieu du
--     compte de la tablette. Corps repris de la définition EN BASE
--     (pg_get_functiondef du 2026-10-05), seule la ligne de l'acteur change.

-- ---------------------------------------------------------------------
-- 1. Codes tablette
-- ---------------------------------------------------------------------
create table if not exists public.staff_pins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pin_hash text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.staff_pins enable row level security;
revoke all on table public.staff_pins from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Jetons « qui pointe » de la tablette
-- ---------------------------------------------------------------------
create table if not exists public.tablet_actor_sessions (
  token uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  device_user_id uuid not null references auth.users(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists tablet_actor_sessions_expiry_idx on public.tablet_actor_sessions (expires_at);
alter table public.tablet_actor_sessions enable row level security;
revoke all on table public.tablet_actor_sessions from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. La personne derrière la requête
-- ---------------------------------------------------------------------
create or replace function public.current_actor_id()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_headers text := nullif(current_setting('request.headers', true), '');
  v_raw text;
  v_actor uuid;
begin
  if v_headers is not null then
    begin
      v_raw := (v_headers::json) ->> 'x-actor-token';
    exception when others then
      v_raw := null;
    end;
    if v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select s.actor_id into v_actor
      from public.tablet_actor_sessions s
      where s.token = v_raw::uuid
        and s.device_user_id = auth.uid()
        and s.expires_at > now();
    end if;
  end if;
  return coalesce(v_actor, auth.uid());
end;
$$;
revoke execute on function public.current_actor_id() from public, anon;
grant execute on function public.current_actor_id() to authenticated;

-- ---------------------------------------------------------------------
-- 4. RPC de la tablette et de l'administration
-- ---------------------------------------------------------------------

-- Everyone of the magasin (garagistes excepted): names for « pointé par », and
-- the staff who can be chosen on the tablet (ADMIN / CAISSIER with a code).
create or replace function public.tablet_staff()
returns table (user_id uuid, name text, role text, has_pin boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.user_id,
         coalesce(nullif(trim(p.display_name), ''), 'Sans nom'),
         p.role::text,
         exists (select 1 from public.staff_pins sp where sp.user_id = p.user_id)
  from public.profiles p
  where p.organization_id = public.current_user_org_id()
    and p.client_id is null
    and public.is_counter_staff()
  order by 2;
$$;
revoke execute on function public.tablet_staff() from public, anon;
grant execute on function public.tablet_staff() to authenticated;

-- An admin sets anyone's code; a member may set their own.
create or replace function public.set_staff_pin(p_user_id uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  perform public.assert_counter_staff();
  if p_user_id is distinct from auth.uid() and public.current_user_role() is distinct from 'ADMIN'::public.user_role then
    raise exception 'Seul un administrateur peut définir le code d''un autre membre.';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.user_id = p_user_id and p.organization_id = v_org and p.client_id is null and p.livreur_id is null
      and p.role in ('ADMIN'::public.user_role, 'CAISSIER'::public.user_role)
  ) then
    raise exception 'Membre introuvable dans ce magasin.';
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then
    raise exception 'Le code doit faire exactement 4 chiffres.';
  end if;
  insert into public.staff_pins (user_id, pin_hash, failed_attempts, locked_until, updated_at, updated_by)
  values (p_user_id, extensions.crypt(p_pin, extensions.gen_salt('bf')), 0, null, now(), auth.uid())
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash, failed_attempts = 0, locked_until = null,
        updated_at = now(), updated_by = auth.uid();
end;
$$;
revoke execute on function public.set_staff_pin(uuid, text) from public, anon;
grant execute on function public.set_staff_pin(uuid, text) to authenticated;

create or replace function public.clear_staff_pin(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_counter_staff();
  if p_user_id is distinct from auth.uid() and public.current_user_role() is distinct from 'ADMIN'::public.user_role then
    raise exception 'Seul un administrateur peut retirer le code d''un autre membre.';
  end if;
  if not exists (
    select 1 from public.profiles p where p.user_id = p_user_id and p.organization_id = public.current_user_org_id()
  ) then
    raise exception 'Membre introuvable dans ce magasin.';
  end if;
  delete from public.staff_pins where user_id = p_user_id;
  delete from public.tablet_actor_sessions where actor_id = p_user_id;
end;
$$;
revoke execute on function public.clear_staff_pin(uuid) from public, anon;
grant execute on function public.clear_staff_pin(uuid) to authenticated;

-- Name + code on the tablet → a token for the requests that follow. A wrong
-- code is answered (not raised: the attempt counter must be saved).
create or replace function public.tablet_identify(p_user_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_name text;
  v_pin public.staff_pins;
  v_token uuid;
  v_left integer;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  select coalesce(nullif(trim(p.display_name), ''), 'Sans nom') into v_name
  from public.profiles p
  where p.user_id = p_user_id and p.organization_id = v_org and p.client_id is null and p.livreur_id is null
    and p.role in ('ADMIN'::public.user_role, 'CAISSIER'::public.user_role);
  if not found then
    raise exception 'Membre introuvable dans ce magasin.';
  end if;

  select * into v_pin from public.staff_pins where user_id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Pas de code tablette pour ce membre : à définir dans Admin → Équipe.');
  end if;
  if v_pin.locked_until is not null and v_pin.locked_until > now() then
    return jsonb_build_object('ok', false, 'error',
      format('Trop d''essais : réessayez dans %s min.', greatest(1, ceil(extract(epoch from v_pin.locked_until - now()) / 60)::integer)));
  end if;

  if extensions.crypt(coalesce(p_pin, ''), v_pin.pin_hash) <> v_pin.pin_hash then
    v_left := 4 - v_pin.failed_attempts;
    update public.staff_pins
    set failed_attempts = case when v_left <= 0 then 0 else failed_attempts + 1 end,
        locked_until = case when v_left <= 0 then now() + interval '5 minutes' else null end
    where user_id = p_user_id;
    return jsonb_build_object('ok', false, 'error',
      case when v_left <= 0 then 'Code incorrect. Trop d''essais : bloqué 5 minutes.'
           else format('Code incorrect (%s essai%s restant%s).', v_left, case when v_left > 1 then 's' else '' end, case when v_left > 1 then 's' else '' end) end);
  end if;

  update public.staff_pins set failed_attempts = 0, locked_until = null where user_id = p_user_id;
  delete from public.tablet_actor_sessions where expires_at < now() - interval '1 day';
  insert into public.tablet_actor_sessions (organization_id, device_user_id, actor_id, expires_at)
  values (v_org, auth.uid(), p_user_id, now() + interval '8 hours')
  returning token into v_token;
  return jsonb_build_object('ok', true, 'token', v_token, 'user_id', p_user_id, 'name', v_name);
end;
$$;
revoke execute on function public.tablet_identify(uuid, text) from public, anon;
grant execute on function public.tablet_identify(uuid, text) to authenticated;

create or replace function public.tablet_release(p_token uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.tablet_actor_sessions where token = p_token and device_user_id = auth.uid();
$$;
revoke execute on function public.tablet_release(uuid) from public, anon;
grant execute on function public.tablet_release(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Qui a pointé / remis / confié au livreur
-- ---------------------------------------------------------------------
alter table public.order_lines
  add column if not exists pointed_by uuid references auth.users(id) on delete set null,
  add column if not exists pointed_at timestamptz,
  add column if not exists handed_by uuid references auth.users(id) on delete set null,
  add column if not exists handed_at timestamptz;
alter table public.orders
  add column if not exists dispatched_by uuid references auth.users(id) on delete set null,
  add column if not exists dispatched_at timestamptz;

create or replace function public.order_lines_track_actor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reception_status is distinct from old.reception_status or new.qte_recue is distinct from old.qte_recue then
    new.pointed_by := public.current_actor_id();
    new.pointed_at := now();
  end if;
  if new.qte_remise is distinct from old.qte_remise then
    new.handed_by := public.current_actor_id();
    new.handed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists order_lines_track_actor on public.order_lines;
create trigger order_lines_track_actor
  before update of reception_status, qte_recue, qte_remise on public.order_lines
  for each row execute function public.order_lines_track_actor();

create or replace function public.orders_track_actor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_actor_id();
begin
  if new.livreur_id is not null and new.livreur_id is distinct from old.livreur_id then
    new.dispatched_by := v_actor;
    new.dispatched_at := now();
  end if;
  -- delivered_by is written by the delivery RPCs (auth.uid()); from the tablet it is the person.
  if new.workflow_status::text = 'DELIVERED' and old.workflow_status::text is distinct from 'DELIVERED'
     and v_actor is distinct from auth.uid() then
    new.delivered_by := v_actor;
  end if;
  return new;
end;
$$;
drop trigger if exists orders_track_actor on public.orders;
create trigger orders_track_actor
  before update of livreur_id, workflow_status on public.orders
  for each row execute function public.orders_track_actor();

-- ---------------------------------------------------------------------
-- 6. Journal : la personne, pas le compte de la tablette
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_before jsonb;
  v_after jsonb;
  v_diff jsonb;
  v_org uuid;
  v_id text;
begin
  if tg_op = 'INSERT' then
    v_after := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old);
    v_after := to_jsonb(new);
    select jsonb_object_agg(a.key, a.value) into v_diff
    from jsonb_each(v_after) a
    where a.key not in ('updated_at', 'updatedAt')
      and v_before -> a.key is distinct from a.value;
    if v_diff is null then
      return null;
    end if;
    -- keep only the changed keys on both sides
    select jsonb_object_agg(b.key, b.value) into v_before
    from jsonb_each(v_before) b where v_diff ? b.key;
    v_after := v_diff;
  else
    v_before := to_jsonb(old);
  end if;

  begin
    v_org := coalesce(v_after->>'organization_id', v_before->>'organization_id')::uuid;
  exception when others then
    v_org := null;
  end;
  v_id := coalesce(v_after->>'id', v_before->>'id', v_after->>'user_id', v_before->>'user_id');

  -- 20261005 : the person behind the tablet (x-actor-token), else the signed-in account.
  insert into public.audit_log (organization_id, actor_id, action, entity, entity_id, before, after)
  values (v_org, public.current_actor_id(), tg_op, tg_table_name, v_id, v_before, v_after);
  return null;
end;
$function$;
revoke execute on function public.audit_row() from public, anon, authenticated;

notify pgrst, 'reload schema';
