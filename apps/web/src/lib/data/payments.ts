import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Payments — every euro that moves (encaissement, règlement, remb.)  */
/* ------------------------------------------------------------------ */

export type PaymentMode = "ESPECES" | "CARTE" | "VIREMENT" | "CHEQUE";
export const PAYMENT_MODES: PaymentMode[] = ["ESPECES", "CARTE", "VIREMENT", "CHEQUE"];
export const PAYMENT_MODE_LABEL: Record<PaymentMode, string> = {
  ESPECES: "Espèces",
  CARTE: "Carte bancaire",
  VIREMENT: "Virement",
  CHEQUE: "Chèque",
};

export type PaymentKind = "ENCAISSEMENT" | "REGLEMENT_COMPTE" | "REMBOURSEMENT";
export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  ENCAISSEMENT: "Encaissement",
  REGLEMENT_COMPTE: "Règlement de compte",
  REMBOURSEMENT: "Remboursement",
};

export type Payment = {
  id: string;
  kind: PaymentKind;
  mode: PaymentMode;
  amount: number;
  reference: string | null;
  note: string | null;
  receivedAt: string;
  receivedBy: string | null;
  receivedByName: string | null;
  clientId: string | null;
  clientName: string | null;
  orderId: string | null;
  orderRef: string | null;
  /** Orders settled by this payment (règlement de compte). */
  allocations: { orderId: string; orderRef: string | null; amount: number }[];
};

type Embedded<T> = T | T[] | null | undefined;
function first<T>(v: Embedded<T>): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
function arr<T>(v: Embedded<T>): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

const PAYMENT_SELECT =
  "id,kind,mode,amount,reference,note,received_at,received_by,client_id,order_id," +
  "clients(name),orders(ref_demande)," +
  "payment_allocations(order_id,amount,orders(ref_demande))";

