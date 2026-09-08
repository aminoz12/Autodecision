import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";
import { createOrderWithLines } from "@/lib/data/orders";
import type { CreateOrderPayload } from "@/lib/types/api";

/** Today's date in the local timezone (yyyy-mm-dd), not UTC. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Embedded<T> = T | T[] | null | undefined;
function arr<T>(v: Embedded<T>): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

/* ------------------------------------------------------------------ */
/*  The garage (client) record of the logged-in garagiste             */
/* ------------------------------------------------------------------ */

export type GarageInfo = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  /** Days granted to settle an on-account order (7/10/15/30). */
  paymentTermsDays: number;
};

export async function loadGarageInfo(
  supabase: SupabaseClient,
  clientId: string,
): Promise<GarageInfo | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("id,name,phone,email,city,payment_terms_days")
    .eq("id", clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    paymentTermsDays:
      row.payment_terms_days == null ? 30 : toNumber(row.payment_terms_days),
  };
}

/* ------------------------------------------------------------------ */
/*  Orders                                                            */
/* ------------------------------------------------------------------ */

export type GarageOrderLine = {
  id: string;
  reference: string;
  designation: string;
  quantity: number;
  status: string;
  /** Magasin's devis answer: null = pending, true = available, false = no. */
  disponible: boolean | null;
  /** Part flagged non-returnable by the magasin: no return allowed. */
  retourImpossible: boolean;
  unitPrice: number;
  lineTotal: number;
};

export type GarageOrder = {
  id: string;
  ref: string;
  date: string | null;
  deliveryAt: string | null;
  workflow: string;
  devis: boolean;
  devisStatus: string | null;
  total: number;
  paid: number;
  balance: number;
  /** ESPECES / CARTE / VIREMENT / CHEQUE / EN_COMPTE (null on old rows). */
  modePaiement: string | null;
  /** Due date of an on-account order (yyyy-mm-dd). */
  echeance: string | null;
  lines: GarageOrderLine[];
};

export async function loadGarageOrders(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
): Promise<GarageOrder[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id,ref_demande,date_commande,date_envoi,workflow_status,devis,devis_status,montant_total,montant_paye,solde_restant,mode_paiement,echeance",
    )
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .order("createdAt", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);

  // Lines come from the garage_order_lines view: the garagiste never sees
  // the purchase price or the supplier (RLS on order_lines is staff-only).
  const orderIds = (data ?? []).map((o) => String((o as Record<string, unknown>).id));
  const linesByOrder = new Map<string, Record<string, unknown>[]>();
  if (orderIds.length > 0) {
    const { data: lineRows, error: lErr } = await supabase
      .from("garage_order_lines")
      .select("id,order_id,reference,nom_produit,quantity,reception_status,disponible,retour_impossible,prix_vente_unitaire")
      .in("order_id", orderIds)
      .limit(5000);
    if (lErr) throw new Error(lErr.message);
    for (const raw of lineRows ?? []) {
      const l = raw as Record<string, unknown>;
      const key = String(l.order_id);
      const bucket = linesByOrder.get(key) ?? [];
      bucket.push(l);
      linesByOrder.set(key, bucket);
    }
  }

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const lines = (linesByOrder.get(String(row.id)) ?? []).map(
      (l) => {
        const qty = toNumber(l.quantity);
        const pv = toNumber(l.prix_vente_unitaire);
        return {
          id: String(l.id),
          reference: String(l.reference ?? ""),
          designation: String(l.nom_produit ?? ""),
          quantity: qty,
          status: String(l.reception_status ?? "PENDING"),
          disponible:
            l.disponible === null || l.disponible === undefined
              ? null
              : Boolean(l.disponible),
          retourImpossible: Boolean(l.retour_impossible),
          unitPrice: pv,
          lineTotal: qty * pv,
        };
      },
    );
    return {
      id: String(row.id),
      ref: String(row.ref_demande ?? ""),
      date: (row.date_commande as string | null) ?? null,
      deliveryAt: (row.date_envoi as string | null) ?? null,
      workflow: String(row.workflow_status ?? "PENDING"),
      devis: Boolean(row.devis),
      devisStatus: (row.devis_status as string | null) ?? null,
      total: toNumber(row.montant_total),
      paid: toNumber(row.montant_paye),
      balance: toNumber(row.solde_restant),
      modePaiement: (row.mode_paiement as string | null) ?? null,
      echeance: (row.echeance as string | null) ?? null,
      lines,
    };
  });
}

