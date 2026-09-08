-- ============================================================================
--  SEED — test data for the auto-parts SaaS (orders + lines + returns/avoirs/
--  consignes). Run in the Supabase SQL Editor. Targets the NEWEST organization
--  that has a profile (your magasin).
--
--  Built from the ACTUAL app usage (apps/web), not the repo's .sql files —
--  because the live DB was created via the Supabase dashboard and has drifted
--  from those scripts. Design choices that make it reliable:
--    • Inserts ONLY the columns the app itself writes (proven to exist).
--    • Enum columns use %TYPE anchoring → no enum type names are hard-coded.
--    • NO UPDATE on orders → the set_updated_at trigger never fires, so a
--      missing updated_at column can't break it (totals are precomputed).
--    • Bonus tables are wrapped in EXCEPTION blocks: if one has an unexpected
--      constraint, it's skipped with a NOTICE instead of aborting everything.
--
--  GUARANTEED status coverage on orders (statuses are cycled, not just random):
--    canal_vente     : MAGASIN / TÉLÉPHONE / INTERNET / B2B / AUTRE
--    workflow_status : PENDING / TO_COLLECT / IN_TRANSIT / DELIVERED
--    statut_livreur  : EN_ATTENTE / EN_COURS / LIVRÉ
--    statut_paiement : NON_PAYÉ / PARTIEL / PAYÉ
--
--  Re-runnable: ref numbers continue from the existing max (global, REQ-YYYY-#).
-- ============================================================================
do $$
declare
  v_org      uuid;
  v_vendeur  uuid;
  v_client   uuid;
  v_order    uuid;
  v_phone text; v_email text; v_imm text; v_model text;
  v_ref text;
  i int; k int; n_lines int;
  v_total numeric(14,2); v_paid numeric(14,2);
  v_qty int; v_pv numeric(14,2); v_pa numeric(14,2);
  v_sup uuid; v_dep boolean; v_acmd boolean;
  v_date date; v_send boolean;
  -- enum vars anchored to the live columns: text labels coerce on assignment,
  -- and we never need to know the underlying enum type names.
  v_canal public.orders.canal_vente%type;
  v_pay   public.orders.statut_paiement%type;
  v_wf    public.orders.workflow_status%type;
  v_sl    public.orders.statut_livreur%type;
  client_ids uuid[]; supplier_ids uuid[];
  v_year int := extract(year from current_date);
  v_start int;
  -- per-order line buffers (so we can total BEFORE inserting the order)
  arr_prod text[]; arr_ref text[]; arr_sup uuid[];
  arr_qty int[]; arr_pv numeric[]; arr_pa numeric[];
  arr_acmd boolean[]; arr_dep boolean[];
  n_orders   int := 150;   -- between 100 and 200
  n_returns  int := 30;
  n_avoirs   int := 16;
  n_consigne int := 12;
  products text[] := array[
    'Plaquette de frein','Filtre à huile','Filtre à air','Bras de liaison',
    'Amortisseur avant','Disque de frein','Courroie de distribution',
    'Bougie d''allumage','Rotule de direction','Silentbloc de triangle',
    'Filtre à carburant','Capteur ABS','Biellette de direction',
    'Roulement de roue','Kit d''embrayage'];
  brands text[] := array['BOSCH','VALEO','TRW','MAPCO','SKF','SACHS','MANN','PURFLUX','NGK','MOOG'];
  reasons text[] := array['Erreur de référence','Retour garantie','Pièce défectueuse','Client a changé d''avis'];
  canals    text[] := array['MAGASIN','TÉLÉPHONE','INTERNET','B2B','AUTRE'];
  workflows text[] := array['PENDING','TO_COLLECT','IN_TRANSIT','DELIVERED'];
  livreurs  text[] := array['EN_ATTENTE','EN_COURS','LIVRÉ'];
  paiements text[] := array['NON_PAYÉ','PARTIEL','PAYÉ'];
begin
  -- ----- resolve target magasin + a vendeur (prefer ADMIN) -----------------
  select p.organization_id into v_org
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  order by o.created_at desc, p.created_at asc
  limit 1;
  if v_org is null then
    raise exception 'Aucune organisation avec un profil — créez un compte (/signup) d''abord.';
  end if;

  select user_id into v_vendeur
  from public.profiles
  where organization_id = v_org
  order by (role = 'ADMIN') desc, created_at asc
  limit 1;

  -- ----- ensure suppliers (minimal columns the app uses) -------------------
  insert into public.suppliers (organization_id, name, code)
  select v_org, s, upper(left(s,3))
  from unnest(array['OTTOGO','MAPCO','TRW','BOSCH','PURFLUX','SKF','SACHS','VALEO']) s
  where not exists (select 1 from public.suppliers x where x.organization_id = v_org and x.name = s);

  -- ----- ensure clients : garages + particuliers (minimal columns) ---------
  insert into public.clients (organization_id, name, phone, email, immatriculation, vehicle_model)
  select v_org, c.name, c.phone, c.email, c.plate, c.model
  from (values
    -- garages / professionnels
    ('Garage Martin','01 41 20 30 40','contact@garagemartin.fr','AA-123-BB','Renault Master'),
    ('Auto Performance','01 47 70 22 33','contact@autoperf.fr','DE-456-FG','Audi A3 2.0 TDI'),
    ('Speed Garage','01 48 55 66 77','info@speedgarage.fr','EZ-789-HJ','Peugeot 308'),
    ('Carrosserie Almeida','01 46 12 34 56','almeida@carrosserie.fr','BB-321-CC','Mercedes Sprinter'),
    ('L''Atelier 92','01 42 00 11 22','contact@atelier92.fr','GH-654-IJ','Ford Transit'),
    ('Garage du Centre','01 47 65 78 90','contact@garageducentre.fr','KL-987-MN','Citroën Berlingo'),
    ('Méca Services','01 42 55 66 77','contact@mecaservices.fr','CV-266-XD','BMW X5 xDrive 30d'),
    ('Santiago Renault','01 47 85 10 00','contact@santiagorenault.fr','AB-555-CD','Renault Clio'),
    -- particuliers / clients normaux
    ('Jean Dupont','06 12 34 56 78','jean.dupont@gmail.com','FA-101-BC','Renault Clio IV'),
    ('Marie Lefèvre','06 23 45 67 89','marie.lefevre@gmail.com','FB-202-CD','Peugeot 208'),
    ('Karim Benali','06 34 56 78 90','karim.benali@outlook.fr','FC-303-DE','Volkswagen Golf 7'),
    ('Sophie Moreau','06 45 67 89 01','sophie.moreau@gmail.com','FD-404-EF','Citroën C3'),
    ('Lucas Garcia','06 56 78 90 12','lucas.garcia@gmail.com','FE-505-FG','Dacia Sandero'),
    ('Emma Rousseau','06 67 89 01 23','emma.rousseau@gmail.com','FF-606-GH','Ford Fiesta')
  ) as c(name,phone,email,plate,model)
  where not exists (select 1 from public.clients x where x.organization_id = v_org and x.name = c.name);

  select array_agg(id) into client_ids   from public.clients   where organization_id = v_org;
  select array_agg(id) into supplier_ids  from public.suppliers where organization_id = v_org;

  -- ----- next free REQ number (GLOBAL max: ref_demande is unique site-wide) -
  select coalesce(max(right(ref_demande,5)::int),0) into v_start
  from public.orders
  where ref_demande like format('REQ-%s-%%', v_year)
    and length(ref_demande) = length(format('REQ-%s-', v_year)) + 5;

  -- ========================================================================
  --  ORDERS (+ lines). Totals are computed first, so NO update is needed.
  -- ========================================================================
  for i in 1..n_orders loop
    v_date  := current_date - (floor(random()*60))::int;
    v_canal := canals[1 + (i % array_length(canals,1))];
    v_wf    := workflows[1 + (i % array_length(workflows,1))];
    v_sl    := livreurs[1 + (i % array_length(livreurs,1))];
    v_pay   := paiements[1 + (i % array_length(paiements,1))];
    v_client := client_ids[1 + (i % array_length(client_ids,1))];   -- alternates garage / particulier
    v_send  := (v_wf <> 'PENDING');
    v_ref   := format('REQ-%s-%s', v_year, lpad((v_start + i)::text, 5, '0'));

    select phone, email, immatriculation, vehicle_model
      into v_phone, v_email, v_imm, v_model
    from public.clients where id = v_client;

    -- build the lines in buffers and accumulate the total
    n_lines := 1 + floor(random()*3)::int;
    arr_prod := '{}'; arr_ref := '{}'; arr_sup := '{}';
    arr_qty := '{}'; arr_pv := '{}'; arr_pa := '{}';
    arr_acmd := '{}'; arr_dep := '{}';
    v_total := 0;
    for k in 1..n_lines loop
      v_qty := 1 + floor(random()*4)::int;
      v_pv  := round((50 + random()*350)::numeric, 2);
      v_pa  := round(v_pv * 0.6, 2);
      v_dep := (random() < 0.3);                 -- depuis le magasin
      if v_dep then
        v_sup := null; v_acmd := false;
      else
        v_sup  := supplier_ids[1 + floor(random()*array_length(supplier_ids,1))::int];
        v_acmd := (random() < 0.5);              -- à commander pour le livreur
      end if;
      arr_prod := array_append(arr_prod,
        products[1 + floor(random()*array_length(products,1))::int] || ' ' ||
        brands[1 + floor(random()*array_length(brands,1))::int]);
      arr_ref  := array_append(arr_ref,
        upper(left(brands[1 + floor(random()*array_length(brands,1))::int],2)) || '-' ||
        lpad((floor(random()*9999))::int::text, 4, '0'));
      arr_sup  := array_append(arr_sup, v_sup);
      arr_qty  := array_append(arr_qty, v_qty);
      arr_pv   := array_append(arr_pv, v_pv);
      arr_pa   := array_append(arr_pa, v_pa);
      arr_acmd := array_append(arr_acmd, v_acmd);
      arr_dep  := array_append(arr_dep, v_dep);
      v_total  := v_total + v_qty * v_pv;
    end loop;

    -- payment coherent with the cycled statut_paiement
    if v_pay = 'PAYÉ' then v_paid := v_total;
    elsif v_pay = 'PARTIEL' then v_paid := round(v_total * 0.5, 2);
    else v_paid := 0;
    end if;

    -- insert the order with FINAL totals (mirrors createOrderWithLines)
    insert into public.orders (
      organization_id, ref_demande, date_commande, vendeur_id, canal_vente,
      client_id, client_phone, client_email, immatriculation, vehicle_model,
      montant_total, devis, statut_paiement, montant_paye, avance_payee, solde_restant,
      envoyer_au_livreur, date_envoi, statut_livreur, consigne, workflow_status, bl, date_bl
    ) values (
      v_org, v_ref, v_date, v_vendeur, v_canal,
      v_client, coalesce(v_phone,'0600000000'), v_email, v_imm, v_model,
      v_total, false, v_pay, v_paid, 0, v_total - v_paid,
      v_send, case when v_send then (v_date + 1)::timestamptz else null end,
      v_sl, null, v_wf, (v_wf = 'DELIVERED'),
      case when v_wf = 'DELIVERED' then v_date else null end
    ) returning id into v_order;

    -- insert the buffered lines (mirrors the app's line columns)
    for k in 1..n_lines loop
      insert into public.order_lines (
        organization_id, order_id, nom_produit, reference, supplier_id, quantity,
        a_commander_pour_livreur, depuis_magasin, retour_stock_fait,
        prix_achat_unitaire, prix_vente_unitaire
      ) values (
        v_org, v_order, arr_prod[k], arr_ref[k], arr_sup[k], arr_qty[k],
        arr_acmd[k], arr_dep[k], false,
        arr_pa[k], arr_pv[k]
      );
    end loop;
  end loop;

  -- ----- delivery_tasks for sent orders (best-effort) ----------------------
  begin
    insert into public.delivery_tasks (organization_id, order_id, workflow_status)
    select o.organization_id, o.id, 'TO_COLLECT'
    from public.orders o
    where o.organization_id = v_org
      and o.envoyer_au_livreur = true
      and not exists (select 1 from public.delivery_tasks d where d.order_id = o.id);
  exception when others then
    raise notice 'delivery_tasks ignoré (%, %).', sqlstate, sqlerrm;
  end;

  -- ----- sales_returns (best-effort) ---------------------------------------
  begin
    for i in 1..n_returns loop
      select id into v_order
      from public.orders where organization_id = v_org order by random() limit 1;
      insert into public.sales_returns (organization_id, order_id, reason)
      values (v_org, v_order, reasons[1 + (i % array_length(reasons,1))]);
    end loop;
  exception when others then
    raise notice 'sales_returns ignoré (%, %).', sqlstate, sqlerrm;
  end;

  -- ----- credit_notes / avoirs (best-effort) -------------------------------
  begin
    for i in 1..n_avoirs loop
      select id, client_id into v_order, v_client
      from public.orders
      where organization_id = v_org and client_id is not null
      order by random() limit 1;
      insert into public.credit_notes (organization_id, client_id, amount, order_id)
      values (v_org, v_client, round((100 + random()*2500)::numeric, 2), v_order);
    end loop;
  exception when others then
    raise notice 'credit_notes ignoré (%, %).', sqlstate, sqlerrm;
  end;

  -- ----- consignment_entries / consignes (best-effort) ---------------------
  begin
    for i in 1..n_consigne loop
      select client_id into v_client
      from public.orders
      where organization_id = v_org and client_id is not null
      order by random() limit 1;
      insert into public.consignment_entries (organization_id, client_id, description, quantity)
      values (v_org, v_client, 'Consigne pièces',
              1 + floor(random()*3)::int);
    end loop;
  exception when others then
    raise notice 'consignment_entries ignoré (%, %).', sqlstate, sqlerrm;
  end;

  raise notice 'Seed OK -> org % : % commandes (tous statuts, garages + particuliers) + lignes, ~% retours, ~% avoirs, ~% consignes.',
    v_org, n_orders, n_returns, n_avoirs, n_consigne;
end $$;
