import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllPages, toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Rapports — business indicators for the magasin, computed in SQL   */
/*  (report_overview) with a browser-side fallback while the RPC is    */
/*  not deployed yet. Exports read every row through PostgREST paging. */
/* ------------------------------------------------------------------ */

type Embedded<T> = T | T[] | null | undefined;
function first<T>(v: Embedded<T>): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}

export type MonthPoint = { key: string; label: string; ca: number; orders: number };
export type TopEntry = { name: string; isGarage?: boolean; amount: number; count: number };

export type ReportRange = { from: string; to: string };

export type ReportData = {
  orders: number;
  ca: number;
  encaisse: number;
  solde: number;
  /** Discounts granted (remise en pied) over the period. */
  remises: number;
  /** Estimated margin: sum((prix_vente - prix_achat) × qty) on known buy prices. */
  marge: number;
  panierMoyen: number;
  retours: number;
  retoursMontant: number;
  avoirsEmis: number;
  avoirsRestant: number;
  /** Net cash movements per payment mode (refunds deducted). */
  paymentsByMode: { mode: string; amount: number }[];
  months: MonthPoint[];
  topClients: TopEntry[];
  topFournisseurs: TopEntry[];
  /** "sql" when computed by report_overview, "browser" for the fallback. */
  source: "sql" | "browser";
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Ready-made periods for the report header. */
export function presetRange(preset: "month" | "last_month" | "30d" | "year" | "all", now: Date = new Date()): ReportRange {
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case "month":
      return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
    case "last_month":
      return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    case "30d": {
      const from = new Date(now);
      from.setDate(from.getDate() - 29);
      return { from: ymd(from), to: ymd(now) };
    }
    case "year":
      return { from: ymd(new Date(y, 0, 1)), to: ymd(new Date(y, 11, 31)) };
    default:
      return { from: "2000-01-01", to: ymd(new Date(y + 1, 11, 31)) };
  }
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }).replace(".", "");
}

