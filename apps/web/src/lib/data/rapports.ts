import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Rapports — real business indicators for the magasin.               */
/* ------------------------------------------------------------------ */

type Embedded<T> = T | T[] | null | undefined;
function first<T>(v: Embedded<T>): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}
function arr<T>(v: Embedded<T>): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

export type MonthPoint = { key: string; label: string; ca: number; orders: number };
export type TopEntry = { name: string; isGarage?: boolean; amount: number; count: number };

export type ReportData = {
  orders: number;
  ca: number;
  encaisse: number;
  solde: number;
  /** Estimated margin: sum((prix_vente - prix_achat) × qty) on known buy prices. */
  marge: number;
  panierMoyen: number;
  retours: number;
  retoursMontant: number;
  avoirsEmis: number;
  avoirsRestant: number;
  months: MonthPoint[];
  topClients: TopEntry[];
  topFournisseurs: TopEntry[];
};

const MONTHS_BACK = 6;

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function loadReportData(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ReportData> {
  const [ordersRes, returnsRes, creditsRes, linesRes] = await Promise.all([
    supabase
      .from("orders")
      .select("id,date_commande,montant_total,montant_paye,avance_payee,solde_restant,clients(name,is_garage)")
      .eq("organization_id", orgId)
      .eq("devis", false)
      .eq("is_restock", false)
      .limit(5000),
    supabase
      .from("sales_returns")
      .select("id,montant,statut_traitement")
      .eq("organization_id", orgId)
      .limit(2000),
    supabase
      .from("credit_notes")
      .select("amount,used_amount")
      .eq("organization_id", orgId)
      .limit(2000),
    supabase
      .from("order_lines")
      .select("quantity,prix_achat_unitaire,prix_vente_unitaire,suppliers(name),orders!inner(devis,is_restock)")
      .eq("organization_id", orgId)
      .eq("orders.devis", false)
      .eq("orders.is_restock", false)
      .limit(10000),
  ]);
  for (const r of [ordersRes, returnsRes, creditsRes, linesRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  const orders = ordersRes.data ?? [];
  const ca = orders.reduce((s, o) => s + toNumber((o as Record<string, unknown>).montant_total), 0);
  const encaisse = orders.reduce(
    (s, o) =>
      s +
      toNumber((o as Record<string, unknown>).montant_paye) +
      toNumber((o as Record<string, unknown>).avance_payee),
    0,
  );
  const solde = orders.reduce(
    (s, o) => s + Math.max(0, toNumber((o as Record<string, unknown>).solde_restant)),
    0,
  );

  /* Monthly CA over the last MONTHS_BACK months */
  const months: MonthPoint[] = [];
  const now = new Date();
  for (let i = MONTHS_BACK - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: monthKey(d),
      label: d.toLocaleDateString("fr-FR", { month: "short" }).replace(".", ""),
      ca: 0,
      orders: 0,
    });
  }
  const byKey = new Map(months.map((m) => [m.key, m]));
  const clientTotals = new Map<string, TopEntry>();
  for (const raw of orders) {
    const o = raw as unknown as Record<string, unknown>;
    const date = o.date_commande ? new Date(String(o.date_commande)) : null;
    if (date && !Number.isNaN(date.getTime())) {
      const m = byKey.get(monthKey(date));
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

  /* Margin + supplier volumes from lines */
  let marge = 0;
  const supplierTotals = new Map<string, TopEntry>();
  for (const raw of linesRes.data ?? []) {
    const l = raw as unknown as Record<string, unknown>;
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

  const returns = returnsRes.data ?? [];
  const credits = creditsRes.data ?? [];

  return {
    orders: orders.length,
    ca,
    encaisse,
    solde,
    marge,
    panierMoyen: orders.length > 0 ? ca / orders.length : 0,
    retours: returns.length,
    retoursMontant: returns.reduce((s, r) => s + toNumber((r as Record<string, unknown>).montant), 0),
    avoirsEmis: credits.reduce((s, c) => s + toNumber((c as Record<string, unknown>).amount), 0),
    avoirsRestant: credits.reduce(
      (s, c) =>
        s +
        Math.max(
          0,
          toNumber((c as Record<string, unknown>).amount) - toNumber((c as Record<string, unknown>).used_amount),
        ),
      0,
    ),
    months,
    topClients: [...clientTotals.values()].sort((a, b) => b.amount - a.amount).slice(0, 6),
    topFournisseurs: [...supplierTotals.values()].sort((a, b) => b.count - a.count).slice(0, 6),
  };
}

// keep arr referenced for future extension
void arr;
