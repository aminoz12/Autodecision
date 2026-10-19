-- Livraisons garage dans l'espace livreur (2026-10-19, user : « livraison
-- garage also should appear in livreur space »).
--
--  1. livreur_tour() renvoie aussi les commandes GARAGE prêtes au comptoir
--     (toutes les pièces reçues, pas encore parties, sans livreur ou déjà
--     à moi, commandées dans les 30 derniers jours) avec le drapeau `ready` :
--     le livreur les voit avant même que le
--     comptoir les lui confie.
--  2. livreur_take_order(p_order_id) : le livreur prend une de ces
--     livraisons — mêmes effets que dispatch_order_to_livreur (en cours de
--     livraison, tâche de livraison), réservé aux commandes garage complètes
--     libres ou déjà à lui ; le comptoir est prévenu.
-- Le livreur ne lit toujours aucune table directement.

create or replace function public.livreur_tour()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_linked uuid;
  v_livreur uuid := public.current_user_livreur_id();
  v_today timestamptz := date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris';
begin
  select p.livreur_id into v_linked from public.profiles p where p.user_id = auth.uid();
  if v_org is null or v_linked is null then
    raise exception 'Livreur access is required.';
  end if;
  if v_livreur is null then
    raise exception 'Livreur access is disabled.';
  end if;
  perform public.assert_operational_access(v_org);

  return coalesce((
    select jsonb_agg(t.stop order by t.grp, t.at nulls last, t.ref)
    from (
      select
        case o.workflow_status when 'IN_TRANSIT' then 0 when 'DELIVERED' then 2 else 1 end as grp,
        case o.workflow_status when 'IN_TRANSIT' then o.date_envoi when 'DELIVERED' then o.delivered_at else coalesce(o.delivery_failed_at, o.updated_at) end as at,
        o.ref_demande as ref,
        jsonb_build_object(
          'id', o.id,
          'ref', o.ref_demande,
          'workflow', o.workflow_status,
          'date_envoi', o.date_envoi,
          'delivered_at', o.delivered_at,
          'failed_at', o.delivery_failed_at,
          'failed_reason', o.delivery_failed_reason,
          'attempts', o.delivery_attempts,
          'note', o.consigne,
          'client_name', coalesce(c.name, nullif(o.client_phone, '-'), 'Client'),
          'client_phone', coalesce(nullif(trim(c.phone), ''), nullif(o.client_phone, '-')),
          'address', c.address,
          'city', c.city,
          'is_garage', coalesce(c.is_garage, false),
          'livreur_id', o.livreur_id,
          -- Prête au comptoir : garage, toutes les pièces reçues, pas encore partie.
          'ready', (
            coalesce(c.is_garage, false)
            and o.workflow_status not in ('IN_TRANSIT', 'DELIVERED')
            and o.date_commande >= current_date - 30
            and o.ready_for_delivery
          ),
          'pieces', coalesce((
            select jsonb_agg(jsonb_build_object(
              'name', l.nom_produit,
              'reference', l.reference,
              'quantity', l.quantity,
              'pending', (not coalesce(l.depuis_magasin, false))
                and l.reception_status::text in ('PENDING', 'BACKORDER', 'PARTIAL')
            ) order by l.nom_produit)
            from public.order_lines l
            where l.order_id = o.id
              and l.reception_status::text is distinct from 'NOT_RECEIVED'
          ), '[]'::jsonb)
        ) as stop
      from (
        select o.*,
          (
            not exists (
              select 1 from public.order_lines l
              where l.order_id = o.id and l.reception_status::text in ('PENDING', 'BACKORDER', 'PARTIAL')
            )
            and exists (
              select 1 from public.order_lines l
              where l.order_id = o.id and l.reception_status::text = 'RECEIVED'
            )
          ) as ready_for_delivery
        from public.orders o
        where o.organization_id = v_org
          and coalesce(o.devis, false) = false
          and o.cancelled_at is null
      ) o
      left join public.clients c on c.id = o.client_id
      where (
          o.livreur_id = v_livreur
          and (
            o.workflow_status = 'IN_TRANSIT'
            or (o.workflow_status = 'DELIVERED' and o.delivered_at >= v_today)
            or (o.workflow_status not in ('IN_TRANSIT', 'DELIVERED') and o.delivery_failed_at >= v_today)
          )
        )
        or (
          coalesce(c.is_garage, false)
          and coalesce(o.is_restock, false) = false
          and o.workflow_status not in ('IN_TRANSIT', 'DELIVERED')
          and (o.livreur_id is null or o.livreur_id = v_livreur)
          and o.date_commande >= current_date - 30
          and o.ready_for_delivery
        )
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.livreur_tour() from public, anon;
grant execute on function public.livreur_tour() to authenticated;

create or replace function public.livreur_take_order(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_linked uuid;
  v_livreur uuid := public.current_user_livreur_id();
  v_order public.orders;
  v_garage boolean;
  v_name text;
begin
  select p.livreur_id into v_linked from public.profiles p where p.user_id = auth.uid();
  if v_org is null or v_linked is null then
    raise exception 'Livreur access is required.';
  end if;
  if v_livreur is null then
    raise exception 'Livreur access is disabled.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org and coalesce(devis, false) = false
  for update;
  if not found then
    raise exception 'Commande introuvable.';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'Cette commande est annulée.';
  end if;
  if v_order.workflow_status = 'DELIVERED'::public.orders_workflow_status_enum then
    raise exception 'Cette commande est déjà livrée.';
  end if;
  if v_order.workflow_status = 'IN_TRANSIT'::public.orders_workflow_status_enum then
    if v_order.livreur_id = v_livreur then
      return; -- already mine, nothing to change
    end if;
    raise exception 'Cette commande est déjà en livraison avec un autre livreur.';
  end if;
  if v_order.livreur_id is not null and v_order.livreur_id <> v_livreur then
    raise exception 'Cette commande est confiée à un autre livreur.';
  end if;
  select coalesce(c.is_garage, false) into v_garage from public.clients c where c.id = v_order.client_id;
  if not coalesce(v_garage, false) or coalesce(v_order.is_restock, false) then
    raise exception 'Seules les commandes garage prêtes peuvent être prises.';
  end if;
  if exists (
    select 1 from public.order_lines l
    where l.order_id = v_order.id and l.reception_status::text in ('PENDING', 'BACKORDER', 'PARTIAL')
  ) or not exists (
    select 1 from public.order_lines l
    where l.order_id = v_order.id and l.reception_status::text = 'RECEIVED'
  ) then
    raise exception 'Des pièces de cette commande ne sont pas encore reçues.';
  end if;

  update public.orders
  set livreur_id = v_livreur,
      envoyer_au_livreur = true,
      workflow_status = 'IN_TRANSIT'::public.orders_workflow_status_enum,
      statut_livreur = 'EN_COURS'::public.orders_statut_livreur_enum,
      date_envoi = coalesce(date_envoi, now()),
      updated_at = now()
  where id = v_order.id;

  if exists (select 1 from public.delivery_tasks t where t.order_id = v_order.id) then
    update public.delivery_tasks
    set livreur_id = v_livreur,
        workflow_status = 'IN_TRANSIT'::public.delivery_tasks_workflow_status_enum,
        updated_at = now()
    where order_id = v_order.id;
  else
    insert into public.delivery_tasks (organization_id, order_id, workflow_status, livreur_id)
    values (v_org, v_order.id, 'IN_TRANSIT'::public.delivery_tasks_workflow_status_enum, v_livreur);
  end if;

  select lv.name into v_name from public.livreurs lv where lv.id = v_livreur;
  perform public.notify(
    v_org, 'STAFF', 'ORDER_TAKEN_BY_LIVREUR',
    v_order.ref_demande || ' prise par ' || coalesce(v_name, 'le livreur'),
    'Livraison garage prise en charge depuis l''espace livreur : ' || public.client_name(v_order.client_id) || '.',
    '/dashboard/commandes/' || v_order.id::text, 'order', v_order.id, null, null,
    'livreur-take:' || v_order.id::text || ':' || to_char(now(), 'YYYYMMDDHH24MI')
  );
end;
$$;
revoke execute on function public.livreur_take_order(uuid) from public, anon;
grant execute on function public.livreur_take_order(uuid) to authenticated;

notify pgrst, 'reload schema';
