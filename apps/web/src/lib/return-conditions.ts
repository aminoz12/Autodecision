/*
 * Conditions de retour et d'annulation du magasin (2026-09-30).
 *
 * Le remboursement ou l'échange d'une pièce coûte des frais de retour qui
 * dépendent de l'ancienneté de la vente et de l'origine de la pièce :
 *
 *   Pièces en stock       ≤ 7 j : 20 %   ≤ 14 j : 30 %   (30 % jusqu'à 1 mois)   > 1 mois : aucun retour
 *   Pièces sur commande   ≤ 7 j : 20 %   ≤ 14 j : 40 %                            > 14 j : aucun retour
 *   Pièces électriques    ni retour, ni échange, ni remboursement
 *
 * Les frais tombent quand le magasin, le catalogue ou le fournisseur est en
 * tort (erreur de référence, mauvaise identification, pièce non conforme).
 * Un dossier garantie ou une annulation suit le barème comme un retour.
 * Pure functions: no I/O, fully unit-tested.
 */
import { RETURN_MOTIF_BY_CODE, daysBetween, parisToday, parseDay } from "@/lib/sav";

export type ReturnOrigin = "STOCK" | "COMMANDE";

export type FeeTier = { maxDays: number; feePct: number };

export const RETURN_FEE_SCHEDULE: Record<ReturnOrigin, { label: string; tiers: FeeTier[]; lastDay: number }> = {
  STOCK: {
    label: "Pièce en stock",
    tiers: [
      { maxDays: 7, feePct: 20 },
      { maxDays: 14, feePct: 30 },
      { maxDays: 30, feePct: 30 },
    ],
    lastDay: 30,
  },
  COMMANDE: {
    label: "Pièce sur commande",
    tiers: [
      { maxDays: 7, feePct: 20 },
      { maxDays: 14, feePct: 40 },
    ],
    lastDay: 14,
  },
};

/** Motifs where the fault is not the client's: the part is taken back without fees, whatever its age. */
export const FEE_WAIVED_MOTIFS: ReadonlySet<string> = new Set(["ERREUR_VENDEUR", "MAUVAISE_IDENTIFICATION", "NON_CONFORME"]);

/** Part families that are electrical by nature. */
export const ELECTRICAL_FAMILIES: ReadonlySet<string> = new Set(["BATTERIE", "DEMARRAGE_CHARGE", "ALLUMAGE", "ECLAIRAGE"]);

const ELECTRICAL_WORDS =
  /\b(capteur|sonde|bobine|calculateur|boitier electronique|relais|commodo|interrupteur|contacteur|electrovanne|debitmetre|alternateur|demarreur|batterie|bougie|ampoule|lampe|phare|projecteur|leve[- ]vitre|pompe a carburant|injecteur|actionneur|faisceau|fusible|antenne|klaxon|avertisseur|motoventilateur|electrique|electronique|airbag|neiman)\b/;

function plain(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Electrical component: by family when known, else by the words of the designation. */
export function isElectricalPart(designation: string | null | undefined, family?: string | null): boolean {
  if (family && ELECTRICAL_FAMILIES.has(family)) return true;
  if (!designation) return false;
  return ELECTRICAL_WORDS.test(plain(designation));
}

export type ReturnConditions = {
  origin: ReturnOrigin;
  /** Days since the sale, null when the sale date is unknown. */
  days: number | null;
  electrical: boolean;
  /** False = the conditions do not provide for this return; the counter can still make an exception. */
  allowed: boolean;
  /** Fee to apply (also for an exception: the highest tier of the origin). */
  feePct: number;
  /** Fees dropped because the fault is not the client's. */
  waived: boolean;
  /** One sentence for the counter. */
  reason: string;
};

export function returnConditions(input: {
  saleDate: string | null | undefined;
  origin: ReturnOrigin;
  designation?: string | null;
  family?: string | null;
  motifCode?: string | null;
  today?: Date;
}): ReturnConditions {
  const today = input.today ?? parisToday();
  const schedule = RETURN_FEE_SCHEDULE[input.origin];
  const electrical = isElectricalPart(input.designation, input.family);
  const motif = input.motifCode ? RETURN_MOTIF_BY_CODE[input.motifCode] : undefined;
  const start = parseDay(input.saleDate);
  const days = start ? daysBetween(start, today) : null;
  const lastTier = schedule.tiers[schedule.tiers.length - 1];
  const tier = days == null ? null : (schedule.tiers.find((t) => days <= t.maxDays) ?? null);
  const base = { origin: input.origin, days, electrical, waived: false };

  if (motif && FEE_WAIVED_MOTIFS.has(motif.code)) {
    return {
      ...base,
      allowed: true,
      feePct: 0,
      waived: true,
      reason: `${motif.label} : reprise sans frais, ${motif.fault.toLowerCase()} est responsable.`,
    };
  }
  if (electrical) {
    return {
      ...base,
      allowed: false,
      feePct: days == null ? 0 : (tier ?? lastTier).feePct,
      reason: "Pièce électrique : ni retour, ni échange, ni remboursement.",
    };
  }
  if (days == null) {
    return { ...base, allowed: true, feePct: 0, reason: "Date de vente inconnue : appliquez les conditions de retour à la main." };
  }
  if (!tier) {
    return {
      ...base,
      allowed: false,
      feePct: lastTier.feePct,
      reason: `${schedule.label} vendue il y a ${days} j : aucun retour prévu après ${schedule.lastDay} jours.`,
    };
  }
  return {
    ...base,
    allowed: true,
    feePct: tier.feePct,
    reason:
      tier.feePct > 0
        ? `${schedule.label} vendue il y a ${days} j : frais de retour de ${tier.feePct} %.`
        : `${schedule.label} vendue il y a ${days} j : reprise sans frais.`,
  };
}

/** Amount given back to the client once the fee is kept, in cents-exact euros. */
export function netRefund(amount: number, feePct: number): number {
  const pct = Math.min(100, Math.max(0, feePct));
  return Math.round(Math.max(0, amount) * (100 - pct)) / 100;
}

/** The fee itself, so the two figures always add up to the line value. */
export function feeAmount(amount: number, feePct: number): number {
  return Math.round((Math.max(0, amount) - netRefund(amount, feePct)) * 100) / 100;
}

/** The conditions as printed on the ticket and shown in the settings. */
export const RETURN_CONDITIONS_TEXT =
  "Conditions de retour : pièces en stock, frais de 20 % jusqu'à 7 jours, 30 % jusqu'à 14 jours, aucun retour après 1 mois ; " +
  "pièces sur commande, 20 % jusqu'au 7e jour, 40 % jusqu'au 14e jour, aucun retour au-delà de 14 jours. " +
  "Pièces électriques : ni retour, ni échange, ni remboursement.";

/** Same conditions, one line per rule, for a compact reminder at the counter. */
export const RETURN_CONDITIONS_LINES: string[] = [
  "Pièces en stock : 20 % de frais jusqu'à 7 jours, 30 % jusqu'à 14 jours (et jusqu'à 1 mois), aucun retour après 1 mois.",
  "Pièces sur commande : 20 % jusqu'au 7e jour, 40 % jusqu'au 14e jour, aucun retour au-delà.",
  "Pièces électriques : ni retour, ni échange, ni remboursement.",
];
