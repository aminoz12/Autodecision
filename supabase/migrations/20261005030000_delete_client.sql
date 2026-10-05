-- Supprimer un client, un garage ou un client PRO (2026-10-05).
--
-- La fiche client « Supprimer » échouait en production : « permission denied
-- for table clients » — le rôle authenticated n'a pas le droit DELETE sur
-- clients (voulu : les suppressions passent par des fonctions qui vérifient).
-- delete_client() fait les vérifications côté base puis supprime :
--   * particulier : tout le comptoir (comme avant) ;
--   * garage / client PRO : administrateur seulement (demande du magasin) ;
--   * refusé tant qu'il reste une commande non réglée, un avoir (supprimé en
--     cascade sinon), une facture (clé RESTRICT), une consigne en cours, ou un
--     accès au portail garage (le profil du garagiste serait effacé en cascade
--     et son compte resterait orphelin : on supprime d'abord l'accès).
-- Les commandes, règlements, retours et dossiers SAV restent, sans fiche
-- client (client_id remis à null par les clés étrangères).

create or replace function public.delete_client(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
  v_client public.clients;
  v_account boolean;
  v_unpaid integer;
  v_credits integer;
  v_invoices integer;
  v_consignes integer;
  v_portal integer;
  v_blockers text[] := array[]::text[];
  v_who text;
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);

  select * into v_client from public.clients where id = p_client_id and organization_id = v_org for update;
  if not found then
    raise exception 'Client introuvable : rien n''a été supprimé.';
  end if;

  v_account := coalesce(v_client.is_garage, false) or coalesce(v_client.account_type, '') = 'PRO';
  v_who := case when coalesce(v_client.is_garage, false) then 'ce garage'
                when coalesce(v_client.account_type, '') = 'PRO' then 'ce client PRO'
                else 'ce client' end;
  if v_account and public.current_user_role() is distinct from 'ADMIN'::public.user_role then
    raise exception 'Seul un administrateur peut supprimer un garage ou un client PRO.';
  end if;

  select count(*) into v_unpaid from public.orders o
  where o.organization_id = v_org and o.client_id = p_client_id
    and o.devis = false and o.cancelled_at is null and o.solde_restant > 0;
  select count(*) into v_credits from public.credit_notes c where c.organization_id = v_org and c.client_id = p_client_id;
  select count(*) into v_invoices from public.invoices i where i.organization_id = v_org and i.client_id = p_client_id;
  select count(*) into v_consignes from public.consignment_entries e
  where e.organization_id = v_org and e.client_id = p_client_id
    and (e.status = 'ACTIF' or e.supplier_status in ('A_RENVOYER', 'RENVOYE'));
  select count(*) into v_portal from public.profiles p where p.client_id = p_client_id;

  if v_unpaid > 0 then v_blockers := v_blockers || format('%s commande(s) pas encore réglée(s)', v_unpaid); end if;
  if v_credits > 0 then v_blockers := v_blockers || format('%s avoir(s)', v_credits); end if;
  if v_invoices > 0 then v_blockers := v_blockers || format('%s facture(s) émise(s)', v_invoices); end if;
  if v_consignes > 0 then v_blockers := v_blockers || format('%s consigne(s) en cours', v_consignes); end if;
  if array_length(v_blockers, 1) > 0 then
    raise exception 'Suppression impossible : % a %. Ces pièces comptables doivent être conservées%',
      v_who, array_to_string(v_blockers, ', '),
      case when v_account then '.' else ' — désactivez le client à la place.' end;
  end if;
  if v_portal > 0 then
    raise exception 'Suppression impossible : % a un accès au portail garage. Supprimez d''abord cet accès (Admin → Accès garagistes).', v_who;
  end if;

  delete from public.clients where id = p_client_id and organization_id = v_org;
end;
$$;
revoke execute on function public.delete_client(uuid) from public, anon;
grant execute on function public.delete_client(uuid) to authenticated;

notify pgrst, 'reload schema';
