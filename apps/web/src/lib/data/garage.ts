import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";
import { createOrderWithLines } from "@/lib/data/orders";
import type { CreateOrderPayload } from "@/lib/types/api";

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
};

export async function loadGarageInfo(
  supabase: SupabaseClient,
  clientId: string,
): Promise<GarageInfo | null> {
  const { data, error } = await supabase
    .from("clients")
    .select("id,name,phone,email,city")
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
};

export type GarageOrder = {
  id: string;
  ref: string;
  date: string | null;
  deliveryAt: string | null;
  workflow: string;
  total: number;
  paid: number;
  balance: number;
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
      "id,ref_demande,date_commande,date_envoi,workflow_status,montant_total,montant_paye,solde_restant," +
        "order_lines(id,reference,nom_produit,quantity,reception_status)",
    )
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .order("createdAt", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const lines = arr(row.order_lines as Embedded<Record<string, unknown>>).map(
      (l) => ({
        id: String(l.id),
        reference: String(l.reference ?? ""),
        designation: String(l.nom_produit ?? ""),
        quantity: toNumber(l.quantity),
        status: String(l.reception_status ?? "PENDING"),
      }),
    );
    return {
      id: String(row.id),
      ref: String(row.ref_demande ?? ""),
      date: (row.date_commande as string | null) ?? null,
      deliveryAt: (row.date_envoi as string | null) ?? null,
      workflow: String(row.workflow_status ?? "PENDING"),
      total: toNumber(row.montant_total),
      paid: toNumber(row.montant_paye),
      balance: toNumber(row.solde_restant),
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
    date_commande: new Date().toISOString().slice(0, 10),
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
    statut_paiement: "NON_PAYÉ",
    montant_paye: 0,
    avance_payee: 0,
    envoyer_au_livreur: true,
    statut_livreur: "EN_ATTENTE",
    bl: false,
  };
  return createOrderWithLines(supabase, userId, orgId, payload);
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
      "id,ref,createdAt,designation,reason,motif,statut_traitement,orders(ref_demande)",
    )
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .order("createdAt", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const order = arr(row.orders as Embedded<Record<string, unknown>>)[0];
    return {
      id: String(row.id),
      ref: String(row.ref ?? `RET-${String(row.id).slice(0, 8)}`),
      createdAt: (row.createdAt as string | null) ?? null,
      designation: String(row.designation ?? row.motif ?? "-"),
      reason: String(row.reason ?? row.motif ?? "-"),
      status: String(row.statut_traitement ?? "A_TRAITER"),
      orderRef: order ? String(order.ref_demande ?? "") : null,
    };
  });
}

export async function createGarageReturn(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
  input: { orderId?: string | null; designation: string; reason: string },
): Promise<void> {
  const year = new Date().getFullYear();
  const ref = `RET-${year}-${String(Math.floor(Date.now() % 100000)).padStart(5, "0")}`;
  const { error } = await supabase.from("sales_returns").insert({
    organization_id: orgId,
    client_id: clientId,
    order_id: input.orderId || null,
    ref,
    designation: input.designation.trim(),
    reason: input.reason.trim(),
    motif: input.reason.trim(),
    type_retour: "RETOURNABLE",
    statut_traitement: "A_TRAITER",
    decote_pct: 0,
    montant: 0,
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Labels                                                            */
/* ------------------------------------------------------------------ */

export const WORKFLOW_LABEL: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "En attente", cls: "amber" },
  TO_COLLECT: { label: "À préparer", cls: "blue" },
  IN_TRANSIT: { label: "En livraison", cls: "violet" },
  DELIVERED: { label: "Livrée", cls: "green" },
};

export const RETURN_LABEL: Record<string, { label: string; cls: string }> = {
  A_TRAITER: { label: "À traiter", cls: "amber" },
  DEMANDE_ENVOYEE: { label: "Demande envoyée", cls: "blue" },
  A_RECUPERER: { label: "À récupérer", cls: "blue" },
  ACCEPTE: { label: "Accepté", cls: "green" },
  REFUSE: { label: "Refusé", cls: "red" },
};
