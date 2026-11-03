-- Changer le destinataire d'une commande (2026-11-03).
--
-- Cas vécu : une pièce commandée « pour le stock » est finalement pour un
-- garage (le livreur l'apprend en tournée) — ou l'inverse, ou une commande
-- saisie sur le mauvais client. Jusqu'ici il fallait annuler et ressaisir.
--
-- reassign_order(p_order_id, p_client_id, p_livreur_id) : comptoir seulement.
--  * p_client_id null → la commande devient un réapprovisionnement du stock
--    (aucun client, montant 0, rien à encaisser, pas de livraison).
--  * p_client_id = un garage / client PRO / particulier → la commande lui est
--    rattachée ; le montant est recalculé à partir des prix de vente des
--    lignes (remise en pied conservée) ; un garage passe « en compte » avec
--    son échéance et part en livraison (p_livreur_id : envoi immédiat).
-- Refusé : devis, commande annulée ou livrée, facture émise, encaissement
-- déjà enregistré (annulez-le d'abord), et — dès que le stock est concerné —
-- une ligne déjà reçue ou remise (le stock ne serait plus juste).

create or replace function public.reassign_order(
  p_order_id uuid,
  p_client_id uuid default null,
  p_livreur_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_order public.orders;
  v_client public.clients;
  v_kind text;               -- STOCK / GARAGE / PRO / PARTICULIER
  v_old_kind text;
  v_parts numeric := 0;
  v_total numeric := 0;
  v_discount numeric;
  v_touched int;
  v_mode text;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);

  select * into v_order from public.orders
  where id = p_order_id and organization_id = v_org
  for update;
  if not found then
    raise exception 'Commande introuvable.';
  end if;
  if v_order.devis then
    raise exception 'Un devis ne change pas de destinataire : acceptez-le ou refusez-le.';
  end if;
  if v_order.cancelled_at is not null then
    raise exception 'Cette commande est annulée.';
  end if;
  if v_order.workflow_status = 'DELIVERED'::public.orders_workflow_status_enum then
    raise exception 'Cette commande est déjà livrée ou retirée : son destinataire ne change plus.';
  end if;
  if exists (select 1 from public.invoices i where i.order_id = v_order.id) then
    raise exception 'Une facture a été émise pour cette commande : son destinataire ne change plus.';
  end if;
  if coalesce(v_order.montant_paye, 0) + coalesce(v_order.avance_payee, 0) + coalesce(v_order.avoir_applique, 0) > 0 then
    raise exception 'Un encaissement est déjà enregistré sur cette commande : annulez-le d''abord (fiche de la commande → règlements).';
  end if;

  v_old_kind := case when v_order.is_restock then 'STOCK' else 'CLIENT' end;

  if p_client_id is null then
    v_kind := 'STOCK';
    if v_order.is_restock then
      raise exception 'Cette commande est déjà un réapprovisionnement du stock.';
    end if;
  else
    select * into v_client from public.clients
    where id = p_client_id and organization_id = v_org;
    if not found then
      raise exception 'Fiche client introuvable.';
    end if;
    if not v_order.is_restock and v_order.client_id = p_client_id then
      raise exception 'La commande est déjà rattachée à « % ».', v_client.name;
    end if;
    v_kind := case when v_client.is_garage then 'GARAGE'
                   when v_client.account_type = 'PRO' then 'PRO'
                   else 'PARTICULIER' end;
  end if;

  -- Stock in or out of the picture: nothing may have been received or handed over yet.
  if (v_old_kind = 'STOCK' or v_kind = 'STOCK') and exists (
    select 1 from public.order_lines l
    where l.order_id = v_order.id and (coalesce(l.qte_recue, 0) > 0 or coalesce(l.qte_remise, 0) > 0)
  ) then
    raise exception 'Une pièce de cette commande est déjà reçue ou remise : le stock ne serait plus juste. Annulez la commande et ressaisissez-la.';
  end if;
  if p_livreur_id is not null and v_kind <> 'GARAGE' then
    raise exception 'Seule une commande garage part avec un livreur.';
  end if;
  if p_livreur_id is not null and not exists (
    select 1 from public.livreurs l where l.id = p_livreur_id and l.organization_id = v_org and l.active
  ) then
    raise exception 'An active livreur from this organization is required.';
  end if;

  -- Points de fidélité gagnés sur l'ancien client : repris (le trigger les recalcule pour un nouveau particulier).
  delete from public.loyalty_transactions t where t.order_id = v_order.id and t.kind = 'EARN';

  if v_kind = 'STOCK' then
    delete from public.delivery_tasks t where t.order_id = v_order.id;
    update public.orders set
      client_id = null,
      client_phone = '-',
      client_email = null,
      is_restock = true,
      canal_vente = 'MAGASIN'::public.orders_canal_vente_enum,
      mode_paiement = null,
      echeance = null,
      montant_total = 0,
      solde_restant = 0,
      remise_montant = 0,
      statut_paiement = 'PAYÉ'::public.orders_statut_paiement_enum,
      envoyer_au_livreur = false,
      livreur_id = null,
      statut_livreur = 'EN_ATTENTE'::public.orders_statut_livreur_enum,
      date_envoi = null,
      dispatched_by = null,
      dispatched_at = null,
      workflow_status = 'PENDING'::public.orders_workflow_status_enum,
      updated_at = now()
    where id = v_order.id;
    return jsonb_build_object('kind', 'STOCK', 'total', 0, 'client_name', null);
  end if;

  -- Montant : prix de vente nets des lignes (+ consigne), moins la remise en pied.
  select coalesce(sum(l.quantity * greatest(coalesce(l.prix_vente_unitaire, 0), 0)), 0),
         coalesce(sum(l.quantity * (greatest(coalesce(l.prix_vente_unitaire, 0), 0)
           + case when coalesce(l.consigne, false) then greatest(coalesce(l.consigne_price, 0), 0) else 0 end)), 0)
  into v_parts, v_total
  from public.order_lines l where l.order_id = v_order.id;
  v_discount := least(coalesce(v_order.remise_montant, 0), v_parts);
  v_total := round(v_total - v_discount, 2);

  -- Mode de règlement : un garage est en compte ; un client PRO garde le mode
  -- déjà choisi (en compte compris) ; un particulier règle au comptoir.
  v_mode := case
    when v_kind = 'GARAGE' then 'EN_COMPTE'
    when v_kind = 'PRO' then case when v_order.is_restock then null else v_order.mode_paiement end
    else case when v_order.mode_paiement = 'EN_COMPTE' then null else v_order.mode_paiement end
  end;

  -- Out of a delivery that was for someone else: the livreur drops it.
  if v_kind <> 'GARAGE' then
    delete from public.delivery_tasks t where t.order_id = v_order.id;
  end if;

  update public.orders set
    client_id = v_client.id,
    client_phone = coalesce(nullif(trim(v_client.phone), ''), '-'),
    client_email = nullif(trim(v_client.email), ''),
    is_restock = false,
    canal_vente = case when v_kind = 'GARAGE' then 'B2B'::public.orders_canal_vente_enum
                       when v_order.is_restock or v_order.canal_vente = 'B2B'::public.orders_canal_vente_enum then 'MAGASIN'::public.orders_canal_vente_enum
                       else v_order.canal_vente end,
    mode_paiement = v_mode,
    -- The due date follows the new garage (trigger orders_set_echeance recomputes it on client change).
    echeance = null,
    montant_total = v_total,
    solde_restant = v_total,
    remise_montant = v_discount,
    statut_paiement = case when v_total <= 0 then 'PAYÉ'::public.orders_statut_paiement_enum
                           else 'NON_PAYÉ'::public.orders_statut_paiement_enum end,
    envoyer_au_livreur = (v_kind = 'GARAGE'),
    livreur_id = case when v_kind = 'GARAGE' then v_order.livreur_id else null end,
    statut_livreur = case when v_kind = 'GARAGE' then v_order.statut_livreur else 'EN_ATTENTE'::public.orders_statut_livreur_enum end,
    date_envoi = case when v_kind = 'GARAGE' then v_order.date_envoi else null end,
    workflow_status = case when v_kind <> 'GARAGE' and v_order.workflow_status in ('TO_COLLECT'::public.orders_workflow_status_enum, 'IN_TRANSIT'::public.orders_workflow_status_enum)
                           then 'PENDING'::public.orders_workflow_status_enum else v_order.workflow_status end,
    updated_at = now()
  where id = v_order.id;
  get diagnostics v_touched = row_count;

  if p_livreur_id is not null then
    perform public.dispatch_order_to_livreur(v_order.id, p_livreur_id);
  end if;

  return jsonb_build_object('kind', v_kind, 'total', v_total, 'client_name', v_client.name, 'rows', v_touched);
end;
$$;

revoke execute on function public.reassign_order(uuid, uuid, uuid) from public, anon;
grant execute on function public.reassign_order(uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
