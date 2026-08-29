import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Clients particuliers — walk-in customers (is_garage = false) with  */
/*  their full history and the fidelity program.                       */
/* ------------------------------------------------------------------ */

type Embedded<T> = T | T[] | null | undefined;
function first<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}
function arr<T>(v: Embedded<T>): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/** Normalise a phone to digits only, so "06 12 34 56 78" === "0612345678". */
export function normPhone(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

/* ---- Fidelity rules (single source of truth for the UI) ---- */
export const LOYALTY = {
  /** Points earned per euro of order total (mirrors the DB trigger). */
  pointsPerEuro: 1,
  /** Indicative value when points are redeemed: 100 pts = 5 € de remise. */
  euroPer100Points: 5,
  tiers: [
    { id: "OR", label: "Or", min: 2000, cls: "gold" },
    { id: "ARGENT", label: "Argent", min: 500, cls: "silver" },
    { id: "BRONZE", label: "Bronze", min: 0, cls: "bronze" },
  ] as const,
};
export type LoyaltyTier = (typeof LOYALTY.tiers)[number];

/** Tier from lifetime earned points (redeems never demote a client). */
export function loyaltyTier(earned: number): LoyaltyTier {
  return LOYALTY.tiers.find((t) => earned >= t.min) ?? LOYALTY.tiers[LOYALTY.tiers.length - 1];
}
export function pointsValue(points: number): number {
  return Math.floor(points / 100) * LOYALTY.euroPer100Points;
}

/* ---- List ---- */

export type ClientSummary = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  plate: string | null;
  vehicle: string | null;
  active: boolean;
  createdAt: string | null;
  orders: number;
  revenue: number;
  outstanding: number;
  lastOrderAt: string | null;
  /** Current redeemable balance. */
  points: number;
  /** Lifetime earned points (drives the tier). */
  earned: number;
  tier: LoyaltyTier;
};

export async function loadParticulierClients(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ClientSummary[]> {
  const [clientsRes, ordersRes, loyaltyRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id,name,phone,email,city,immatriculation,vehicle_model,is_active,createdAt")
      .eq("organization_id", orgId)
      .eq("is_garage", false)
      .order("name")
      .limit(2000),
    supabase
      .from("orders")
      .select("client_id,montant_total,solde_restant,date_commande")
      .eq("organization_id", orgId)
      .eq("devis", false)
      .eq("is_restock", false)
      .not("client_id", "is", null)
      .limit(5000),
    supabase
      .from("loyalty_transactions")
      .select("client_id,points,kind")
      .eq("organization_id", orgId)
      .limit(10000),
  ]);
  if (clientsRes.error) throw new Error(clientsRes.error.message);
  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (loyaltyRes.error) throw new Error(loyaltyRes.error.message);

  const totals = new Map<
    string,
    { orders: number; revenue: number; outstanding: number; last: string | null }
  >();
  for (const raw of ordersRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const id = String(row.client_id ?? "");
    const cur = totals.get(id) ?? { orders: 0, revenue: 0, outstanding: 0, last: null };
    const date = (row.date_commande as string | null) ?? null;
    totals.set(id, {
      orders: cur.orders + 1,
      revenue: cur.revenue + toNumber(row.montant_total),
      outstanding: cur.outstanding + Math.max(toNumber(row.solde_restant), 0),
      last: !cur.last || (date && date > cur.last) ? date : cur.last,
    });
  }
  const loyalty = new Map<string, { points: number; earned: number }>();
  for (const raw of loyaltyRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const id = String(row.client_id ?? "");
    const pts = toNumber(row.points);
    const cur = loyalty.get(id) ?? { points: 0, earned: 0 };
    loyalty.set(id, {
      points: cur.points + pts,
      earned: cur.earned + (pts > 0 ? pts : 0),
    });
  }

  return (clientsRes.data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const id = String(row.id);
    const t = totals.get(id) ?? { orders: 0, revenue: 0, outstanding: 0, last: null };
    const l = loyalty.get(id) ?? { points: 0, earned: 0 };
    return {
      id,
      name: String(row.name ?? ""),
      phone: (row.phone as string | null) ?? null,
      email: (row.email as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      plate: (row.immatriculation as string | null) ?? null,
      vehicle: (row.vehicle_model as string | null) ?? null,
      active: row.is_active !== false,
      createdAt: (row.createdAt as string | null) ?? null,
      orders: t.orders,
      revenue: t.revenue,
      outstanding: t.outstanding,
      lastOrderAt: t.last,
      points: l.points,
      earned: l.earned,
      tier: loyaltyTier(l.earned),
    };
  });
}

/* ---- Create / update ---- */

