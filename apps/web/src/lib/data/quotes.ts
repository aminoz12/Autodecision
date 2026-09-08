import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateOrderPayload } from "@/lib/types/api";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Devis particulier — a priced proposal that can become an order.   */
/*  Numbered DEV-AAAA-NNNNN by create_quote; ACCEPTE only through the  */
/*  order created from it (create_order_with_lines with quote_id).     */
/* ------------------------------------------------------------------ */

export type QuoteStatus = "EN_ATTENTE" | "ACCEPTE" | "REFUSE" | "EXPIRE";

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, { label: string; cls: string }> = {
  EN_ATTENTE: { label: "En attente", cls: "amber" },
  ACCEPTE: { label: "Accepté", cls: "green" },
  REFUSE: { label: "Refusé", cls: "red" },
  EXPIRE: { label: "Expiré", cls: "gray" },
};

/** What the counter sends to create_quote: the order payload minus payment. */
export type QuotePayload = Pick<
  CreateOrderPayload,
  | "canal_vente"
  | "client_id"
  | "client_phone"
  | "client_email"
  | "immatriculation"
  | "vehicle_model"
  | "kilometrage"
  | "lines"
  | "remise_montant"
> & {
  client_name?: string;
  /** Validity in days (default 30). */
  validity_days?: number;
  note?: string;
};

export type Quote = {
  id: string;
  ref: string;
  createdAt: string;
  clientId: string | null;
  clientName: string;
  total: number;
  status: QuoteStatus;
  validUntil: string | null;
  note: string | null;
  convertedOrderId: string | null;
  convertedOrderRef: string | null;
  payload: QuotePayload;
};

/** Status as shown: a pending quote past its validity date reads "Expiré". */
export function effectiveQuoteStatus(q: Pick<Quote, "status" | "validUntil">): QuoteStatus {
  if (q.status !== "EN_ATTENTE" || !q.validUntil) return q.status;
  const today = new Date();
  const limit = new Date(`${q.validUntil}T23:59:59`);
  return limit.getTime() < today.getTime() ? "EXPIRE" : q.status;
}

function mapQuote(raw: Record<string, unknown>, orderRefs: Map<string, string>): Quote {
  const converted = (raw.converted_order_id as string | null) ?? null;
  return {
    id: String(raw.id),
    ref: String(raw.ref ?? ""),
    createdAt: String(raw.createdAt ?? ""),
    clientId: (raw.client_id as string | null) ?? null,
    clientName: String(raw.client_name ?? "Client comptoir"),
    total: toNumber(raw.total),
    status: String(raw.status ?? "EN_ATTENTE") as QuoteStatus,
    validUntil: (raw.valid_until as string | null) ?? null,
    note: (raw.note as string | null) ?? null,
    convertedOrderId: converted,
    convertedOrderRef: converted ? (orderRefs.get(converted) ?? null) : null,
    payload: (raw.payload ?? { lines: [] }) as QuotePayload,
  };
}

const QUOTE_COLUMNS =
  "id,ref,createdAt,client_id,client_name,total,status,valid_until,note,converted_order_id,payload";

async function orderRefsFor(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  if (ids.length === 0) return refs;
  const { data } = await supabase.from("orders").select("id,ref_demande").in("id", ids);
  for (const o of (data ?? []) as Record<string, unknown>[]) {
    refs.set(String(o.id), String(o.ref_demande ?? ""));
  }
  return refs;
}

export async function loadQuotes(supabase: SupabaseClient, orgId: string): Promise<Quote[]> {
  const { data, error } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("organization_id", orgId)
    .order("createdAt", { ascending: false })
    .limit(300);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  const refs = await orderRefsFor(
    supabase,
    rows.map((r) => r.converted_order_id as string | null).filter((x): x is string => Boolean(x)),
  );
  return rows.map((r) => mapQuote(r, refs));
}

export async function loadQuote(supabase: SupabaseClient, orgId: string, id: string): Promise<Quote | null> {
  const { data, error } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const converted = row.converted_order_id as string | null;
  return mapQuote(row, await orderRefsFor(supabase, converted ? [converted] : []));
}

export async function createQuote(
  supabase: SupabaseClient,
  payload: QuotePayload,
): Promise<{ id: string; ref: string }> {
  const { data, error } = await supabase.rpc("create_quote", { p_payload: payload });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { id: string; ref: string } | null;
  if (!row?.id) throw new Error("Le devis n'a pas été créé.");
  return { id: String(row.id), ref: String(row.ref) };
}

/** Refuse a pending quote, or put a refused one back to "En attente". */
export async function setQuoteStatus(
  supabase: SupabaseClient,
  quoteId: string,
  status: "EN_ATTENTE" | "REFUSE",
): Promise<void> {
  const { error } = await supabase.rpc("set_quote_status", { p_quote_id: quoteId, p_status: status });
  if (error) throw new Error(error.message);
}
