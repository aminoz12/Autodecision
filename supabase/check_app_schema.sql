-- ============================================================================
--  Schema audit: does the live DB have every column the dashboard queries?
--
--  Run in the Supabase SQL Editor.
--  → 0 rows  = the database matches the app; every wired page can load.
--  → N rows  = each row is a missing column (a missing table shows up as
--              ALL of its columns missing). Send me the output and I patch.
-- ============================================================================

with expected (table_name, column_name) as (
  values
  -- orders: dashboard, rapports, nouvelle-commande, garages
  ('orders','id'),('orders','organization_id'),('orders','ref_demande'),
  ('orders','date_commande'),('orders','vendeur_id'),('orders','canal_vente'),
  ('orders','client_id'),('orders','client_phone'),('orders','client_email'),
  ('orders','immatriculation'),('orders','vehicle_model'),('orders','montant_total'),
  ('orders','devis'),('orders','statut_paiement'),('orders','montant_paye'),
  ('orders','avance_payee'),('orders','solde_restant'),('orders','envoyer_au_livreur'),
  ('orders','date_envoi'),('orders','statut_livreur'),('orders','consigne'),
  ('orders','workflow_status'),('orders','bl'),('orders','date_bl'),

  -- order_lines: reception, reliquats, fournisseurs, livreurs, recherche-piece
  ('order_lines','id'),('order_lines','organization_id'),('order_lines','order_id'),
  ('order_lines','nom_produit'),('order_lines','reference'),('order_lines','supplier_id'),
  ('order_lines','quantity'),('order_lines','qte_recue'),('order_lines','reception_status'),
  ('order_lines','prevue_le'),('order_lines','received_at'),('order_lines','tour_id'),
  ('order_lines','a_commander_pour_livreur'),('order_lines','depuis_magasin'),
  ('order_lines','retour_stock_fait'),('order_lines','prix_achat_unitaire'),
  ('order_lines','prix_vente_unitaire'),

  -- clients: garages, dashboard overview, nouvelle-commande
  ('clients','id'),('clients','organization_id'),('clients','name'),('clients','phone'),
  ('clients','email'),('clients','immatriculation'),('clients','vehicle_model'),
  ('clients','city'),('clients','rating'),('clients','is_active'),

  -- suppliers: fournisseurs, nouvelle-commande
  ('suppliers','id'),('suppliers','organization_id'),('suppliers','name'),
  ('suppliers','code'),('suppliers','created_at'),

  -- stock_items: stock, recherche-piece, reception
  ('stock_items','id'),('stock_items','organization_id'),('stock_items','sku'),
  ('stock_items','name'),('stock_items','quantity_on_hand'),('stock_items','updated_at'),

  -- sales_returns: retours, rapports, dashboard overview
  ('sales_returns','id'),('sales_returns','organization_id'),('sales_returns','ref'),
  ('sales_returns','created_at'),('sales_returns','order_id'),('sales_returns','reason'),
  ('sales_returns','motif'),('sales_returns','designation'),('sales_returns','type_retour'),
  ('sales_returns','statut_traitement'),('sales_returns','decote_pct'),('sales_returns','montant'),
  ('sales_returns','client_id'),('sales_returns','supplier_id'),

  -- credit_notes + consignment_entries: avoirs, rapports
  ('credit_notes','id'),('credit_notes','organization_id'),('credit_notes','num'),
  ('credit_notes','created_at'),('credit_notes','amount'),('credit_notes','statut'),
  ('credit_notes','echeance'),('credit_notes','motif'),('credit_notes','designation'),
  ('credit_notes','client_id'),('credit_notes','order_id'),
  ('consignment_entries','id'),('consignment_entries','organization_id'),
  ('consignment_entries','num'),('consignment_entries','created_at'),
  ('consignment_entries','montant'),('consignment_entries','status'),
  ('consignment_entries','echeance'),('consignment_entries','motif'),
  ('consignment_entries','description'),('consignment_entries','client_id'),

  -- delivery_tours + delivery_tasks: livreurs, nouvelle-commande
  ('delivery_tours','id'),('delivery_tours','organization_id'),('delivery_tours','name'),
  ('delivery_tours','tour_date'),('delivery_tours','status'),('delivery_tours','vehicle_label'),
  ('delivery_tasks','id'),('delivery_tasks','organization_id'),('delivery_tasks','order_id'),
  ('delivery_tasks','workflow_status'),

  -- organizations: parametres
  ('organizations','id'),('organizations','name'),('organizations','phone'),
  ('organizations','address'),('organizations','city'),('organizations','plan'),
  ('organizations','subscription_status'),('organizations','seat_limit'),

  -- quotes + profiles: devis (future), auth
  ('quotes','id'),('quotes','organization_id'),('quotes','ref'),
  ('quotes','created_by_id'),('quotes','payload'),
  ('profiles','user_id'),('profiles','organization_id'),
  ('profiles','display_name'),('profiles','role')
)
select e.table_name, e.column_name as missing_column
from expected e
left join information_schema.columns c
  on c.table_schema = 'public'
 and c.table_name   = e.table_name
 and c.column_name  = e.column_name
where c.column_name is null
order by e.table_name, e.column_name;
