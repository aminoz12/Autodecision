-- Espace livreur (analyse 2026-09-14).
--
--  1. Désactiver un livreur coupe son accès : current_user_livreur_id() ne
--     renvoie plus rien quand livreurs.active = false (RLS, RPC, photos,
--     notifications).
--  2. Le livreur ne lit plus orders / order_lines / clients en direct : il
--     voyait tout son historique, les prix d'achat et la fiche client
--     complète. livreur_tour() renvoie seulement ce que l'écran affiche —
--     livraisons en cours + livrées / non livrées aujourd'hui.
--  3. mark_order_delivered vérifie l'état : jamais une commande déjà livrée,
--     annulée ou un devis ; un livreur ne livre qu'une commande en cours de
--     livraison ; la photo est rangée sous <org>/<commande>-….
--  4. Un seul compte de connexion par livreur.
--  5. Bucket `pod` : dépôt réservé au comptoir et au livreur de la commande
--     en cours de livraison.

-- ---------------------------------------------------------------------
-- 1. Livreur désactivé = plus d'accès
-- ---------------------------------------------------------------------
create or replace function public.current_user_livreur_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.livreur_id
  from public.profiles p
  join public.livreurs l on l.id = p.livreur_id and l.active
  where p.user_id = auth.uid()
  limit 1;
$$;

-- ---------------------------------------------------------------------
-- 4. Un seul compte par livreur
-- ---------------------------------------------------------------------
create unique index if not exists profiles_livreur_id_unique
  on public.profiles (livreur_id)
  where livreur_id is not null;

-- ---------------------------------------------------------------------
-- 2. Lectures directes : comptoir et garagiste seulement
-- ---------------------------------------------------------------------
alter policy orders_select on public.orders using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (
    public.is_counter_staff()
    or client_id = public.current_user_client_id()
  )
);

alter policy order_lines_select on public.order_lines using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and public.is_counter_staff()
);

alter policy clients_select on public.clients using (
  organization_id = public.current_user_org_id()
  and public.has_operational_access(organization_id)
  and (
    public.is_counter_staff()
    or id = public.current_user_client_id()
  )
);

alter policy notifications_select on public.notifications using (
  organization_id = public.current_user_org_id()
  and (
    (audience = 'STAFF' and public.is_counter_staff())
    or (audience = 'CLIENT' and client_id is not null and client_id = public.current_user_client_id())
    or (audience = 'LIVREUR' and user_id = auth.uid() and public.current_user_livreur_id() is not null)
  )
);

-- La tournée du livreur connecté : uniquement les champs affichés.
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
        case o.workflow_status when 'IN_TRANSIT' then o.date_envoi when 'DELIVERED' then o.delivered_at else o.delivery_failed_at end as at,
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
      from public.orders o
      left join public.clients c on c.id = o.client_id
      where o.organization_id = v_org
        and o.livreur_id = v_livreur
        and coalesce(o.devis, false) = false
        and o.cancelled_at is null
        and (
          o.workflow_status = 'IN_TRANSIT'
          or (o.workflow_status = 'DELIVERED' and o.delivered_at >= v_today)
          or (o.workflow_status not in ('IN_TRANSIT', 'DELIVERED') and o.delivery_failed_at >= v_today)
        )
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.livreur_tour() from public, anon;
grant execute on function public.livreur_tour() to authenticated;

-- ---------------------------------------------------------------------
-- 3. Livraison : état vérifié, photo dans le dossier de la commande
-- ---------------------------------------------------------------------
create or replace function public.mark_order_delivered(
  p_order_id uuid,
  p_recipient text default null,
  p_note text default null,
  p_pod_path text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_order public.orders;
  v_pod text := nullif(trim(coalesce(p_pod_path, '')), '');
begin
  if v_org is null or (v_livreur is null and not public.is_counter_staff()) then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);

  select * into v_order
  from public.orders
  where id = p_order_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Order not found.';
  end if;
  if v_livreur is not null and v_order.livreur_id is distinct from v_livreur then
    raise exception 'This delivery is assigned to another livreur.';
  end if;
  if v_order.workflow_status = 'DELIVERED' then
    raise exception 'This order has already been delivered.';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'This order has been cancelled.';
  end if;
  if coalesce(v_order.devis, false) then
    raise exception 'A quote cannot be delivered.';
  end if;
  if v_livreur is not null and v_order.workflow_status <> 'IN_TRANSIT' then
    raise exception 'Only a delivery in progress can be marked delivered.';
  end if;
  if v_pod is not null and (
    v_pod not like (v_org::text || '/' || v_order.id::text || '-%')
    or position('..' in v_pod) > 0
    or position('/' in substr(v_pod, length(v_org::text) + 2)) > 0
  ) then
    raise exception 'Proof of delivery must be stored in the order folder.';
  end if;

  update public.orders
  set workflow_status = 'DELIVERED'::public.orders_workflow_status_enum,
      statut_livreur = 'LIVRÉ'::public.orders_statut_livreur_enum,
      delivered_at = now(),
      delivered_by = auth.uid(),
      delivery_recipient = nullif(trim(coalesce(p_recipient, '')), ''),
      delivery_note = nullif(trim(coalesce(p_note, '')), ''),
      pod_path = coalesce(v_pod, pod_path),
      delivery_attempts = delivery_attempts + 1,
      updated_at = now()
  where id = v_order.id;

  update public.delivery_tasks
  set workflow_status = 'DELIVERED'::public.delivery_tasks_workflow_status_enum,
      updated_at = now()
  where order_id = v_order.id;
end;
$$;
revoke execute on function public.mark_order_delivered(uuid, text, text, text) from public, anon;
grant execute on function public.mark_order_delivered(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Photos de livraison
-- ---------------------------------------------------------------------
create or replace function public.can_upload_proof(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((storage.foldername(p_name))[1] = public.current_user_org_id()::text, false)
    and (
      public.is_counter_staff()
      or exists (
        select 1 from public.orders o
        where o.organization_id = public.current_user_org_id()
          and o.livreur_id = public.current_user_livreur_id()
          and o.workflow_status = 'IN_TRANSIT'
          and storage.filename(p_name) like (o.id::text || '-%')
      )
    );
$$;
revoke execute on function public.can_upload_proof(text) from public, anon;
grant execute on function public.can_upload_proof(text) to authenticated;

drop policy if exists pod_insert on storage.objects;
create policy pod_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'pod' and public.can_upload_proof(name));

drop policy if exists pod_select on storage.objects;
create policy pod_select on storage.objects for select to authenticated
  using (
    bucket_id = 'pod'
    and (storage.foldername(name))[1] = public.current_user_org_id()::text
    and (
      public.is_counter_staff()
      or (owner = auth.uid() and public.current_user_livreur_id() is not null)
    )
  );

notify pgrst, 'reload schema';