export type NewOrderLine = { nom_produit: string; reference: string; quantity: number };

export async function createGarageOrder(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  clientId: string,
  input: {
    phone: string | null;
    immatriculation?: string;
    vehicle?: string;
    note?: string;
    lines: NewOrderLine[];
  },
) {
  const payload: CreateOrderPayload = {
    date_commande: localToday(),
    canal_vente: "B2B",
    client_id: clientId,
    client_phone: input.phone?.trim() || "-",
    immatriculation: input.immatriculation?.trim() || undefined,
    vehicle_model: input.vehicle?.trim() || undefined,
    consigne: input.note?.trim() || undefined,
    // The garagiste requests parts; the magasin sets prices and sourcing.
    lines: input.lines.map((l) => ({
      nom_produit: l.nom_produit.trim(),
      reference: l.reference.trim(),
      quantity: l.quantity || 1,
      a_commander_pour_livreur: false,
      depuis_magasin: false,
      prix_achat_unitaire: 0,
      prix_vente_unitaire: 0,
    })),
    devis: true,
    devis_status: "REQUESTED",
    statut_paiement: "NON_PAYÉ",
    montant_paye: 0,
    avance_payee: 0,
    envoyer_au_livreur: false,
    statut_livreur: "EN_ATTENTE",
    bl: false,
  };
  return createOrderWithLines(supabase, userId, orgId, payload);
}

/** Garagiste accepts a quoted devis → it becomes a confirmed order. */
/* Legacy browser-side quote mutations retained for migration context only.
export async function acceptDevisOrderLegacy(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<void> {
  // Total = available lines only.
  const { data: lines, error: lErr } = await supabase
    .from("order_lines")
    .select("quantity,prix_vente_unitaire,disponible")
    .eq("order_id", orderId)
    .eq("organization_id", orgId);
  if (lErr) throw new Error(lErr.message);

  const total = (lines ?? []).reduce((s, raw) => {
    const l = raw as Record<string, unknown>;
    if (l.disponible === false) return s;
    return s + toNumber(l.quantity) * toNumber(l.prix_vente_unitaire);
  }, 0);

  const { error } = await supabase
    .from("orders")
    .update({
      devis: false,
      devis_status: "ACCEPTED",
      montant_total: total,
      solde_restant: total,
      envoyer_au_livreur: true,
      workflow_status: "TO_COLLECT",
    })
    .eq("id", orderId)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);

  // Now that it's confirmed, schedule it into a tournée + delivery task.
  await assignOrderTournee(supabase, orgId, orderId);
  await supabase
    .from("delivery_tasks")
    .insert({ organization_id: orgId, order_id: orderId, workflow_status: "TO_COLLECT" });
}

*/

export async function acceptDevisOrder(
  supabase: SupabaseClient,
  _orgId: string,
  orderId: string,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_garage_quote", {
    p_order_id: orderId,
    p_action: "ACCEPT",
  });
  if (error) throw new Error(error.message);
}