/** Every month of the range (at most 24), so the chart never has holes. */
function monthAxis(range: ReportRange): MonthPoint[] {
  const start = new Date(range.from);
  const end = new Date(range.to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  const out: MonthPoint[] = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= end && out.length < 24) {
    const key = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}`;
    out.push({ key, label: monthLabel(key), ca: 0, orders: 0 });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  // "Tout" spans decades: keep the last 24 months only.
  return out.length === 24 ? out : out;
}

function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || /could not find the function|does not exist/i.test(error.message ?? "");
}

/* ------------------------------------------------------------------ */
/*  Overview                                                          */
/* ------------------------------------------------------------------ */

export async function loadReportData(
  supabase: SupabaseClient,
  orgId: string,
  range: ReportRange,
): Promise<ReportData> {
  const { data, error } = await supabase.rpc("report_overview", { p_from: range.from, p_to: range.to });
  if (error && !isMissingFunction(error)) throw new Error(error.message);
  if (!error && data) return fromSql(data as Record<string, unknown>, range);
  return loadReportDataInBrowser(supabase, orgId, range);
}

function fromSql(j: Record<string, unknown>, range: ReportRange): ReportData {
  const totals = (j.totals ?? {}) as Record<string, unknown>;
  const months = monthAxis(range);
  const byKey = new Map(months.map((m) => [m.key, m]));
  for (const raw of (j.months as Record<string, unknown>[] | null) ?? []) {
    const key = String(raw.key);
    const m = byKey.get(key);
    if (m) {
      m.ca = toNumber(raw.ca);
      m.orders = toNumber(raw.orders);
    } else if (months.length < 24) {
      months.push({ key, label: monthLabel(key), ca: toNumber(raw.ca), orders: toNumber(raw.orders) });
    }
  }
  months.sort((a, b) => a.key.localeCompare(b.key));
  const returns = (j.returns ?? {}) as Record<string, unknown>;
  const credits = (j.credits ?? {}) as Record<string, unknown>;
  const modes = (j.payments_by_mode ?? {}) as Record<string, unknown>;
  const orders = toNumber(totals.orders);
  return {
    orders,
    ca: toNumber(totals.ca),
    encaisse: toNumber(totals.encaisse),
    solde: toNumber(totals.solde),
    remises: toNumber(totals.remises),
    marge: toNumber(totals.marge),
    panierMoyen: toNumber(totals.panier_moyen),
    retours: toNumber(returns.count),
    retoursMontant: toNumber(returns.amount),
    avoirsEmis: toNumber(credits.emis),
    avoirsRestant: toNumber(credits.restant),
    paymentsByMode: Object.entries(modes)
      .map(([mode, amount]) => ({ mode, amount: toNumber(amount) }))
      .sort((a, b) => b.amount - a.amount),
    months: months.slice(-24),
    topClients: (((j.top_clients as Record<string, unknown>[] | null) ?? []).map((c) => ({
      name: String(c.name ?? "Client comptoir"),
      isGarage: c.is_garage === true,
      amount: toNumber(c.amount),
      count: toNumber(c.count),
    })) as TopEntry[]).slice(0, 6),
    topFournisseurs: (((j.top_suppliers as Record<string, unknown>[] | null) ?? []).map((s) => ({
      name: String(s.name ?? ""),
      amount: toNumber(s.amount),
      count: toNumber(s.count),
    })) as TopEntry[]).slice(0, 6),
    source: "sql",
  };
}

/**
 * Browser fallback (pre-migration): pages through PostgREST's 1000-row cap
 * so the figures never silently freeze past that size.
 */
async function loadReportDataInBrowser(
  supabase: SupabaseClient,
  orgId: string,
  range: ReportRange,
): Promise<ReportData> {
  const [orders, returns, credits, lines, payments] = await Promise.all([
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("orders")
        .select("id,date_commande,montant_total,montant_paye,avance_payee,solde_restant,remise_montant,clients(name,is_garage)")
        .eq("organization_id", orgId)
        .eq("devis", false)
        .eq("is_restock", false)
        .is("cancelled_at", null)
        .gte("date_commande", range.from)
        .lte("date_commande", range.to)
        .order("createdAt", { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("sales_returns")
        .select("id,montant,createdAt")
        .eq("organization_id", orgId)
        .gte("createdAt", `${range.from}T00:00:00`)
        .lte("createdAt", `${range.to}T23:59:59`)
        .order("createdAt", { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("credit_notes")
        .select("amount,used_amount,created_at")
        .eq("organization_id", orgId)
        .gte("created_at", `${range.from}T00:00:00`)
        .lte("created_at", `${range.to}T23:59:59`)
        .order("created_at", { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("order_lines")
        .select("id,quantity,prix_achat_unitaire,prix_vente_unitaire,suppliers(name),orders!inner(devis,is_restock,cancelled_at,date_commande)")
        .eq("organization_id", orgId)
        .eq("orders.devis", false)
        .eq("orders.is_restock", false)
        .is("orders.cancelled_at", null)
        .gte("orders.date_commande", range.from)
        .lte("orders.date_commande", range.to)
        .order("id", { ascending: true })
        .range(from, to),
    ),
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("payments")
        .select("kind,mode,amount,received_at")
        .eq("organization_id", orgId)
        .gte("received_at", `${range.from}T00:00:00`)
        .lte("received_at", `${range.to}T23:59:59`)
        .order("received_at", { ascending: true })
        .range(from, to),
    ),
  ]);

  const ca = orders.reduce((s, o) => s + toNumber(o.montant_total), 0);
  const encaisse = orders.reduce((s, o) => s + toNumber(o.montant_paye) + toNumber(o.avance_payee), 0);
  const solde = orders.reduce((s, o) => s + Math.max(0, toNumber(o.solde_restant)), 0);
  const remises = orders.reduce((s, o) => s + toNumber(o.remise_montant), 0);

  const months = monthAxis(range);
  const byKey = new Map(months.map((m) => [m.key, m]));
  const clientTotals = new Map<string, TopEntry>();
  for (const o of orders) {
    const date = o.date_commande ? new Date(String(o.date_commande)) : null;
    if (date && !Number.isNaN(date.getTime())) {
      const m = byKey.get(`${date.getFullYear()}-${pad(date.getMonth() + 1)}`);
      if (m) {
        m.ca += toNumber(o.montant_total);
        m.orders += 1;
      }
    }
    const client = first(o.clients as Embedded<Record<string, unknown>>);
    const name = String(client?.name ?? "Client comptoir");
    const cur = clientTotals.get(name) ?? { name, isGarage: client?.is_garage === true, amount: 0, count: 0 };
    cur.amount += toNumber(o.montant_total);
    cur.count += 1;
    clientTotals.set(name, cur);
  }

  let marge = 0;
  const supplierTotals = new Map<string, TopEntry>();
  for (const l of lines) {
    const qty = toNumber(l.quantity);
    const pv = toNumber(l.prix_vente_unitaire);
    const pa = toNumber(l.prix_achat_unitaire);
    if (pa > 0 && pv > 0) marge += qty * (pv - pa);
    const supplier = first(l.suppliers as Embedded<Record<string, unknown>>);
    if (supplier?.name) {
      const name = String(supplier.name);
      const cur = supplierTotals.get(name) ?? { name, amount: 0, count: 0 };
      cur.amount += qty * pv;
      cur.count += qty;
      supplierTotals.set(name, cur);
    }
  }

  const modes = new Map<string, number>();
  for (const p of payments) {
    const mode = String(p.mode ?? "");
    const signed = String(p.kind) === "REMBOURSEMENT" ? -toNumber(p.amount) : toNumber(p.amount);
    modes.set(mode, (modes.get(mode) ?? 0) + signed);
  }

  return {
    orders: orders.length,
    ca,
    encaisse,
    solde,
    remises,
    marge,
    panierMoyen: orders.length > 0 ? ca / orders.length : 0,
    retours: returns.length,
    retoursMontant: returns.reduce((s, r) => s + toNumber(r.montant), 0),
    avoirsEmis: credits.reduce((s, c) => s + toNumber(c.amount), 0),
    avoirsRestant: credits.reduce((s, c) => s + Math.max(0, toNumber(c.amount) - toNumber(c.used_amount)), 0),
    paymentsByMode: [...modes.entries()].map(([mode, amount]) => ({ mode, amount })).sort((a, b) => b.amount - a.amount),
    months: months.slice(-24),
    topClients: [...clientTotals.values()].sort((a, b) => b.amount - a.amount).slice(0, 6),
    topFournisseurs: [...supplierTotals.values()].sort((a, b) => b.count - a.count).slice(0, 6),
    source: "browser",
  };
}

/* ------------------------------------------------------------------ */
/*  CSV exports                                                       */
/* ------------------------------------------------------------------ */

export type CsvRow = Record<string, string | number | boolean | null | undefined>;

/** Excel-friendly CSV: UTF-8 BOM, semicolon separator, decimal comma. */
export function toCsv(rows: CsvRow[], columns: { key: string; label: string }[]): string {
  const esc = (v: unknown): string => {
    if (v == null) return "";
    if (typeof v === "number") return v.toLocaleString("fr-FR", { useGrouping: false, maximumFractionDigits: 2 });
    if (typeof v === "boolean") return v ? "oui" : "non";
    const s = String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(";");
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(";"));
  return `﻿${[head, ...body].join("\r\n")}`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const SALES_COLUMNS = [
  { key: "ref", label: "N° commande" },
  { key: "date_commande", label: "Date" },
  { key: "client", label: "Client" },
  { key: "is_garage", label: "Garage" },
  { key: "canal", label: "Canal" },
  { key: "mode_paiement", label: "Mode de paiement" },
  { key: "statut_paiement", label: "Statut paiement" },
  { key: "montant_total", label: "Total TTC" },
  { key: "remise_montant", label: "Remise" },
  { key: "montant_paye", label: "Payé" },
  { key: "solde_restant", label: "Reste dû" },
  { key: "avoir_applique", label: "Avoir utilisé" },
  { key: "workflow_status", label: "Livraison" },
  { key: "cancelled_at", label: "Annulée le" },
  { key: "facture", label: "Facture" },
];

export const LINE_COLUMNS = [
  { key: "ref", label: "N° commande" },
  { key: "date_commande", label: "Date" },
  { key: "client", label: "Client" },
  { key: "reference", label: "Référence" },
  { key: "designation", label: "Désignation" },
  { key: "fournisseur", label: "Fournisseur" },
  { key: "depuis_magasin", label: "Stock magasin" },
  { key: "quantity", label: "Qté" },
  { key: "prix_achat_unitaire", label: "PA unitaire" },
  { key: "prix_brut_unitaire", label: "PV brut" },
  { key: "remise_pct", label: "Remise %" },
  { key: "prix_vente_unitaire", label: "PV net" },
  { key: "total_ligne", label: "Total ligne" },
  { key: "reception_status", label: "Réception" },
  { key: "cancelled", label: "Commande annulée" },
];

/** One row per order (SQL RPC, with a PostgREST fallback pre-migration). */
export async function loadSalesRows(supabase: SupabaseClient, orgId: string, range: ReportRange): Promise<CsvRow[]> {
  const { data, error } = await supabase.rpc("report_sales_rows", { p_from: range.from, p_to: range.to });
  if (!error) return (data ?? []) as CsvRow[];
  if (!isMissingFunction(error)) throw new Error(error.message);
  const rows = await fetchAllPages<Record<string, unknown>>((from, to) =>
    supabase
      .from("orders")
      .select("ref_demande,date_commande,canal_vente,mode_paiement,statut_paiement,montant_total,remise_montant,montant_paye,avance_payee,solde_restant,avoir_applique,workflow_status,cancelled_at,clients(name,is_garage)")
      .eq("organization_id", orgId)
      .eq("devis", false)
      .eq("is_restock", false)
      .gte("date_commande", range.from)
      .lte("date_commande", range.to)
      .order("date_commande", { ascending: true })
      .range(from, to),
  );
  return rows.map((o) => {
    const client = first(o.clients as Embedded<Record<string, unknown>>);
    return {
      ref: String(o.ref_demande ?? ""),
      date_commande: String(o.date_commande ?? ""),
      client: String(client?.name ?? "Client comptoir"),
      is_garage: client?.is_garage === true,
      canal: String(o.canal_vente ?? ""),
      mode_paiement: (o.mode_paiement as string | null) ?? "",
      statut_paiement: String(o.statut_paiement ?? ""),
      montant_total: toNumber(o.montant_total),
      remise_montant: toNumber(o.remise_montant),
      montant_paye: toNumber(o.montant_paye) + toNumber(o.avance_payee),
      solde_restant: toNumber(o.solde_restant),
      avoir_applique: toNumber(o.avoir_applique),
      workflow_status: String(o.workflow_status ?? ""),
      cancelled_at: (o.cancelled_at as string | null) ?? "",
      facture: "",
    };
  });
}

/** One row per order line (SQL RPC, with a PostgREST fallback pre-migration). */
export async function loadLineRows(supabase: SupabaseClient, orgId: string, range: ReportRange): Promise<CsvRow[]> {
  const { data, error } = await supabase.rpc("report_line_rows", { p_from: range.from, p_to: range.to });
  if (!error) return (data ?? []) as CsvRow[];
  if (!isMissingFunction(error)) throw new Error(error.message);
  const rows = await fetchAllPages<Record<string, unknown>>((from, to) =>
    supabase
      .from("order_lines")
      .select("reference,nom_produit,depuis_magasin,quantity,prix_achat_unitaire,prix_brut_unitaire,remise_pct,prix_vente_unitaire,reception_status,suppliers(name),orders!inner(ref_demande,date_commande,devis,is_restock,cancelled_at,clients(name))")
      .eq("organization_id", orgId)
      .eq("orders.devis", false)
      .eq("orders.is_restock", false)
      .gte("orders.date_commande", range.from)
      .lte("orders.date_commande", range.to)
      .order("id", { ascending: true })
      .range(from, to),
  );
  return rows.map((l) => {
    const order = first(l.orders as Embedded<Record<string, unknown>>);
    const client = first(order?.clients as Embedded<Record<string, unknown>>);
    const supplier = first(l.suppliers as Embedded<Record<string, unknown>>);
    const pv = toNumber(l.prix_vente_unitaire);
    return {
      ref: String(order?.ref_demande ?? ""),
      date_commande: String(order?.date_commande ?? ""),
      client: String(client?.name ?? "Client comptoir"),
      reference: String(l.reference ?? ""),
      designation: String(l.nom_produit ?? ""),
      fournisseur: (supplier?.name as string | null) ?? "",
      depuis_magasin: Boolean(l.depuis_magasin),
      quantity: toNumber(l.quantity),
      prix_achat_unitaire: toNumber(l.prix_achat_unitaire),
      prix_brut_unitaire: l.prix_brut_unitaire == null ? pv : toNumber(l.prix_brut_unitaire),
      remise_pct: toNumber(l.remise_pct),
      prix_vente_unitaire: pv,
      total_ligne: toNumber(l.quantity) * pv,
      reception_status: String(l.reception_status ?? ""),
      cancelled: order?.cancelled_at != null,
    };
  });
}
