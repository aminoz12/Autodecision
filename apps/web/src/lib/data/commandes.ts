import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

type Embedded<T> = T | T[] | null | undefined;

function first<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export type ReceptionStatus =
  | "PENDING"
  | "RECEIVED"
  | "BACKORDER"
  | "NOT_RECEIVED";

/* ------------------------------------------------------------------ */
/*  Reception board — every order line with its order/client context  */
/* ------------------------------------------------------------------ */

export type BoardLine = {
  id: string;
  orderId: string;
  orderRef: string;
  orderDate: string | null;
  clientId: string | null;
  clientName: string;
  clientPhone: string | null;
  vehicle: string | null;
  plate: string | null;
  reference: string;
  designation: string;
  supplierName: string | null;
  fromStock: boolean;
  quantity: number;
  received: number;
  status: ReceptionStatus;
  receivedAt: string | null;
  expectedAt: string | null;
  tourId: string | null;
  tourName: string | null;
};

export async function loadReceptionBoard(
  supabase: SupabaseClient,
  orgId: string,
): Promise<BoardLine[]> {
  const { data, error } = await supabase
    .from("order_lines")
    .select(
      "id,order_id,reference,nom_produit,quantity,qte_recue,reception_status,received_at,prevue_le,depuis_magasin,tour_id," +
        "orders(id,ref_demande,date_commande,client_phone,immatriculation,vehicle_model,clients(id,name,phone))," +
        "suppliers(name),delivery_tours(name)",
    )
    .eq("organization_id", orgId)
    .limit(500);

  if (error) throw new Error(error.message);

  const rows = (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const client = first(order?.clients as Embedded<Record<string, unknown>>);
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    const tour = first(row.delivery_tours as Embedded<Record<string, unknown>>);
    return {
      id: String(row.id),
      orderId: String(row.order_id),
      orderRef: String(order?.ref_demande ?? row.order_id ?? ""),
      orderDate: (order?.date_commande as string | null) ?? null,
      clientId: client ? String(client.id) : null,
      clientName: String(client?.name ?? "Client non lié"),
      clientPhone:
        (client?.phone as string | null) ??
        (order?.client_phone as string | null) ??
        null,
      vehicle: (order?.vehicle_model as string | null) ?? null,
      plate: (order?.immatriculation as string | null) ?? null,
      reference: String(row.reference ?? ""),
      designation: String(row.nom_produit ?? ""),
      supplierName: supplier ? String(supplier.name ?? "") : null,
      fromStock: Boolean(row.depuis_magasin),
      quantity: toNumber(row.quantity),
      received: toNumber(row.qte_recue),
      status: String(row.reception_status ?? "PENDING") as ReceptionStatus,
      receivedAt: (row.received_at as string | null) ?? null,
      expectedAt: (row.prevue_le as string | null) ?? null,
      tourId: (row.tour_id as string | null) ?? null,
      tourName: tour ? String(tour.name ?? "") : null,
    };
  });

  return rows.sort((a, b) =>
    String(b.orderDate ?? "").localeCompare(String(a.orderDate ?? "")),
  );
}