/** Garagiste refuses a quoted devis. */
export async function refuseDevisOrder(
  supabase: SupabaseClient,
  _orgId: string,
  orderId: string,
): Promise<void> {
  const { error } = await supabase.rpc("resolve_garage_quote", {
    p_order_id: orderId,
    p_action: "REFUSE",
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Returns                                                           */
/* ------------------------------------------------------------------ */

export type GarageReturn = {
  id: string;
  ref: string;
  createdAt: string | null;
  designation: string;
  reason: string;
  status: string;
  orderRef: string | null;
};

export async function loadGarageReturns(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
): Promise<GarageReturn[]> {
  const { data, error } = await supabase
    .from("sales_returns")
    .select(
      "id,ref,created_at,designation,reason,motif,statut_traitement,orders(ref_demande)",
    )
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const order = arr(row.orders as Embedded<Record<string, unknown>>)[0];
    return {
      id: String(row.id),
      ref: String(row.ref ?? `RET-${String(row.id).slice(0, 8)}`),
      createdAt: (row.created_at as string | null) ?? null,
      designation: String(row.designation ?? row.motif ?? "-"),
      reason: String(row.reason ?? row.motif ?? "-"),
      status: String(row.statut_traitement ?? "A_TRAITER"),
      orderRef: order ? String(order.ref_demande ?? "") : null,
    };
  });
}

export async function createGarageReturn(
  supabase: SupabaseClient,
  _orgId: string,
  _clientId: string,
  input: { orderId?: string | null; designation: string; reason: string },
): Promise<void> {
  const { error } = await supabase.rpc("request_garage_return", {
    p_order_id: input.orderId || null,
    p_designation: input.designation,
    p_reason: input.reason,
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Magasin side: garagiste devis requests                            */
/* ------------------------------------------------------------------ */

export type DevisRequestLine = {
  id: string;
  reference: string;
  designation: string;
  quantity: number;
  disponible: boolean | null;
  unitPrice: number;
};

export type DevisRequest = {
  id: string;
  ref: string;
  date: string | null;
  status: string;
  garageId: string | null;
  garageName: string;
  lines: DevisRequestLine[];
};

export async function loadGarageRequests(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DevisRequest[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id,ref_demande,date_commande,devis_status,client_id,clients(name)," +
        "order_lines(id,reference,nom_produit,quantity,disponible,prix_vente_unitaire)",
    )
    .eq("organization_id", orgId)
    .eq("devis", true)
    .in("devis_status", ["REQUESTED", "QUOTED"])
    .order("createdAt", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const client = arr(row.clients as Embedded<Record<string, unknown>>)[0];
    const lines = arr(row.order_lines as Embedded<Record<string, unknown>>).map((l) => ({
      id: String(l.id),
      reference: String(l.reference ?? ""),
      designation: String(l.nom_produit ?? ""),
      quantity: toNumber(l.quantity),
      disponible:
        l.disponible === null || l.disponible === undefined ? null : Boolean(l.disponible),
      unitPrice: toNumber(l.prix_vente_unitaire),
    }));
    return {
      id: String(row.id),
      ref: String(row.ref_demande ?? ""),
      date: (row.date_commande as string | null) ?? null,
      status: String(row.devis_status ?? "REQUESTED"),
      garageId: (row.client_id as string | null) ?? null,
      garageName: String(client?.name ?? "Garage"),
      lines,
    };
  });
}

export type DevisLineResponse = { lineId: string; disponible: boolean; unitPrice: number };

/** Magasin answers a devis: per-line availability + price, status → QUOTED.
 *  One atomic RPC: a failure leaves nothing half-priced. */
export async function respondDevis(
  supabase: SupabaseClient,
  _orgId: string,
  orderId: string,
  responses: DevisLineResponse[],
): Promise<void> {
  const { error } = await supabase.rpc("respond_garage_quote", {
    p_order_id: orderId,
    p_responses: responses.map((r) => ({
      line_id: r.lineId,
      disponible: r.disponible,
      unit_price: r.disponible ? r.unitPrice : 0,
    })),
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Labels                                                            */
/* ------------------------------------------------------------------ */

export const DEVIS_LABEL: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: "Devis demandé", cls: "amber" },
  QUOTED: { label: "Devis reçu", cls: "blue" },
  ACCEPTED: { label: "Accepté", cls: "green" },
  REFUSED: { label: "Refusé", cls: "red" },
};

export const WORKFLOW_LABEL: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "En attente de réception", cls: "amber" },
  TO_COLLECT: { label: "En préparation", cls: "blue" },
  IN_TRANSIT: { label: "En cours de livraison", cls: "violet" },
  DELIVERED: { label: "Livrée", cls: "green" },
};

/**
 * What the garagiste sees for a confirmed order (devis = false):
 *   AWAITING_RECEPTION — the magasin still waits for supplier parts
 *   PREPARING          — every part is in the magasin, order being prepared
 *   IN_DELIVERY        — handed to a livreur
 *   DELIVERED          — done
 * Lines the magasin answered "non disponible" (NOT_RECEIVED) never arrive,
 * so they do not hold the order back.
 */
export type GarageStage = "AWAITING_RECEPTION" | "PREPARING" | "IN_DELIVERY" | "DELIVERED";

export const GARAGE_STAGE_LABEL: Record<GarageStage, { label: string; cls: string }> = {
  AWAITING_RECEPTION: { label: "Commande en attente de réception", cls: "amber" },
  PREPARING: { label: "Commande en préparation", cls: "blue" },
  IN_DELIVERY: { label: "Commande en cours de livraison", cls: "violet" },
  DELIVERED: { label: "Commande livrée", cls: "green" },
};

export function garageStage(
  order: Pick<GarageOrder, "workflow" | "lines">,
): GarageStage {
  if (order.workflow === "DELIVERED") return "DELIVERED";
  if (order.workflow === "IN_TRANSIT") return "IN_DELIVERY";
  const awaited = order.lines.filter(
    (l) => l.status === "PENDING" || l.status === "BACKORDER" || l.status === "PARTIAL",
  );
  return awaited.length > 0 ? "AWAITING_RECEPTION" : "PREPARING";
}

export const RETURN_LABEL: Record<string, { label: string; cls: string }> = {
  A_TRAITER: { label: "À traiter", cls: "amber" },
  DEMANDE_ENVOYEE: { label: "Demande envoyée", cls: "blue" },
  A_RECUPERER: { label: "À récupérer", cls: "blue" },
  ACCEPTE: { label: "Accepté", cls: "green" },
  REFUSE: { label: "Refusé", cls: "red" },
};

/* ------------------------------------------------------------------ */
/*  Garage account: open avoirs + monthly statement                   */
/* ------------------------------------------------------------------ */

export type GarageCredit = {
  id: string;
  num: string;
  createdAt: string | null;
  dueAt: string | null;
  amount: number;
  /** What is still usable on the avoir. */
  remaining: number;
};

/** Open avoirs of the garage (credit notes not yet fully consumed). */
export async function loadGarageCredits(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
): Promise<GarageCredit[]> {
  const { data, error } = await supabase
    .from("credit_notes")
    .select("id,num,amount,used_amount,created_at,echeance,statut")
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .in("statut", ["EN_COURS", "PARTIEL"])
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      const amount = toNumber(row.amount);
      return {
        id: String(row.id),
        num: String(row.num ?? `AV-${String(row.id).slice(0, 8)}`),
        createdAt: (row.created_at as string | null) ?? null,
        dueAt: (row.echeance as string | null) ?? null,
        amount,
        remaining: Math.max(0, amount - toNumber(row.used_amount)),
      };
    })
    .filter((c) => c.remaining > 0);
}

