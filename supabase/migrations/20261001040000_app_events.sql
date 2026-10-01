-- Journal technique (2026-10-01) : les erreurs de l'application, vues par le
-- propriétaire du SaaS dans /superadmin/journal.
--
-- Le navigateur signale chaque erreur (plantage d'une page, appel refusé par la
-- base, route /api en échec, réseau) par log_app_event(). La fonction retrouve
-- elle-même l'utilisateur, son rôle et son magasin : le client n'envoie que
-- l'erreur. La table n'est lisible que par le rôle de service (console
-- propriétaire) ; personne ne peut la lire ni l'écrire directement.

create table if not exists public.app_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  level text not null default 'error' check (level in ('error', 'warn', 'info')),
  -- render | client | promise | db | schema | rule | auth | api | network
  source text not null default 'client',
  message text not null,
  stack text,
  url text,
  context jsonb,
  -- Same error = same fingerprint (numbers and ids stripped from the message).
  fingerprint text not null,
  organization_id uuid references public.organizations (id) on delete set null,
  user_id uuid,
  user_email text,
  user_role text,
  user_agent text,
  app_version text
);
create index if not exists app_events_created_idx on public.app_events (created_at desc);
create index if not exists app_events_org_idx on public.app_events (organization_id, created_at desc);
create index if not exists app_events_fingerprint_idx on public.app_events (fingerprint, created_at desc);
create index if not exists app_events_user_idx on public.app_events (user_id, created_at desc);

alter table public.app_events enable row level security;
revoke all on public.app_events from public, anon, authenticated;

create or replace function public.log_app_event(
  p_level text,
  p_source text,
  p_message text,
  p_stack text default null,
  p_url text default null,
  p_context jsonb default null,
  p_user_agent text default null,
  p_app_version text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_email text;
  v_message text := left(coalesce(nullif(trim(p_message), ''), '(sans message)'), 2000);
  v_source text := left(coalesce(nullif(trim(p_source), ''), 'client'), 40);
  v_level text := case when p_level in ('error', 'warn', 'info') then p_level else 'error' end;
  v_recent integer;
begin
  -- Garde-fou : une page en boucle ne remplit pas la table.
  select count(*) into v_recent
  from public.app_events e
  where e.created_at > now() - interval '1 minute' and e.user_id is not distinct from v_uid;
  if v_recent >= 60 then
    return;
  end if;
  select count(*) into v_recent from public.app_events e where e.created_at > now() - interval '1 minute';
  if v_recent >= 600 then
    return;
  end if;

  if v_uid is not null then
    select p.organization_id,
           case when p.client_id is not null then 'GARAGE'
                when p.livreur_id is not null then 'LIVREUR'
                else p.role::text end
    into v_org, v_role
    from public.profiles p
    where p.user_id = v_uid;
    select u.email into v_email from auth.users u where u.id = v_uid;
  end if;

  insert into public.app_events (
    level, source, message, stack, url, context, fingerprint,
    organization_id, user_id, user_email, user_role, user_agent, app_version
  ) values (
    v_level, v_source, v_message,
    left(p_stack, 8000),
    left(p_url, 500),
    case when p_context is null or pg_column_size(p_context) <= 8000 then p_context
         else jsonb_build_object('truncated', true) end,
    md5(v_source || ':' || regexp_replace(
      left(v_message, 300),
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]+', '#', 'gi')),
    v_org, v_uid, v_email, v_role,
    left(p_user_agent, 300),
    left(p_app_version, 40)
  );

  -- Rétention : 90 jours, nettoyés de temps en temps.
  if random() < 0.02 then
    delete from public.app_events where created_at < now() - interval '90 days';
  end if;
end;
$$;
revoke execute on function public.log_app_event(text, text, text, text, text, jsonb, text, text) from public;
grant execute on function public.log_app_event(text, text, text, text, text, jsonb, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