function mapPayment(raw: unknown, names: Map<string, string>): Payment {
  const row = raw as Record<string, unknown>;
  const client = first(row.clients as Embedded<Record<string, unknown>>);
  const order = first(row.orders as Embedded<Record<string, unknown>>);
  const receivedBy = (row.received_by as string | null) ?? null;
  return {
    id: String(row.id),
    kind: String(row.kind) as PaymentKind,
    mode: String(row.mode) as PaymentMode,
    amount: toNumber(row.amount),
    reference: (row.reference as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    receivedAt: String(row.received_at),
    receivedBy,
    receivedByName: receivedBy ? (names.get(receivedBy) ?? null) : null,
    clientId: (row.client_id as string | null) ?? null,
    clientName: client ? String(client.name ?? "") : null,
    orderId: (row.order_id as string | null) ?? null,
    orderRef: order ? String(order.ref_demande ?? "") : null,
    allocations: arr(row.payment_allocations as Embedded<Record<string, unknown>>).map((a) => {
      const o = first(a.orders as Embedded<Record<string, unknown>>);
      return {
        orderId: String(a.order_id),
        orderRef: o ? String(o.ref_demande ?? "") : null,
        amount: toNumber(a.amount),
      };
    }),
  };
}

/** display_name of the staff who received the payments (profiles are staff-readable). */
async function staffNames(
  supabase: SupabaseClient,
  orgId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return map;
  const { data } = await supabase
    .from("profiles")
    .select("user_id,display_name")
    .eq("organization_id", orgId)
    .in("user_id", unique);
  for (const raw of data ?? []) {
    const p = raw as Record<string, unknown>;
    map.set(String(p.user_id), String(p.display_name ?? ""));
  }
  return map;
}

async function finish(supabase: SupabaseClient, orgId: string, rows: unknown[], withNames: boolean) {
  const names = withNames
    ? await staffNames(
        supabase,
        orgId,
        rows.map((r) => String((r as Record<string, unknown>).received_by ?? "")),
      )
    : new Map<string, string>();
  return rows.map((r) => mapPayment(r, names));
}

/** Payments of one order (direct encaissements + allocations of account settlements). */
export async function loadOrderPayments(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<Payment[]> {
  const [directRes, allocRes] = await Promise.all([
    supabase.from("payments").select(PAYMENT_SELECT).eq("organization_id", orgId).eq("order_id", orderId),
    supabase.from("payment_allocations").select("payment_id").eq("organization_id", orgId).eq("order_id", orderId),
  ]);
  if (directRes.error) throw new Error(directRes.error.message);
  const direct = (directRes.data ?? []) as unknown[];
  const directIds = new Set(direct.map((r) => String((r as Record<string, unknown>).id)));
  const viaIds = [...new Set((allocRes.data ?? []).map((a) => String((a as Record<string, unknown>).payment_id)))].filter(
    (id) => !directIds.has(id),
  );
  let via: unknown[] = [];
  if (viaIds.length > 0) {
    const { data, error } = await supabase.from("payments").select(PAYMENT_SELECT).eq("organization_id", orgId).in("id", viaIds);
    if (error) throw new Error(error.message);
    via = (data ?? []) as unknown[];
  }
  const all = await finish(supabase, orgId, [...direct, ...via], true);
  return all.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** Payments received from one client / garage, most recent first. */
export async function loadClientPayments(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
  limit = 100,
): Promise<Payment[]> {
  const { data, error } = await supabase
    .from("payments")
    .select(PAYMENT_SELECT)
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return finish(supabase, orgId, (data ?? []) as unknown[], true);
}

/** Payments received between two instants (caisse du jour). */
export async function loadPaymentsBetween(
  supabase: SupabaseClient,
  orgId: string,
  fromIso: string,
  toIso: string,
): Promise<Payment[]> {
  const { data, error } = await supabase
    .from("payments")
    .select(PAYMENT_SELECT)
    .eq("organization_id", orgId)
    .gte("received_at", fromIso)
    .lt("received_at", toIso)
    .order("received_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return finish(supabase, orgId, (data ?? []) as unknown[], true);
}

/** Payments attached to a cash session (for the Z ticket). */
export async function loadSessionPayments(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string,
): Promise<Payment[]> {
  const { data, error } = await supabase
    .from("payments")
    .select(PAYMENT_SELECT)
    .eq("organization_id", orgId)
    .eq("session_id", sessionId)
    .order("received_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return finish(supabase, orgId, (data ?? []) as unknown[], true);
}

/* ------------------------------------------------------------------ */
/*  Mutations (RPC only — direct writes are revoked)                   */
/* ------------------------------------------------------------------ */

export async function recordOrderPayment(
  supabase: SupabaseClient,
  input: { orderId: string; amount: number; mode: PaymentMode; reference?: string; note?: string },
): Promise<string> {
  const { data, error } = await supabase.rpc("record_order_payment", {
    p_order_id: input.orderId,
    p_amount: Math.round(input.amount * 100) / 100,
    p_mode: input.mode,
    p_reference: input.reference?.trim() || null,
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export type AccountSettlement = {
  paymentId: string;
  amount: number;
  allocations: { orderId: string; ref: string; amount: number }[];
};

export async function settleClientAccount(
  supabase: SupabaseClient,
  input: {
    clientId: string;
    amount: number;
    mode: PaymentMode;
    reference?: string;
    note?: string;
    /** Restrict the FIFO allocation to these orders (optional). */
    orderIds?: string[];
  },
): Promise<AccountSettlement> {
  const { data, error } = await supabase.rpc("settle_client_account", {
    p_client_id: input.clientId,
    p_amount: Math.round(input.amount * 100) / 100,
    p_mode: input.mode,
    p_reference: input.reference?.trim() || null,
    p_note: input.note?.trim() || null,
    p_order_ids: input.orderIds && input.orderIds.length > 0 ? input.orderIds : null,
  });
  if (error) throw new Error(error.message);
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    paymentId: String(row.payment_id ?? ""),
    amount: toNumber(row.amount),
    allocations: ((row.allocations as Record<string, unknown>[] | undefined) ?? []).map((a) => ({
      orderId: String(a.order_id),
      ref: String(a.ref ?? ""),
      amount: toNumber(a.amount),
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Cash sessions (journée de caisse)                                  */
/* ------------------------------------------------------------------ */

export type CashSession = {
  id: string;
  openedAt: string;
  openedBy: string | null;
  openedByName: string | null;
  openingFloat: number;
  closedAt: string | null;
  closedBy: string | null;
  closedByName: string | null;
  expectedCash: number | null;
  countedCash: number | null;
  difference: number | null;
  note: string | null;
};

function mapSession(raw: unknown, names: Map<string, string>): CashSession {
  const r = raw as Record<string, unknown>;
  const openedBy = (r.opened_by as string | null) ?? null;
  const closedBy = (r.closed_by as string | null) ?? null;
  return {
    id: String(r.id),
    openedAt: String(r.opened_at),
    openedBy,
    openedByName: openedBy ? (names.get(openedBy) ?? null) : null,
    openingFloat: toNumber(r.opening_float),
    closedAt: (r.closed_at as string | null) ?? null,
    closedBy,
    closedByName: closedBy ? (names.get(closedBy) ?? null) : null,
    expectedCash: r.expected_cash == null ? null : toNumber(r.expected_cash),
    countedCash: r.counted_cash == null ? null : toNumber(r.counted_cash),
    difference: r.difference == null ? null : toNumber(r.difference),
    note: (r.note as string | null) ?? null,
  };
}

export async function loadCashSessions(
  supabase: SupabaseClient,
  orgId: string,
  limit = 30,
): Promise<{ open: CashSession | null; history: CashSession[] }> {
  const { data, error } = await supabase
    .from("cash_sessions")
    .select("id,opened_at,opened_by,opening_float,closed_at,closed_by,expected_cash,counted_cash,difference,note")
    .eq("organization_id", orgId)
    .order("opened_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  const names = await staffNames(
    supabase,
    orgId,
    rows.flatMap((r) => [String(r.opened_by ?? ""), String(r.closed_by ?? "")]),
  );
  const sessions = rows.map((r) => mapSession(r, names));
  return {
    open: sessions.find((s) => !s.closedAt) ?? null,
    history: sessions.filter((s) => !!s.closedAt),
  };
}

export async function openCashSession(supabase: SupabaseClient, openingFloat: number): Promise<string> {
  const { data, error } = await supabase.rpc("open_cash_session", {
    p_opening_float: Math.round(Math.max(0, openingFloat) * 100) / 100,
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export type CashClosure = {
  id: string;
  openingFloat: number;
  cashIn: number;
  cashOut: number;
  expected: number;
  counted: number;
  difference: number;
};

export async function closeCashSession(
  supabase: SupabaseClient,
  countedCash: number,
  note?: string,
): Promise<CashClosure> {
  const { data, error } = await supabase.rpc("close_cash_session", {
    p_counted_cash: Math.round(countedCash * 100) / 100,
    p_note: note?.trim() || null,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ""),
    openingFloat: toNumber(r.opening_float),
    cashIn: toNumber(r.cash_in),
    cashOut: toNumber(r.cash_out),
    expected: toNumber(r.expected),
    counted: toNumber(r.counted),
    difference: toNumber(r.difference),
  };
}

export type ModeTotals = Record<PaymentMode, number> & { total: number; refunds: number; count: number };

/** Net totals by mode for a list of payments (refunds subtract). */
export function totalsByMode(payments: Payment[]): ModeTotals {
  const out: ModeTotals = { ESPECES: 0, CARTE: 0, VIREMENT: 0, CHEQUE: 0, total: 0, refunds: 0, count: payments.length };
  for (const p of payments) {
    const sign = p.kind === "REMBOURSEMENT" ? -1 : 1;
    out[p.mode] += sign * p.amount;
    out.total += sign * p.amount;
    if (sign < 0) out.refunds += p.amount;
  }
  return out;
}

/** Local day bounds as ISO instants (yyyy-mm-dd → [start, next day)). */
export function dayBounds(ymd: string): { from: string; to: string } {
  const [y, m, d] = ymd.split("-").map(Number);
  const start = new Date(y, (m ?? 1) - 1, d ?? 1);
  const end = new Date(y, (m ?? 1) - 1, (d ?? 1) + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}
