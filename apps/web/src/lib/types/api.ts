export type UserRole = "CAISSIER" | "ADMIN" | "LIVREUR";

export type UserProfile = {
  user_id: string;
  organization_id: string;
  display_name: string;
  role: UserRole;
  /** Set when the user is a garagiste (links to their garage in clients). */
  client_id: string | null;
  /** Set when the user is a delivery driver (links to livreurs). */
  livreur_id: string | null;
};

export type ClientDto = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  licensePlate: string | null;
  vehicleModel: string | null;
};

export type SupplierDto = {
  id: string;
  name: string;
  code: string | null;
};

export type OrderLineDto = {
  id?: string;
  nom_produit: string;
  reference: string;
  fournisseur_id?: string;
  quantity: number;
  a_commander_pour_livreur: boolean;
  depuis_magasin?: boolean;
  retour_stock_fait?: boolean;
  /** The part can never be returned (blocks garagiste returns + walk-in refunds). */
  retour_impossible?: boolean;
  /** The part carries a returnable deposit (consigne / core charge). */
  consigne?: boolean;
  /** Per-unit deposit amount when consigne is set. */
  consigne_price?: number;
  /** Units the client took at the counter when the order was created (stock magasin). */
  qte_remise?: number;
  prix_achat_unitaire: number;
  prix_vente_unitaire: number;
};

export type CreateOrderPayload = {
  date_commande: string;
  canal_vente: string;
  client_id?: string;
  client_phone: string;
  client_email?: string;
  immatriculation?: string;
  vehicle_model?: string;
  /** Vehicle mileage (km) at the time of the order. */
  kilometrage?: number;
  lines: OrderLineDto[];
  devis?: boolean;
  devis_status?: string;
  statut_paiement: string;
  montant_paye: number;
  avance_payee: number;
  /** Credit note consumed as payment on this order. */
  avoir_id?: string;
  avoir_applique?: number;
  envoyer_au_livreur?: boolean;
  date_envoi?: string;
  statut_livreur?: string;
  consigne?: string;
  bl?: boolean;
  date_bl?: string;
};