export type GarageStatement = {
  /** Confirmed orders (devis accepted or placed directly by the magasin). */
  orderCount: number;
  /** Quote requests still open or refused (not yet orders). */
  devisCount: number;
  returnCount: number;
  /** First/last day of the current month, yyyy-mm-dd. */
  periodStart: string;
  periodEnd: string;
  /** "du 1 au 30 septembre 2026" */
  periodLabel: string;
  /** Unpaid balance of the orders placed this month. */
  currentMonth: number;
  /** Unpaid balance carried from earlier months. */
  carriedOver: number;
  /** Unpaid balance already past its due date (subset of the above). */
  overdue: number;
  /** Open avoirs, deducted from what the garage owes. */
  credits: number;
  /** currentMonth + carriedOver − credits (negative = the magasin owes the garage). */
  balance: number;
  /** Orders of the current month, most recent first. */
  monthOrders: GarageOrder[];
  /** Earlier orders still carrying a balance. */
  openOlderOrders: GarageOrder[];
};

function ymd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Build the garage statement the garagiste sees: how many orders / quotes /
 * returns, what is open this month, what is carried over, the avoirs, and the
 * resulting account balance. Pure function so it is easy to test.
 */
export function buildGarageStatement(
  orders: GarageOrder[],
  credits: GarageCredit[],
  returnCount: number,
  now: Date = new Date(),
): GarageStatement {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const periodStart = ymd(start);
  const periodEnd = ymd(end);
  const today = ymd(now);
  const monthName = start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });

  const confirmed = orders.filter((o) => !o.devis);
  const inMonth = (o: GarageOrder) => {
    const d = (o.date ?? "").slice(0, 10);
    return d >= periodStart && d <= periodEnd;
  };
  const monthOrders = confirmed.filter(inMonth);
  const olderOpen = confirmed.filter((o) => !inMonth(o) && o.balance > 0);

  const currentMonth = monthOrders.reduce((s, o) => s + Math.max(0, o.balance), 0);
  const carriedOver = olderOpen.reduce((s, o) => s + Math.max(0, o.balance), 0);
  const overdue = confirmed
    .filter((o) => o.balance > 0 && o.echeance && o.echeance < today)
    .reduce((s, o) => s + o.balance, 0);
  const creditTotal = credits.reduce((s, c) => s + c.remaining, 0);

  return {
    orderCount: confirmed.length,
    devisCount: orders.length - confirmed.length,
    returnCount,
    periodStart,
    periodEnd,
    periodLabel: `du 1 au ${end.getDate()} ${monthName}`,
    currentMonth,
    carriedOver,
    overdue,
    credits: creditTotal,
    balance: currentMonth + carriedOver - creditTotal,
    monthOrders,
    openOlderOrders: olderOpen,
  };
}

