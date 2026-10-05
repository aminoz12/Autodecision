import type { TicketData } from "@/components/print/OrderTicket";
import type { PaymentMode } from "@/lib/data/payments";

/*
 * Pure rules of the « Nouvelle commande » form and of its « Rajout rapide »
 * modal (components/orders/QuickAdd.tsx): règlement, money typed at the
 * counter, what a quick row still lacks.
 */

/** What happens to the money at creation: cashed in full, nothing yet, or carried by the garage account. */
export type Reglement = "PAYEE" | "NON_PAYEE" | "EN_COMPTE";
export const REGLEMENT_LABEL: Record<Reglement, string> = {
  PAYEE: "Payée",
  NON_PAYEE: "Non payée",
  EN_COMPTE: "En compte",
};

/** Counter client, garage, or client PRO (a professional served at the counter: no portal, no delivery). */
export type PourQui = "COMPTOIR" | "GARAGE" | "PRO";
/** Rajout rapide can also order straight for the magasin stock. */
export type QuickPourQui = PourQui | "STOCK";

export interface QuickRow {
  ref: string;
  qty: number;
  fournisseur: string;
  pourQui: QuickPourQui;
  garageId: string;
  clientName: string;
  clientPhone: string;
  retoursImpossible: boolean;
  consigne: boolean;
  consignePrice: number;
  clientAPris: boolean;
  /** Unit sale price TTC, as typed (« 12,50 »). Not asked for a stock replenishment. */
  price: string;
  /** Chosen by the cashier for every client row ("" = not chosen yet); a garage is always en compte. */
  reglement: Reglement | "";
  /** How a « Payée » row was paid. */
  mode: PaymentMode | "";
}

/** A quick order once created, for the ticket screen (no ticket for a stock replenishment). */
export interface QuickResult {
  ref: string;
  who: string;
  total: number;
  reglementLabel: string;
  ticket: TicketData | null;
}

export const emptyQuickRow: QuickRow = {
  ref: "",
  qty: 1,
  fournisseur: "",
  pourQui: "COMPTOIR",
  garageId: "",
  clientName: "",
  clientPhone: "",
  retoursImpossible: false,
  consigne: false,
  consignePrice: 0,
  clientAPris: false,
  price: "",
  reglement: "",
  mode: "",
};

/** Money typed at the counter (« 12,50 » or « 12.5 »); NaN when it is not a number. */
export function parseMoney(raw: string): number {
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

/** A garage buys on account, a counter client pays at the counter, a client PRO does either. */
export function quickReglements(pourQui: QuickPourQui): Reglement[] {
  if (pourQui === "GARAGE") return ["EN_COMPTE"];
  if (pourQui === "PRO") return ["PAYEE", "NON_PAYEE", "EN_COMPTE"];
  return ["PAYEE", "NON_PAYEE"];
}

/** Order total of a quick row: parts + consigne, rounded like the database. */
export function quickRowTotal(r: QuickRow): number {
  const unit = parseMoney(r.price);
  if (!(unit >= 0)) return 0;
  const consigne = r.consigne ? Math.max(0, r.consignePrice || 0) : 0;
  return Math.round((r.qty || 1) * (unit + consigne) * 100) / 100;
}

/** Something was typed in the row — an untouched row is simply ignored. */
export function isQuickRowFilled(r: QuickRow): boolean {
  return Boolean(r.ref.trim() || r.price.trim() || r.clientName.trim() || r.clientPhone.trim() || r.garageId);
}

/** First missing field of a row (null when the row can be created). */
export function quickRowProblem(r: QuickRow): string | null {
  if (!r.ref.trim()) return "la référence";
  if (r.pourQui === "STOCK") return r.fournisseur ? null : "le fournisseur";
  if (r.pourQui === "GARAGE" || r.pourQui === "PRO") {
    if (!r.garageId) return r.pourQui === "PRO" ? "le client PRO" : "le garage";
  } else {
    if (!r.clientName.trim()) return "le nom du client";
    if (!r.clientPhone.trim()) return "le téléphone du client";
  }
  if (!(parseMoney(r.price) > 0)) return "le prix de vente";
  if (!r.reglement) return "le règlement";
  if (r.reglement === "PAYEE" && !r.mode) return "le mode de paiement";
  return null;
}

/** Today's date in the user's local timezone (yyyy-mm-dd), not UTC. */
export function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Net unit price after the line discount, rounded to the cent (same rule as the database). */
export function netUnit(gross: number, pct?: number): number {
  const p = Math.min(100, Math.max(0, pct || 0));
  return Math.round(gross * (1 - p / 100) * 100) / 100;
}

/** Parse a money input and cap it: the cashier can never type more than due. */
export function clampMoney(raw: string, cap: number): number {
  const n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n * 100) / 100, Math.max(0, Math.round(cap * 100) / 100));
}

export function eur(value: number): string {
  return `${value.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

/** Print the ticket on screen; the tab title becomes the suggested PDF name (REQ-….pdf). */
export function printTicketDoc(ref: string) {
  const previousTitle = document.title;
  document.title = ref;
  const restore = () => {
    document.title = previousTitle;
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.print();
}
