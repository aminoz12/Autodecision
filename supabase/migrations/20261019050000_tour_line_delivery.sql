-- Étiquette « Livraison » sur les pièces à récupérer (2026-10-19).
--
-- Quand le comptoir coche « Livraison » à la création d'une commande garage
-- (ou l'envoie au livreur depuis « Commande à livrer »), la commande part
-- tout de suite avec un livreur (dispatch_order_to_livreur : livreur_id +
-- IN_TRANSIT) alors que ses pièces sont encore à récupérer chez le
-- fournisseur. Le livreur qui fait la tournée fournisseurs doit alors porter
-- la pièce directement au garage, pas la ramener au magasin.
--
-- supplier_tour_board() donne donc, par ligne, le livreur qui a la commande
-- en livraison : delivery_livreur_id / delivery_livreur (null sinon). L'app
-- affiche une étiquette rouge « Livraison » (« Livraison · Rachid » quand
-- c'est un collègue) sur la tournée du livreur et sur les puces du comptoir.
--
-- La fonction est modifiée sur place (pg_get_functiondef + replace) avec des
-- ancres qui font échouer la migration si le texte attendu n'est plus là,
-- comme 20261003031522_tour_schedule.sql.

do $$
declare
  v_def text;
  v_new text;
  v_anchor text;
  v_count int;
begin
  select pg_get_functiondef('public.supplier_tour_board(date)'::regprocedure) into v_def;

  -- 1) Les deux clés par ligne, devant 'is_restock'.
  v_anchor := E'\n          ''is_restock'', coalesce(o.is_restock, false),';
  v_count := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'supplier_tour_board: the is_restock key was found % time(s), nothing patched.', v_count;
  end if;
  v_new := replace(
    v_def,
    v_anchor,
    E'\n          -- Commande déjà partie en livraison (case « Livraison » / envoi au livreur) : la pièce va au garage.'
    || E'\n          ''delivery_livreur_id'', case when o.livreur_id is not null and o.workflow_status = ''IN_TRANSIT''::public.orders_workflow_status_enum then o.livreur_id end,'
    || E'\n          ''delivery_livreur'', case when o.livreur_id is not null and o.workflow_status = ''IN_TRANSIT''::public.orders_workflow_status_enum then lv.name end,'
    || v_anchor
  );

  -- 2) La jointure sur les livreurs, après celle sur les clients de la requête des lignes.
  v_anchor := E'\n      left join public.clients c on c.id = o.client_id\n';
  v_count := (length(v_new) - length(replace(v_new, v_anchor, ''))) / length(v_anchor);
  if v_count <> 1 then
    raise exception 'supplier_tour_board: the clients join of the lines query was found % time(s), nothing patched.', v_count;
  end if;
  v_new := replace(
    v_new,
    v_anchor,
    E'\n      left join public.clients c on c.id = o.client_id\n      left join public.livreurs lv on lv.id = o.livreur_id\n'
  );

  execute v_new;
end;
$$;

notify pgrst, 'reload schema';
