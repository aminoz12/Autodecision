-- Commande retirée au comptoir (2026-10-07).
--
-- Une commande dont toutes les pièces ont été remises au client au comptoir
-- restait « En préparation » (TO_COLLECT) pour toujours : seul un livreur
-- faisait passer une commande à « Livrée ». picked_up_at était pourtant bien
-- posé (sav_refresh_order_pickup) ; le statut ne suivait pas. Sur le magasin
-- en production : 33 commandes entièrement remises, toutes encore « En
-- préparation ».
--
--  1. sav_refresh_order_pickup : quand la dernière pièce est remise, la
--     commande passe DELIVERED (delivered_at = maintenant) si elle n'était
--     pas déjà en livraison / livrée. Sans livreur, l'application affiche
--     « Retirée au comptoir ».
--  2. Lignes créées déjà remises (« Client a pris » à la création) : un
--     trigger différé à la fin de la transaction refait ce calcul une fois
--     toutes les lignes insérées (avant : rien ne se passait à la création).
--  3. orders_notify : au garage, « retirée au comptoir » plutôt que « livrée »
--     quand aucun livreur n'est en jeu.
--  4. Reprise des commandes déjà entièrement remises (sans notifier).
--
-- Corps de sav_refresh_order_pickup et orders_notify repris de la définition
-- EN BASE (pg_get_functiondef du 2026-10-07), modifiés aux endroits « 20261007 ».

-- ---------------------------------------------------------------------
-- 1. Dernière pièce remise → commande terminée
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sav_refresh_order_pickup(p_order_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if exists (select 1 from public.order_lines l where l.order_id = p_order_id and l.reception_status <> 'NOT_RECEIVED')
     and not exists (
       select 1 from public.order_lines l
       where l.order_id = p_order_id and l.reception_status <> 'NOT_RECEIVED' and l.qte_remise < l.quantity
     ) then
    -- 20261007 : everything handed over at the counter → the order is done (« Retirée au comptoir »
    -- when no livreur was involved). An order already out with a livreur keeps its course.
    update public.orders o
    set picked_up_at = coalesce(o.picked_up_at, now()),
        workflow_status = case when o.workflow_status in ('PENDING', 'TO_COLLECT') then 'DELIVERED'::public.orders_workflow_status_enum
                               else o.workflow_status end,
        delivered_at = case when o.workflow_status in ('PENDING', 'TO_COLLECT') then coalesce(o.delivered_at, now()) else o.delivered_at end
    where o.id = p_order_id and o.devis = false and o.is_restock = false and o.cancelled_at is null
      and (o.picked_up_at is null or o.workflow_status in ('PENDING', 'TO_COLLECT'));
  end if;
end;
$function$;
revoke execute on function public.sav_refresh_order_pickup(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Notification au garage : « retirée au comptoir » sans livreur
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.orders_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- 20261007 : picked up at the counter (no livreur) reads as such.
      perform public.notify(new.organization_id, 'CLIENT', 'ORDER_DELIVERED',
        format('Commande %s %s', new.ref_demande, case when new.livreur_id is null then 'retirée au comptoir' else 'livrée' end),
        case when new.livreur_id is null then 'Vos pièces ont été retirées au magasin.' else 'Vos pièces ont été livrées.' end,
        '/garagiste/dashboard/commandes', 'orders', new.id, new.client_id);
    end if;
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------
-- 2. Lignes remises dès la création : recalcul à la fin de la transaction
-- ---------------------------------------------------------------------
create or replace function public.order_lines_pickup_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.qte_remise >= new.quantity then
    perform public.sav_refresh_order_pickup(new.order_id);
  end if;
  return null;
end;
$$;
revoke execute on function public.order_lines_pickup_on_insert() from public, anon, authenticated;
drop trigger if exists order_lines_pickup_on_insert on public.order_lines;
-- Deferred: fires at commit, once every line of the order is in.
create constraint trigger order_lines_pickup_on_insert
  after insert on public.order_lines
  deferrable initially deferred
  for each row execute function public.order_lines_pickup_on_insert();

-- ---------------------------------------------------------------------
-- 4. Reprise : commandes déjà entièrement remises au comptoir
-- ---------------------------------------------------------------------
alter table public.orders disable trigger orders_notify;
update public.orders o
set workflow_status = 'DELIVERED'::public.orders_workflow_status_enum,
    delivered_at = coalesce(o.delivered_at, o.picked_up_at, now()),
    picked_up_at = coalesce(o.picked_up_at, now())
where o.devis = false and o.is_restock = false and o.cancelled_at is null
  and o.workflow_status in ('PENDING', 'TO_COLLECT')
  and o.livreur_id is null
  and exists (select 1 from public.order_lines l where l.order_id = o.id and l.reception_status <> 'NOT_RECEIVED')
  and not exists (
    select 1 from public.order_lines l
    where l.order_id = o.id and l.reception_status <> 'NOT_RECEIVED' and l.qte_remise < l.quantity
  );
alter table public.orders enable trigger orders_notify;

notify pgrst, 'reload schema';
