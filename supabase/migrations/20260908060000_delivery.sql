-- Livraison (audit 2026-09-07, chantier 9).
--
--  * orders: horodatage réel de livraison (delivered_at / delivered_by),
--    preuve de livraison (nom du réceptionnaire, note, photo dans le bucket
--    Storage `pod`), échec de livraison (motif, date, nombre de tentatives).
--  * mark_order_delivered accepte la preuve ; report_delivery_failure remet
--    la commande « à livrer » et prévient le comptoir.
--  * Bucket Storage `pod` (privé) : un livreur dépose dans le dossier de son
--    organisation ; le comptoir lit tout le dossier.

alter table public.orders
  add column if not exists delivered_at timestamptz,
  add column if not exists delivered_by uuid references auth.users (id) on delete set null,
  add column if not exists delivery_recipient text,
  add column if not exists delivery_note text,
  add column if not exists pod_path text,
  add column if not exists delivery_failed_reason text,
  add column if not exists delivery_failed_at timestamptz,
  add column if not exists delivery_attempts integer not null default 0;

drop function if exists public.mark_order_delivered(uuid);
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
  if p_pod_path is not null and split_part(p_pod_path, '/', 1) <> v_org::text then
    raise exception 'Proof of delivery must be stored in the organization folder.';
  end if;

  update public.orders
  set workflow_status = 'DELIVERED'::public.orders_workflow_status_enum,
      statut_livreur = 'LIVRÉ'::public.orders_statut_livreur_enum,
      delivered_at = now(),
      delivered_by = auth.uid(),
      delivery_recipient = nullif(trim(coalesce(p_recipient, '')), ''),
      delivery_note = nullif(trim(coalesce(p_note, '')), ''),
      pod_path = coalesce(nullif(trim(coalesce(p_pod_path, '')), ''), pod_path),
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

create or replace function public.report_delivery_failure(p_order_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_livreur uuid := public.current_user_livreur_id();
  v_order public.orders;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if v_org is null or (v_livreur is null and not public.is_counter_staff()) then
    raise exception 'Staff access is required.';
  end if;
  perform public.assert_operational_access(v_org);
  if v_reason is null then
    raise exception 'A reason is required.';
  end if;

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
  if v_order.workflow_status <> 'IN_TRANSIT' then
    raise exception 'Only a delivery in progress can fail.';
  end if;

  update public.orders
  set workflow_status = 'TO_COLLECT'::public.orders_workflow_status_enum,
      statut_livreur = 'EN_ATTENTE'::public.orders_statut_livreur_enum,
      delivery_failed_reason = v_reason,
      delivery_failed_at = now(),
      delivery_attempts = delivery_attempts + 1,
      updated_at = now()
  where id = v_order.id;

  update public.delivery_tasks
  set workflow_status = 'TO_COLLECT'::public.delivery_tasks_workflow_status_enum,
      updated_at = now()
  where order_id = v_order.id;

  perform public.notify(v_org, 'STAFF', 'DELIVERY_FAILED',
    format('Livraison %s non effectuée', v_order.ref_demande),
    format('%s — %s. La commande est revenue dans « Commande à livrer ».', public.client_name(v_order.client_id), v_reason),
    '/dashboard/commandes?tab=alivrer', 'orders', v_order.id);
end;
$$;
revoke execute on function public.report_delivery_failure(uuid, text) from public, anon;
grant execute on function public.report_delivery_failure(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Storage bucket for proofs of delivery
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pod', 'pod', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists pod_insert on storage.objects;
create policy pod_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'pod'
    and (storage.foldername(name))[1] = public.current_user_org_id()::text
  );
drop policy if exists pod_select on storage.objects;
create policy pod_select on storage.objects for select to authenticated
  using (
    bucket_id = 'pod'
    and (storage.foldername(name))[1] = public.current_user_org_id()::text
    and (public.is_counter_staff() or owner = auth.uid())
  );

notify pgrst, 'reload schema';
