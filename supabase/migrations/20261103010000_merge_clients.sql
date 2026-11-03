-- Fusion de fiches clients en double + totaux de compte côté serveur (2026-11-03).
--
-- Constat chez Espace Auto 92 : 17 groupes de doublons.
--  * Le formulaire « Nouvelle commande » créait la fiche AVANT la commande ;
--    quand la commande était refusée (numéro, ligne…), chaque nouvel essai
--    créait une fiche de plus (RUSSELL BELLGARDE ×4 en vingt minutes).
--  * La même société saisie une fois en garage, une fois en client PRO, ou
--    une fois en particulier (TLR TRANSPORTS, ALEX MECANO, AUTODIAGPRO92…).
--  * L'encours de la liste des garages était calculé dans le navigateur sur
--    les commandes du magasin — plafonnées à 1 000 lignes par l'API — donc
--    faux dès que le magasin dépasse 1 000 commandes.
--
-- merge_clients(p_keep, p_drop) : administrateur seulement. Tout ce qui
-- pointe sur la fiche en double (commandes, règlements, avoirs, factures,
-- retours, SAV, consignes, fidélité, notifications, accès portail) passe sur
-- la fiche conservée ; ses champs vides sont complétés avec ceux du double ;
-- la fiche en double est supprimée (le trigger d'audit garde la ligne).
-- client_account_totals() : commandes / CA / encours par client, pour la
-- liste des garages et des clients PRO.

create or replace function public.merge_clients(p_keep uuid, p_drop uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_keep public.clients;
  v_drop public.clients;
  v_moved jsonb := '{}'::jsonb;
  v_n bigint;
  v_t text;
  -- Toutes les tables dont client_id référence clients(id).
  v_tables text[] := array[
    'orders', 'payments', 'quotes', 'sales_returns', 'satisfaction_surveys', 'sav_cases',
    'sms_notifications', 'consignment_entries', 'credit_notes', 'invoices',
    'loyalty_transactions', 'notifications', 'profiles'
  ];
begin
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'Choisissez deux fiches différentes.';
  end if;

  -- Depuis l'application (un JWT) : un administrateur du magasin. Depuis la
  -- console postgres sans JWT (reprise de données) : pas de garde.
  if auth.uid() is not null or session_user <> 'postgres' then
    perform public.assert_counter_staff();
    if public.current_user_role() is distinct from 'ADMIN'::public.user_role then
      raise exception 'Seul un administrateur peut fusionner deux fiches.';
    end if;
    v_org := public.current_user_org_id();
    perform public.assert_operational_access(v_org);
  end if;

  select * into v_keep from public.clients
  where id = p_keep and (v_org is null or organization_id = v_org)
  for update;
  if not found then
    raise exception 'Fiche à conserver introuvable.';
  end if;
  select * into v_drop from public.clients
  where id = p_drop and organization_id = v_keep.organization_id
  for update;
  if not found then
    raise exception 'Fiche à fusionner introuvable (ou d''un autre magasin).';
  end if;

  foreach v_t in array v_tables loop
    execute format('update public.%I set client_id = $1 where client_id = $2', v_t) using p_keep, p_drop;
    get diagnostics v_n = row_count;
    if v_n > 0 then
      v_moved := v_moved || jsonb_build_object(v_t, v_n);
    end if;
  end loop;

  -- La fiche conservée garde ses coordonnées ; ses champs vides sont complétés.
  update public.clients k set
    phone = coalesce(nullif(k.phone, ''), v_drop.phone),
    email = coalesce(nullif(k.email, ''), v_drop.email),
    address = coalesce(nullif(k.address, ''), v_drop.address),
    city = coalesce(nullif(k.city, ''), v_drop.city),
    siret = coalesce(nullif(k.siret, ''), v_drop.siret),
    tva_intra = coalesce(nullif(k.tva_intra, ''), v_drop.tva_intra),
    immatriculation = coalesce(nullif(k.immatriculation, ''), v_drop.immatriculation),
    vehicle_model = coalesce(nullif(k.vehicle_model, ''), v_drop.vehicle_model),
    labor_rate = coalesce(k.labor_rate, v_drop.labor_rate),
    public_token = coalesce(k.public_token, v_drop.public_token),
    sms_marketing_consent = coalesce(k.sms_marketing_consent, false) or coalesce(v_drop.sms_marketing_consent, false),
    sms_marketing_consent_at = coalesce(k.sms_marketing_consent_at, v_drop.sms_marketing_consent_at),
    sms_opt_out_at = coalesce(k.sms_opt_out_at, v_drop.sms_opt_out_at),
    notes = concat_ws(E'\n', nullif(k.notes, ''), nullif(v_drop.notes, ''),
      format('Fusion du %s : la fiche « %s » (%s) a été regroupée ici.',
        to_char(timezone('Europe/Paris', now()), 'DD/MM/YYYY'), v_drop.name, coalesce(nullif(v_drop.phone, ''), 'sans téléphone'))),
    updated_at = now()
  where k.id = p_keep;

  -- Le jeton public du double doit être libéré avant que la fiche conservée ne le reprenne.
  if v_keep.public_token is null and v_drop.public_token is not null then
    update public.clients set public_token = null where id = p_drop;
    update public.clients set public_token = v_drop.public_token where id = p_keep;
  end if;

  delete from public.clients where id = p_drop;

  return jsonb_build_object(
    'kept', p_keep, 'kept_name', v_keep.name,
    'dropped', p_drop, 'dropped_name', v_drop.name,
    'moved', v_moved
  );
end;
$$;

revoke execute on function public.merge_clients(uuid, uuid) from public, anon;
grant execute on function public.merge_clients(uuid, uuid) to authenticated;

-- Commandes, chiffre d'affaires et encours par client du magasin (hors devis
-- et commandes annulées), calculés en base : la liste des garages n'a plus à
-- relire toutes les commandes.
create or replace function public.client_account_totals()
returns table (client_id uuid, orders bigint, revenue numeric, outstanding numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid := public.current_user_org_id();
begin
  perform public.assert_counter_staff();
  perform public.assert_operational_access(v_org);
  return query
    select o.client_id,
           count(*)::bigint,
           coalesce(sum(o.montant_total), 0)::numeric,
           coalesce(sum(greatest(o.solde_restant, 0)), 0)::numeric
    from public.orders o
    where o.organization_id = v_org
      and o.devis = false
      and o.cancelled_at is null
      and o.client_id is not null
    group by o.client_id;
end;
$$;

revoke execute on function public.client_account_totals() from public, anon;
grant execute on function public.client_account_totals() to authenticated;

notify pgrst, 'reload schema';