export const MODE_PAIEMENT_SHORT: Record<string, string> = {
  ESPECES: "Espèces",
  CARTE: "Carte",
  VIREMENT: "Virement",
  CHEQUE: "Chèque",
  EN_COMPTE: "En compte",
};

/**
 * Staff-side version of loadGarageOrders: the magasin reads order_lines
 * directly (the garage_order_lines view only answers for a garagiste session).
 */
export async function loadGarageOrdersForStaff(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
): Promise<GarageOrder[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id,ref_demande,date_commande,date_envoi,workflow_status,devis,devis_status,montant_total,montant_paye,solde_restant,mode_paiement,echeance," +
        "order_lines(id,reference,nom_produit,quantity,reception_status,disponible,retour_impossible,prix_vente_unitaire)",
    )
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .eq("is_restock", false)
    .order("createdAt", { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const lines = arr(row.order_lines as Embedded<Record<string, unknown>>).map((l) => {
      const qty = toNumber(l.quantity);
      const pv = toNumber(l.prix_vente_unitaire);
      return {
        id: String(l.id),
        reference: String(l.reference ?? ""),
        designation: String(l.nom_produit ?? ""),
        quantity: qty,
        status: String(l.reception_status ?? "PENDING"),
        disponible:
          l.disponible === null || l.disponible === undefined ? null : Boolean(l.disponible),
        retourImpossible: Boolean(l.retour_impossible),
        unitPrice: pv,
        lineTotal: qty * pv,
      };
    });
    return {
      id: String(row.id),
      ref: String(row.ref_demande ?? ""),
      date: (row.date_commande as string | null) ?? null,
      deliveryAt: (row.date_envoi as string | null) ?? null,
      workflow: String(row.workflow_status ?? "PENDING"),
      devis: Boolean(row.devis),
      devisStatus: (row.devis_status as string | null) ?? null,
      total: toNumber(row.montant_total),
      paid: toNumber(row.montant_paye),
      balance: toNumber(row.solde_restant),
      modePaiement: (row.mode_paiement as string | null) ?? null,
      echeance: (row.echeance as string | null) ?? null,
      lines,
    };
  });
}