export type ClientInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  plate?: string | null;
  vehicle?: string | null;
  notes?: string | null;
  active?: boolean;
};

function toRow(input: Partial<ClientInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name.trim();
  if (input.phone !== undefined) row.phone = input.phone?.trim() || null;
  if (input.email !== undefined) row.email = input.email?.trim() || null;
  if (input.city !== undefined) row.city = input.city?.trim() || null;
  if (input.plate !== undefined) row.immatriculation = input.plate?.trim().toUpperCase() || null;
  if (input.vehicle !== undefined) row.vehicle_model = input.vehicle?.trim() || null;
  if (input.notes !== undefined) row.notes = input.notes?.trim() || null;
  if (input.active !== undefined) row.is_active = input.active;
  return row;
}

export async function createParticulierClient(
  supabase: SupabaseClient,
  orgId: string,
  input: ClientInput,
): Promise<string> {
  if (!input.name.trim()) throw new Error("Le nom du client est obligatoire.");
  const { data, error } = await supabase
    .from("clients")
    .insert({ organization_id: orgId, is_garage: false, is_professional: false, ...toRow(input) })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return String((data as { id: string }).id);
}

export async function updateParticulierClient(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
  patch: Partial<ClientInput>,
): Promise<void> {
  const { error } = await supabase
    .from("clients")
    .update({ ...toRow(patch), updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
}

/* ---- Profile ---- */

export type ClientOrderLine = {
  id: string;
  reference: string;
  designation: string;
  quantity: number;
  unitPrice: number;
  fromStock: boolean;
  supplierName: string | null;
  status: string;
  handedOver: number;
};

export type ClientOrder = {
  id: string;
  ref: string;
  date: string | null;
  total: number;
  paid: number;
  balance: number;
  statutPaiement: string;
  workflow: string;
  plate: string | null;
  vehicle: string | null;
  kilometrage: number | null;
  lines: ClientOrderLine[];
};

export type ClientReturn = {
  id: string;
  ref: string | null;
  date: string | null;
  designation: string | null;
  reason: string;
  treatment: string | null;
  amount: number;
};

export type ClientCreditNote = {
  id: string;
  num: string | null;
  date: string | null;
  amount: number;
  used: number;
  statut: string;
  echeance: string | null;
};

export type LoyaltyTransaction = {
  id: string;
  date: string;
  kind: "EARN" | "REDEEM" | "BONUS" | "ADJUST";
  points: number;
  reason: string | null;
  orderId: string | null;
};

export type ClientProfile = ClientSummary & {
  notes: string | null;
  ordersList: ClientOrder[];
  returns: ClientReturn[];
  credits: ClientCreditNote[];
  loyalty: LoyaltyTransaction[];
  /** Parts bought, aggregated by reference (most bought first). */
  topParts: { reference: string; designation: string; quantity: number; times: number }[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadClientProfile(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
): Promise<ClientProfile | null> {
  if (!UUID_RE.test(clientId)) return null;
  const [clientRes, ordersRes, returnsRes, creditsRes, loyaltyRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id,name,phone,email,city,immatriculation,vehicle_model,is_active,notes,createdAt,is_garage")
      .eq("id", clientId)
      .eq("organization_id", orgId)
      .maybeSingle(),
    supabase
      .from("orders")
      .select(
        "id,ref_demande,date_commande,montant_total,montant_paye,solde_restant,statut_paiement,workflow_status," +
          "immatriculation,vehicle_model,kilometrage," +
          "order_lines(id,reference,nom_produit,quantity,prix_vente_unitaire,depuis_magasin,reception_status,qte_remise,suppliers(name))",
      )
      .eq("organization_id", orgId)
      .eq("client_id", clientId)
      .eq("devis", false)
      .eq("is_restock", false)
      .order("date_commande", { ascending: false })
      .limit(500),
    supabase
      .from("sales_returns")
      .select("id,ref,created_at,designation,reason,statut_traitement,montant")
      .eq("organization_id", orgId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("credit_notes")
      .select("id,num,created_at,amount,used_amount,statut,echeance")
      .eq("organization_id", orgId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("loyalty_transactions")
      .select("id,created_at,kind,points,reason,order_id")
      .eq("organization_id", orgId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  if (clientRes.error) throw new Error(clientRes.error.message);
  if (!clientRes.data) return null;
  for (const r of [ordersRes, returnsRes, creditsRes, loyaltyRes]) {
    if (r.error) throw new Error(r.error.message);
  }
  const c = clientRes.data as Record<string, unknown>;

  const ordersList: ClientOrder[] = (ordersRes.data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const lines = arr(row.order_lines as Embedded<Record<string, unknown>>).map((l) => {
      const supplier = first(l.suppliers as Embedded<Record<string, unknown>>);
      return {
        id: String(l.id),
        reference: String(l.reference ?? ""),
        designation: String(l.nom_produit ?? ""),
        quantity: toNumber(l.quantity),
        unitPrice: toNumber(l.prix_vente_unitaire),
        fromStock: Boolean(l.depuis_magasin),
        supplierName: supplier ? String(supplier.name ?? "") : null,
        status: String(l.reception_status ?? "PENDING"),
        handedOver: toNumber(l.qte_remise),
      };
    });
    return {
      id: String(row.id),
      ref: String(row.ref_demande ?? ""),
      date: (row.date_commande as string | null) ?? null,
      total: toNumber(row.montant_total),
      paid: toNumber(row.montant_paye),
      balance: toNumber(row.solde_restant),
      statutPaiement: String(row.statut_paiement ?? ""),
      workflow: String(row.workflow_status ?? "PENDING"),
      plate: (row.immatriculation as string | null) ?? null,
      vehicle: (row.vehicle_model as string | null) ?? null,
      kilometrage: row.kilometrage == null ? null : toNumber(row.kilometrage),
      lines,
    };
  });

  const parts = new Map<string, { reference: string; designation: string; quantity: number; times: number }>();
  for (const o of ordersList) {
    for (const l of o.lines) {
      const key = l.reference.trim().toUpperCase();
      const cur = parts.get(key) ?? { reference: l.reference, designation: l.designation, quantity: 0, times: 0 };
      parts.set(key, { ...cur, quantity: cur.quantity + l.quantity, times: cur.times + 1 });
    }
  }

  const loyalty: LoyaltyTransaction[] = (loyaltyRes.data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      date: String(row.created_at ?? ""),
      kind: String(row.kind ?? "ADJUST") as LoyaltyTransaction["kind"],
      points: toNumber(row.points),
      reason: (row.reason as string | null) ?? null,
      orderId: (row.order_id as string | null) ?? null,
    };
  });
  const points = loyalty.reduce((s, t) => s + t.points, 0);
  const earned = loyalty.reduce((s, t) => s + (t.points > 0 ? t.points : 0), 0);

  const revenue = ordersList.reduce((s, o) => s + o.total, 0);
  const outstanding = ordersList.reduce((s, o) => s + Math.max(o.balance, 0), 0);

  return {
    id: String(c.id),
    name: String(c.name ?? ""),
    phone: (c.phone as string | null) ?? null,
    email: (c.email as string | null) ?? null,
    city: (c.city as string | null) ?? null,
    plate: (c.immatriculation as string | null) ?? null,
    vehicle: (c.vehicle_model as string | null) ?? null,
    active: c.is_active !== false,
    createdAt: (c.createdAt as string | null) ?? null,
    notes: (c.notes as string | null) ?? null,
    orders: ordersList.length,
    revenue,
    outstanding,
    lastOrderAt: ordersList[0]?.date ?? null,
    points,
    earned,
    tier: loyaltyTier(earned),
    ordersList,
    returns: (returnsRes.data ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id),
        ref: (row.ref as string | null) ?? null,
        date: (row.created_at as string | null) ?? null,
        designation: (row.designation as string | null) ?? null,
        reason: String(row.reason ?? ""),
        treatment: (row.statut_traitement as string | null) ?? null,
        amount: toNumber(row.montant),
      };
    }),
    credits: (creditsRes.data ?? []).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id),
        num: (row.num as string | null) ?? null,
        date: (row.created_at as string | null) ?? null,
        amount: toNumber(row.amount),
        used: toNumber(row.used_amount),
        statut: String(row.statut ?? ""),
        echeance: (row.echeance as string | null) ?? null,
      };
    }),
    loyalty,
    topParts: [...parts.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
  };
}

/* ---- Fidelity actions ---- */

export async function adjustLoyaltyPoints(
  supabase: SupabaseClient,
  clientId: string,
  input: { points: number; kind: "REDEEM" | "BONUS"; reason?: string },
): Promise<number> {
  const { data, error } = await supabase.rpc("adjust_loyalty_points", {
    p_client_id: clientId,
    p_points: Math.abs(Math.floor(input.points)),
    p_kind: input.kind,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(error.message);
  return toNumber(data);
}

/* ---- Lookup used by the order form: recognise a client by phone ---- */

export type ClientMatch = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  plate: string | null;
  vehicle: string | null;
  orders: number;
  points: number;
};

export function matchClientByPhone<T extends { id: string; phone: string | null }>(
  clients: T[],
  phone: string,
): T | null {
  const p = normPhone(phone);
  if (p.length < 6) return null;
  return clients.find((c) => normPhone(c.phone) === p) ?? null;
}
