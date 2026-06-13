export const CANAL_VENTE = [
  "MAGASIN",
  "TÉLÉPHONE",
  "INTERNET",
  "B2B",
  "AUTRE",
] as const;

export const STATUT_PAIEMENT = ["NON_PAYÉ", "PARTIEL", "PAYÉ"] as const;

export const STATUT_LIVREUR = ["EN_ATTENTE", "EN_COURS", "LIVRÉ"] as const;

export type CanalVente = (typeof CANAL_VENTE)[number];
export type StatutPaiement = (typeof STATUT_PAIEMENT)[number];
export type StatutLivreur = (typeof STATUT_LIVREUR)[number];