/** Reliquat / Non reçu / re-open. "Reçu" goes through markLineReceived (stock side-effects). */
export async function setLineReceptionStatus(
  supabase: SupabaseClient,
  orgId: string,
  lineId: string,
  status: Exclude<ReceptionStatus, "RECEIVED">,
): Promise<void> {
  const { error } = await supabase
    .from("order_lines")
    .update({ reception_status: status })
    .eq("id", lineId)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Commande SMS — per-order notification state                       */
/* ------------------------------------------------------------------ */

export type SmsState = { sent: boolean; treated: boolean };

export async function loadSmsStates(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Map<string, SmsState>> {
  const { data, error } = await supabase
    .from("sms_notifications")
    .select("order_id,status,traite")
    .eq("organization_id", orgId)
    .limit(1000);

  if (error) throw new Error(error.message);

  const map = new Map<string, SmsState>();
  for (const raw of data ?? []) {
    const row = raw as unknown as Record<string, unknown>;
    const orderId = String(row.order_id ?? "");
    if (!orderId) continue;
    const current = map.get(orderId) ?? { sent: false, treated: false };
    map.set(orderId, {
      sent: current.sent || String(row.status) === "ENVOYE",
      treated: current.treated || Boolean(row.traite),
    });
  }
  return map;
}

export async function recordSmsSent(
  supabase: SupabaseClient,
  orgId: string,
  input: { orderId: string; clientId: string | null; phone: string | null },
): Promise<void> {
  const { error } = await supabase.from("sms_notifications").insert({
    organization_id: orgId,
    order_id: input.orderId,
    client_id: input.clientId,
    phone: input.phone,
    message: "Vos pièces sont disponibles en magasin.",
    status: "ENVOYE",
    sent_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function markOrderSmsTreated(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<void> {
  const { error } = await supabase.from("sms_notifications").insert({
    organization_id: orgId,
    order_id: orderId,
    traite: true,
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Order detail                                                      */
/* ------------------------------------------------------------------ */

export type OrderDetailLine = {
  id: string;
  reference: string;
  designation: string;
  supplierName: string | null;
  fromStock: boolean;
  quantity: number;
  received: number;
  status: ReceptionStatus;
  expectedAt: string | null;
  receivedAt: string | null;
  tourName: string | null;
  prixVente: number;
  total: number;
};

export type OrderDetail = {
  id: string;
  ref: string;
  date: string | null;
  canal: string;
  workflow: string;
  devis: boolean;
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  plate: string | null;
  vehicle: string | null;
  vendeurName: string;
  total: number;
  paye: number;
  avance: number;
  solde: number;
  statutPaiement: string;
  envoyerAuLivreur: boolean;
  statutLivreur: string;
  dateEnvoi: string | null;
  consigne: string | null;
  bl: boolean;
  dateBl: string | null;
  lines: OrderDetailLine[];
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadOrderDetail(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<OrderDetail | null> {
  if (!UUID_RE.test(orderId)) return null;

  const { data: orderRaw, error: oErr } = await supabase
    .from("orders")
    .select(
      "id,ref_demande,date_commande,canal_vente,vendeur_id,client_id,client_phone,client_email," +
        "immatriculation,vehicle_model,montant_total,devis,statut_paiement,montant_paye,avance_payee," +
        "solde_restant,envoyer_au_livreur,date_envoi,statut_livreur,consigne,workflow_status,bl,date_bl," +
        "clients(name,phone,email)",
    )
    .eq("id", orderId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (oErr) throw new Error(oErr.message);
  if (!orderRaw) return null;

  const order = orderRaw as unknown as Record<string, unknown>;
  const client = first(order.clients as Embedded<Record<string, unknown>>);

  const [linesRes, vendeurRes] = await Promise.all([
    supabase
      .from("order_lines")
      .select(
        "id,reference,nom_produit,quantity,qte_recue,reception_status,prevue_le,received_at," +
          "depuis_magasin,prix_vente_unitaire,suppliers(name),delivery_tours(name)",
      )
      .eq("order_id", orderId)
      .eq("organization_id", orgId),
    supabase
      .from("profiles")
      .select("display_name")
      .eq("user_id", String(order.vendeur_id ?? ""))
      .maybeSingle(),
  ]);

  if (linesRes.error) throw new Error(linesRes.error.message);

  const lines: OrderDetailLine[] = (linesRes.data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    const tour = first(row.delivery_tours as Embedded<Record<string, unknown>>);
    const qty = toNumber(row.quantity);
    const pv = toNumber(row.prix_vente_unitaire);
    return {
      id: String(row.id),
      reference: String(row.reference ?? ""),
      designation: String(row.nom_produit ?? ""),
      supplierName: supplier ? String(supplier.name ?? "") : null,
      fromStock: Boolean(row.depuis_magasin),
      quantity: qty,
      received: toNumber(row.qte_recue),
      status: String(row.reception_status ?? "PENDING") as ReceptionStatus,
      expectedAt: (row.prevue_le as string | null) ?? null,
      receivedAt: (row.received_at as string | null) ?? null,
      tourName: tour ? String(tour.name ?? "") : null,
      prixVente: pv,
      total: qty * pv,
    };
  });

  return {
    id: String(order.id),
    ref: String(order.ref_demande ?? ""),
    date: (order.date_commande as string | null) ?? null,
    canal: String(order.canal_vente ?? ""),
    workflow: String(order.workflow_status ?? "PENDING"),
    devis: Boolean(order.devis),
    clientName: String(client?.name ?? "Client non lié"),
    clientPhone:
      (client?.phone as string | null) ??
      (order.client_phone as string | null) ??
      null,
    clientEmail:
      (client?.email as string | null) ??
      (order.client_email as string | null) ??
      null,
    plate: (order.immatriculation as string | null) ?? null,
    vehicle: (order.vehicle_model as string | null) ?? null,
    vendeurName: String(
      (vendeurRes.data as Record<string, unknown> | null)?.display_name ?? "—",
    ),
    total: toNumber(order.montant_total),
    paye: toNumber(order.montant_paye),
    avance: toNumber(order.avance_payee),
    solde: toNumber(order.solde_restant),
    statutPaiement: String(order.statut_paiement ?? ""),
    envoyerAuLivreur: Boolean(order.envoyer_au_livreur),
    statutLivreur: String(order.statut_livreur ?? "EN_ATTENTE"),
    dateEnvoi: (order.date_envoi as string | null) ?? null,
    consigne: (order.consigne as string | null) ?? null,
    bl: Boolean(order.bl),
    dateBl: (order.date_bl as string | null) ?? null,
    lines,
  };
}
