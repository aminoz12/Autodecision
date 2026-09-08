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

/** How an order is settled. EN_COMPTE = carried by a garage account. */
export const MODE_PAIEMENT = ["ESPECES", "CARTE", "VIREMENT", "CHEQUE", "EN_COMPTE"] as const;
export type ModePaiement = (typeof MODE_PAIEMENT)[number];
export const MODE_PAIEMENT_LABEL: Record<ModePaiement, string> = {
  ESPECES: "Espèces",
  CARTE: "Carte bancaire",
  VIREMENT: "Virement",
  CHEQUE: "Chèque",
  EN_COMPTE: "En compte",
};

/** Payment terms a magasin grants a garage (days after the order). */
export const PAYMENT_TERMS = [7, 10, 15, 30] as const;
export type PaymentTermsDays = (typeof PAYMENT_TERMS)[number];
export const PAYMENT_TERMS_LABEL: Record<PaymentTermsDays, string> = {
  7: "À la semaine",
  10: "10 jours",
  15: "15 jours",
  30: "30 jours",
};
export function paymentTermsLabel(days: number): string {
  return (PAYMENT_TERMS_LABEL as Record<number, string>)[days] ?? `${days} jours`;
}
