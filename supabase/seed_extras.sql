-- ============================================================================
--  SEED EXTRAS — fills the last two wired-but-empty tables so every real page
--  has data: stock_items (Stock / Retour au stock) and supplier_receptions
--  (Réception des commandes). Run AFTER seed_orders.sql, in the SQL Editor.
--
--  Same safety model as seed_orders.sql: only columns the app itself writes,
--  each section wrapped in EXCEPTION so a surprise can't abort the whole run,
--  idempotent (won't duplicate on re-run). Targets the newest org with a profile.
-- ============================================================================
do $$
declare
  v_org   uuid;
  i int; v_rs_start int; v_received boolean;
  v_year int := extract(year from current_date);
  products text[] := array[
    'Plaquette de frein','Filtre à huile','Filtre à air','Bras de liaison',
    'Amortisseur avant','Disque de frein','Courroie de distribution',
    'Bougie d''allumage','Rotule de direction','Silentbloc de triangle',
    'Filtre à carburant','Capteur ABS','Biellette de direction',
    'Roulement de roue','Kit d''embrayage'];
  brands text[] := array['BOSCH','VALEO','TRW','MAPCO','SKF','SACHS','MANN','PURFLUX','NGK','MOOG'];
  n_stock int := 40;
  n_recep int := 24;
begin
  select p.organization_id into v_org
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  order by o.created_at desc, p.created_at asc
  limit 1;
  if v_org is null then
    raise exception 'Aucune organisation avec un profil — créez un compte (/signup) d''abord.';
  end if;

  -- ----- stock_items : inventory (best-effort, idempotent by sku) -----------
  begin
    insert into public.stock_items (organization_id, sku, name, quantity_on_hand)
    select v_org,
           'SKU-' || lpad(g::text, 4, '0'),
           products[1 + (g % array_length(products,1))] || ' ' ||
           brands[1 + (g % array_length(brands,1))],
           (floor(random()*60))::int
    from generate_series(1, n_stock) g
    where not exists (
      select 1 from public.stock_items s
      where s.organization_id = v_org and s.sku = 'SKU-' || lpad(g::text, 4, '0')
    );
    raise notice 'stock_items: jusqu''à % articles assurés.', n_stock;
  exception when others then
    raise notice 'stock_items ignoré (%, %).', sqlstate, sqlerrm;
  end;

  -- ----- supplier_receptions : fournisseur reçu / non reçu (best-effort) ----
  begin
    -- continue numbering from existing BC-YYYY-##### (re-runnable)
    select coalesce(max(right(reference,5)::int),0) into v_rs_start
    from public.supplier_receptions
    where reference like format('BC-%s-%%', v_year)
      and length(reference) = length(format('BC-%s-', v_year)) + 5;

    for i in 1..n_recep loop
      v_received := (random() < 0.6);
      insert into public.supplier_receptions (organization_id, reference, received, received_at, updated_at)
      values (
        v_org,
        format('BC-%s-%s', v_year, lpad((v_rs_start + i)::text, 5, '0')),
        v_received,
        case when v_received then now() - ((random()*20) || ' days')::interval else null end,
        now()
      );
    end loop;
    raise notice 'supplier_receptions: % réceptions ajoutées.', n_recep;
  exception when others then
    raise notice 'supplier_receptions ignoré (%, %).', sqlstate, sqlerrm;
  end;

  raise notice 'Seed extras OK -> org %.', v_org;
end $$;
