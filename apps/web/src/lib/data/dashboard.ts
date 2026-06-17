import type { SupabaseClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ */
/*  Shared helpers for wiring the /dashboard admin pages to Supabase. */
/*  All reads are scoped to the caller's organization_id (RLS too).   */
/*  NOTE: app tables use camelCase "createdAt" (PostgREST quotes it).  */
/* ------------------------------------------------------------------ */

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Map a workflow_status enum value to a French label + badge tone. */
export function workflowLabel(status: string | null | undefined): {
  label: string;
  type: "success" | "info" | "warning";
} {
  switch (status) {
    case "DELIVERED":
      return { label: "Livré", type: "success" };
    case "IN_TRANSIT":
      return { label: "En transit", type: "info" };
    case "TO_COLLECT":
      return { label: "À collecter", type: "info" };
    case "PENDING":
    default:
      return { label: "En attente", type: "warning" };
  }
}

type EmbeddedName = { name?: string | null } | { name?: string | null }[] | null;

function embeddedName(v: EmbeddedName): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0]?.name ?? null;
  return v.name ?? null;
}

/** Normalise a phone to digits only, so "01 23 45 67 89" === "0123456789". */
function normPhone(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

export type RecentOrder = {
  id: string;
  ref: string;
  client: string;
  workflow: string;
  livraison: string | null;
};

export type PendingReception = { supplier: string; pieces: number };

export type DashboardOverview = {
  kpis: {
    commandesDuJour: number;
    commandesDuJourDelta: number; // vs yesterday
    receptionsAttendues: number;
    commandesEnAttente: number;
    retoursATraiter: number;
  };
  ordersSpark: number[]; // last 7 days order counts
  recentOrders: RecentOrder[];
  pendingReceptions: PendingReception[];
  avgRating: number | null;
  activeClients: number;
  topClient: { name: string; count: number } | null;
  returnRate: number | null; // % returns / orders
};

async function headCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
): Promise<number> {
  const { count } = await query;
  return count ?? 0;
}

export async function loadDashboardOverview(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DashboardOverview> {
  const now = new Date();
  const today = ymd(now);
  const yesterday = ymd(addDays(now, -1));
  const since30 = ymd(addDays(now, -30));

  const [
    cToday,
    cYesterday,
    cPending,
    cRecep,
    cReturns,
    cOrders,
    recentRes,
    recepRes,
    clientsRes,
    windowRes,
  ] = await Promise.all([
    headCount(
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("devis", false)
        .eq("date_commande", today),
    ),
    headCount(
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("devis", false)
        .eq("date_commande", yesterday),
    ),
    headCount(
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("devis", false)
        .eq("workflow_status", "PENDING"),
    ),
    headCount(
      supabase
        .from("order_lines")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .neq("reception_status", "RECEIVED"),
    ),
    headCount(
      supabase
        .from("sales_returns")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId),
    ),
    headCount(
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("devis", false),
    ),
    supabase
      .from("orders")
      .select(
        "id,ref_demande,workflow_status,date_envoi,date_commande,client_phone,immatriculation,clients(name)",
      )
      .eq("organization_id", orgId)
      .eq("devis", false)
      .order("createdAt", { ascending: false })
      .limit(5),
    supabase
      .from("order_lines")
      .select("quantity,depuis_magasin,suppliers(name)")
      .eq("organization_id", orgId)
      .neq("reception_status", "RECEIVED")
      .limit(1000),
    supabase
      .from("clients")
      .select("name,phone,rating,is_active")
      .eq("organization_id", orgId),
    supabase
      .from("orders")
      .select("date_commande,client_id,clients(name)")
      .eq("organization_id", orgId)
      .eq("devis", false)
      .gte("date_commande", since30),
  ]);

  // Map phone → client name, to resolve orders that store a phone but were
  // never linked to a client record (client_id is null).
  const clientByPhone = new Map<string, string>();
  for (const c of clientsRes.data ?? []) {
    const row = c as Record<string, unknown>;
    const phone = normPhone(row.phone as string | null);
    const name = row.name as string | null;
    if (phone && name) clientByPhone.set(phone, name);
  }

  // recent orders ----------------------------------------------------------
  const recentOrders: RecentOrder[] = (recentRes.data ?? []).map((o) => {
    const row = o as Record<string, unknown>;
    const phone = (row.client_phone as string | null) ?? null;
    // Surface real stored data when the order has no linked client record:
    // linked name → client matched by phone → raw phone → plate → comptoir.
    const client =
      embeddedName(row.clients as EmbeddedName) ??
      (phone ? clientByPhone.get(normPhone(phone)) : null) ??
      phone ??
      (row.immatriculation as string | null) ??
      "Client comptoir";
    return {
      id: String(row.id),
      ref: String(row.ref_demande ?? ""),
      client,
      workflow: String(row.workflow_status ?? "PENDING"),
      livraison:
        (row.date_envoi as string | null) ??
        (row.date_commande as string | null) ??
        null,
    };
  });

  // pending receptions grouped by supplier (stock lines → "Stock magasin") --
  const recMap = new Map<string, number>();
  for (const l of recepRes.data ?? []) {
    const row = l as Record<string, unknown>;
    const name =
      embeddedName(row.suppliers as EmbeddedName) ??
      (row.depuis_magasin ? "Stock magasin" : "Sans fournisseur");
    const qty = Number(row.quantity ?? 0);
    recMap.set(name, (recMap.get(name) ?? 0) + qty);
  }
  const pendingReceptions: PendingReception[] = [...recMap.entries()]
    .map(([supplier, pieces]) => ({ supplier, pieces }))
    .sort((a, b) => b.pieces - a.pieces)
    .slice(0, 6);

  // ratings ----------------------------------------------------------------
  const ratings = (clientsRes.data ?? [])
    .map((c) => (c as { rating: number | null }).rating)
    .filter((r): r is number => r !== null && r !== undefined);
  const avgRating =
    ratings.length > 0
      ? Math.round((ratings.reduce((s, r) => s + Number(r), 0) / ratings.length) * 10) / 10
      : null;
  const activeClients = (clientsRes.data ?? []).filter(
    (c) => (c as { is_active: boolean | null }).is_active !== false,
  ).length;

  // 7-day sparkline + top client (from the 30-day window) ------------------
  const spark = new Array(7).fill(0) as number[];
  const clientCounts = new Map<string, number>();
  const monthStr = today.slice(0, 7);
  for (const o of windowRes.data ?? []) {
    const row = o as Record<string, unknown>;
    const dc = String(row.date_commande ?? "");
    for (let i = 0; i < 7; i += 1) {
      if (dc === ymd(addDays(now, -(6 - i)))) spark[i] += 1;
    }
    if (dc.startsWith(monthStr)) {
      // Only count orders linked to a real client for the "top client" stat.
      const name = embeddedName(row.clients as EmbeddedName);
      if (name) clientCounts.set(name, (clientCounts.get(name) ?? 0) + 1);
    }
  }
  let topClient: { name: string; count: number } | null = null;
  for (const [name, count] of clientCounts.entries()) {
    if (!topClient || count > topClient.count) topClient = { name, count };
  }

  const returnRate =
    cOrders > 0 ? Math.round((cReturns / cOrders) * 1000) / 10 : null;

  return {
    kpis: {
      commandesDuJour: cToday,
      commandesDuJourDelta: cToday - cYesterday,
      receptionsAttendues: cRecep,
      commandesEnAttente: cPending,
      retoursATraiter: cReturns,
    },
    ordersSpark: spark,
    recentOrders,
    pendingReceptions,
    avgRating,
    activeClients,
    topClient,
    returnRate,
  };
}
