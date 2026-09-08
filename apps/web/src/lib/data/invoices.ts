import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Invoices — immutable snapshots emitted from orders / credit notes  */
/* ------------------------------------------------------------------ */

export type InvoiceKind = "FACTURE" | "AVOIR";

export type InvoiceParty = {
  name: string;
  legalName?: string | null;
  legalForm?: string | null;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  email?: string | null;
  siret?: string | null;
  tvaIntra?: string | null;
  rcs?: string | null;
  capital?: string | null;
  iban?: string | null;
  bic?: string | null;
  logoUrl?: string | null;
  invoiceFooter?: string | null;
  isGarage?: boolean;
  immatriculation?: string | null;
  vehicleModel?: string | null;
};

export type InvoiceLine = {
  reference: string;
  designation: string;
  quantity: number;
  unitTtc: number;
  unitHt: number;
  tvaRate: number;
  totalHt: number;
  totalTva: number;
  totalTtc: number;
  /** Line discount in percent (0 when none). */
  remisePct: number;
  /** Gross unit price TTC before the line discount. */
  unitBrutTtc: number;
};

export type InvoiceTotals = {
  ht: number;
  tva: number;
  ttc: number;
  byRate: { rate: number; ht: number; tva: number }[];
  orderTotal: number | null;
  avoirApplique: number;
  paid: number;
  due: number;
};

export type Invoice = {
  id: string;
  number: string;
  kind: InvoiceKind;
  issuedAt: string;
  orderId: string | null;
  orderRef: string | null;
  clientId: string | null;
  creditNoteId: string | null;
  relatedInvoiceNumber: string | null;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  dueDate: string | null;
  paymentTerms: string | null;
  modePaiement: string | null;
  note: string | null;
  contentHash: string;
};

type Embedded<T> = T | T[] | null | undefined;
function first<T>(v: Embedded<T>): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

function party(raw: unknown): InvoiceParty {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    name: String(p.name ?? ""),
    legalName: str(p.legal_name),
    legalForm: str(p.legal_form),
    address: str(p.address),
    city: str(p.city),
    phone: str(p.phone),
    email: str(p.email),
    siret: str(p.siret),
    tvaIntra: str(p.tva_intra),
    rcs: str(p.rcs),
    capital: str(p.capital),
    iban: str(p.iban),
    bic: str(p.bic),
    logoUrl: str(p.logo_url),
    invoiceFooter: str(p.invoice_footer),
    isGarage: Boolean(p.is_garage),
    immatriculation: str(p.immatriculation),
    vehicleModel: str(p.vehicle_model),
  };
}

function totals(raw: unknown): InvoiceTotals {
  const t = (raw ?? {}) as Record<string, unknown>;
  const byRateRaw = (t.by_rate ?? {}) as Record<string, { ht?: unknown; tva?: unknown }>;
  const byRate = Object.entries(byRateRaw)
    .map(([rate, v]) => ({ rate: Number(rate), ht: toNumber(v?.ht), tva: toNumber(v?.tva) }))
    .sort((a, b) => b.rate - a.rate);
  return {
    ht: toNumber(t.ht),
    tva: toNumber(t.tva),
    ttc: toNumber(t.ttc),
    byRate,
    orderTotal: t.order_total == null ? null : toNumber(t.order_total),
    avoirApplique: toNumber(t.avoir_applique),
    paid: toNumber(t.paid),
    due: toNumber(t.due),
  };
}

const INVOICE_SELECT =
  "id,number,kind,issued_at,order_id,client_id,credit_note_id,seller,buyer,lines,totals,due_date,payment_terms,mode_paiement,note,content_hash," +
  "orders(ref_demande),related:related_invoice_id(number)";

function mapInvoice(raw: unknown): Invoice {
  const r = raw as Record<string, unknown>;
  const order = first(r.orders as Embedded<Record<string, unknown>>);
  const related = first(r.related as Embedded<Record<string, unknown>>);
  const lines = ((r.lines as Record<string, unknown>[] | null) ?? []).map((l) => ({
    reference: String(l.reference ?? ""),
    designation: String(l.designation ?? ""),
    quantity: toNumber(l.quantity),
    unitTtc: toNumber(l.unit_ttc),
    unitHt: toNumber(l.unit_ht),
    tvaRate: toNumber(l.tva_rate),
    totalHt: toNumber(l.total_ht),
    totalTva: toNumber(l.total_tva),
    totalTtc: toNumber(l.total_ttc),
    remisePct: toNumber(l.remise_pct),
    unitBrutTtc: l.unit_brut_ttc == null ? toNumber(l.unit_ttc) : toNumber(l.unit_brut_ttc),
  }));
  return {
    id: String(r.id),
    number: String(r.number),
    kind: (String(r.kind) as InvoiceKind) ?? "FACTURE",
    issuedAt: String(r.issued_at),
    orderId: str(r.order_id),
    orderRef: order ? str(order.ref_demande) : null,
    clientId: str(r.client_id),
    creditNoteId: str(r.credit_note_id),
    relatedInvoiceNumber: related ? str(related.number) : null,
    seller: party(r.seller),
    buyer: party(r.buyer),
    lines,
    totals: totals(r.totals),
    dueDate: str(r.due_date),
    paymentTerms: str(r.payment_terms),
    modePaiement: str(r.mode_paiement),
    note: str(r.note),
    contentHash: String(r.content_hash ?? ""),
  };
}

export async function loadInvoice(supabase: SupabaseClient, id: string): Promise<Invoice | null> {
  const { data, error } = await supabase.from("invoices").select(INVOICE_SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapInvoice(data) : null;
}

export async function loadOrderInvoice(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<Invoice | null> {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("organization_id", orgId)
    .eq("order_id", orderId)
    .eq("kind", "FACTURE")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapInvoice(data) : null;
}

/** Invoices of the organisation, most recent first (optionally one month yyyy-mm). */
export async function loadInvoices(
  supabase: SupabaseClient,
  orgId: string,
  opts: { month?: string; clientId?: string; limit?: number } = {},
): Promise<Invoice[]> {
  let q = supabase
    .from("invoices")
    .select(INVOICE_SELECT)
    .eq("organization_id", orgId)
    .order("issued_at", { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.clientId) q = q.eq("client_id", opts.clientId);
  if (opts.month) {
    const [y, m] = opts.month.split("-").map(Number);
    const from = new Date(y, m - 1, 1).toISOString();
    const to = new Date(y, m, 1).toISOString();
    q = q.gte("issued_at", from).lt("issued_at", to);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapInvoice);
}

export async function emitInvoice(supabase: SupabaseClient, orderId: string): Promise<string> {
  const { data, error } = await supabase.rpc("emit_invoice", { p_order_id: orderId });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function emitCreditNoteDocument(supabase: SupabaseClient, creditNoteId: string): Promise<string> {
  const { data, error } = await supabase.rpc("emit_credit_note_document", { p_credit_note_id: creditNoteId });
  if (error) throw new Error(error.message);
  return String(data);
}

/** Legal mention printed on B2B invoices (art. L441-10 Code de commerce). */
export const LATE_PAYMENT_MENTION =
  "En cas de retard de paiement, une pénalité égale à trois fois le taux d'intérêt légal sera appliquée, ainsi qu'une indemnité forfaitaire pour frais de recouvrement de 40 € (art. L441-10 et D441-5 du Code de commerce). Pas d'escompte pour paiement anticipé.";
