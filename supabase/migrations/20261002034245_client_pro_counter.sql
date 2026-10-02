-- Client PRO (2026-10-02, précision du gérant) : un client PRO est un client du
-- comptoir qui est un professionnel (indépendant) — pas d'accès au portail et
-- PAS de livraison : il vient chercher ses pièces au comptoir.
--
-- La première version (20261002031524) le rangeait avec les garages
-- (is_garage = true), ce qui l'envoyait dans le circuit de livraison. Il devient
-- un client ordinaire (is_garage = false) marqué account_type = 'PRO' : remise
-- au comptoir, SMS « commande prête », fidélité, retours — tout ce qui vaut pour
-- un client comptoir. Seule différence : il peut aussi acheter « en compte ».

update public.clients set is_garage = false where account_type = 'PRO' and is_garage;

comment on column public.clients.account_type is
  'PRO = client professionnel servi au comptoir (is_garage = false), sans portail ni livraison, autorisé à acheter en compte. GARAGE (défaut) = sans objet pour un client comptoir.';

-- Le paiement en compte était réservé aux garages : il s'ouvre aux clients PRO.
-- La fonction en place est reprise telle quelle, seule cette condition change ;
-- si elle est introuvable la migration s'arrête plutôt que de ne rien corriger.
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef('public.create_order_with_lines(jsonb)'::regprocedure) into v_def;
  v_new := replace(
    v_def,
    'and c.organization_id = v_org and c.is_garage',
    'and c.organization_id = v_org and (c.is_garage or c.account_type = ''PRO'')'
  );
  if v_new = v_def then
    raise exception 'create_order_with_lines: the en-compte check was not found, nothing patched.';
  end if;
  v_new := replace(v_new, 'Le paiement en compte est réservé aux garages.', 'Le paiement en compte est réservé aux garages et aux clients PRO.');
  execute v_new;
end $$;

notify pgrst, 'reload schema';
