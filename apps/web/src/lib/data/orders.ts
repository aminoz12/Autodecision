import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateOrderPayload } from "@/lib/types/api";

export function computeOrderMoney(
  lines: CreateOrderPayload["lines"],
  paid: number,
  advance: number,
) {
  const total = lines.reduce(
    (s, l) => s + l.quantity * l.prix_vente_unitaire,
    0,
  );
  return { total, remaining: Math.max(0, total - paid - advance) };
}

export async function nextQuoteRef(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `DEV-${year}-`;
  const { data } = await supabase
    .from("quotes")
    .select("ref")
    .eq("organization_id", orgId)
    .like("ref", `${prefix}%`)
    .order("ref", { ascending: false })
    .limit(1)
    .maybeSingle();
  let n = 1;
  if (data?.ref) {
    const num = parseInt(data.ref.replace(prefix, ""), 10);
    if (!Number.isNaN(num)) {
      n = num + 1;
    }
  }
  return `${prefix}${String(n).padStart(5, "0")}`;
}

function isUniqueViolation(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  return (
    err?.code === "23505" ||
    Boolean(err?.message?.toLowerCase().includes("duplicate key"))
  );
}

/* ------------------------------------------------------------------ */
/*  Delivery tournées — fixed by order creation time:                  */
/*    17:00–09:30  → Tournée 1, livraison 10:00                         */
/*    09:31–12:00  → Tournée 2, livraison 13:00                         */
/*    12:01–14:30  → Tournée 3, livraison 15:00                         */
/*    14:31–17:00  → Tournée 4, livraison 17:30                         */
/* ------------------------------------------------------------------ */

export type TourneeInfo = {
  number: 1 | 2 | 3 | 4;
  name: string;
  /** Scheduled delivery datetime. */
  deliveryAt: Date;
  /** Delivery date (yyyy-mm-dd). */
  tourDate: string;
  /** Delivery time "HH:MM". */
  slot: string;
};

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function computeTournee(now: Date = new Date()): TourneeInfo {
  const mins = now.getHours() * 60 + now.getMinutes();
  let number: 1 | 2 | 3 | 4;
  let hour: number;
  let minute = 0;

  if (mins >= 571 && mins <= 720) {
    number = 2;
    hour = 13;
  } else if (mins >= 721 && mins <= 870) {
    number = 3;
    hour = 15;
  } else if (mins >= 871 && mins <= 1020) {
    number = 4;
    hour = 17;
    minute = 30;
  } else {
    // 17:01–23:59 and 00:00–09:30
    number = 1;
    hour = 10;
  }

  const deliveryAt = new Date(now);
  deliveryAt.setHours(hour, minute, 0, 0);
  // Evening orders (after 17:00) are delivered the next morning at 10:00.
  if (number === 1 && mins > 1020) {
    deliveryAt.setDate(deliveryAt.getDate() + 1);
  }

  return {
    number,
    name: `Tournée ${number}`,
    deliveryAt,
    tourDate: ymdLocal(deliveryAt),
    slot: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/** Find (or create) the delivery_tours row for a tournée on its delivery date. */
async function findOrCreateTour(
  supabase: SupabaseClient,
  orgId: string,
  t: TourneeInfo,
): Promise<string | null> {
  const { data: existing, error: selErr } = await supabase
    .from("delivery_tours")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", t.name)
    .eq("tour_date", t.tourDate)
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return String((existing as { id: string }).id);

  const { data, error } = await supabase
    .from("delivery_tours")
    .insert({
      organization_id: orgId,
      name: t.name,
      tour_date: t.tourDate,
      slot_start: t.slot,
    })
    .select("id")
    .single();
  if (error) throw error;
  return String((data as { id: string }).id);
}

export async function createOrderWithLines(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  payload: CreateOrderPayload,
) {
  const paid = payload.montant_paye ?? 0;
  const advance = payload.avance_payee ?? 0;
  const { total, remaining } = computeOrderMoney(payload.lines, paid, advance);
  const isDevis = Boolean(payload.devis);
  const sendToDelivery = Boolean(payload.envoyer_au_livreur) && !isDevis;
  const workflow_status = sendToDelivery ? "TO_COLLECT" : "PENDING";

  // A devis (quote request) is not a real order yet: no tournée, no delivery
  // scheduling until it is accepted. Otherwise fix the tournée from now.
  let tourId: string | null = null;
  let dateEnvoi: string | null = null;
  let tourName: string | null = null;
  if (!isDevis) {
    const tournee = computeTournee(new Date());
    tourName = tournee.name;
    try {
      tourId = await findOrCreateTour(supabase, orgId, tournee);
    } catch {
      tourId = null;
    }
    dateEnvoi = tournee.deliveryAt.toISOString();
  }

  // next_ref_demande and the insert run as separate requests, so two
  // concurrent submissions can be handed the same number — retry on conflict.
  let order: { id: string; ref_demande: string } | null = null;
  for (let attempt = 0; attempt < 4 && !order; attempt++) {
    const { data: refRaw, error: rpcErr } = await supabase.rpc(
      "next_ref_demande",
      { p_org: orgId },
    );
    if (rpcErr) {
      throw rpcErr;
    }
    const ref = refRaw as string;

    const { data, error: oErr } = await supabase
      .from("orders")
      .insert({
        organization_id: orgId,
        ref_demande: ref,
        date_commande: payload.date_commande.slice(0, 10),
        vendeur_id: userId,
        canal_vente: payload.canal_vente,
        client_id: payload.client_id ?? null,
        client_phone: payload.client_phone,
        client_email: payload.client_email ?? null,
        immatriculation: payload.immatriculation ?? null,
        vehicle_model: payload.vehicle_model ?? null,
        montant_total: total,
        devis: isDevis,
        devis_status: payload.devis_status ?? null,
        statut_paiement: payload.statut_paiement,
        montant_paye: paid,
        avance_payee: advance,
        solde_restant: remaining,
        envoyer_au_livreur: sendToDelivery,
        date_envoi: dateEnvoi,
        statut_livreur: payload.statut_livreur ?? "EN_ATTENTE",
        consigne: payload.consigne ?? null,
        workflow_status,
        bl: Boolean(payload.bl),
        date_bl: payload.date_bl?.slice(0, 10) ?? null,
      })
      .select("id, ref_demande")
      .single();

    if (!oErr) {
      order = data as { id: string; ref_demande: string };
    } else if (!isUniqueViolation(oErr)) {
      throw oErr;
    }
  }

  if (!order) {
    throw new Error(
      "Référence de commande déjà utilisée malgré plusieurs tentatives. Exécutez supabase/fix_order_refs.sql dans le SQL Editor de Supabase, puis réessayez.",
    );
  }

  const lineRows = payload.lines.map((l) => ({
    organization_id: orgId,
    order_id: order.id,
    nom_produit: l.nom_produit,
    reference: l.reference,
    supplier_id: l.fournisseur_id ?? null,
    quantity: l.quantity,
    a_commander_pour_livreur: Boolean(l.a_commander_pour_livreur),
    depuis_magasin: Boolean(l.depuis_magasin),
    retour_stock_fait: false,
    prix_achat_unitaire: l.prix_achat_unitaire,
    prix_vente_unitaire: l.prix_vente_unitaire,
    tour_id: tourId,
  }));

  const { error: lErr } = await supabase.from("order_lines").insert(lineRows);
  if (lErr) {
    throw lErr;
  }

  if (sendToDelivery) {
    const { error: dErr } = await supabase.from("delivery_tasks").insert({
      organization_id: orgId,
      order_id: order.id,
      workflow_status: "TO_COLLECT",
    });
    if (dErr) {
      throw dErr;
    }
  }

  return {
    id: order.id,
    ref_demande: order.ref_demande,
    tourName: tourName ?? "",
    deliveryAt: dateEnvoi,
  };
}

/**
 * Assign the tournée for an order that becomes confirmed later (e.g. an
 * accepted devis): fixes the tour from now, schedules date_envoi, tags lines.
 */
export async function assignOrderTournee(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<string | null> {
  const tournee = computeTournee(new Date());
  let tourId: string | null = null;
  try {
    tourId = await findOrCreateTour(supabase, orgId, tournee);
  } catch {
    tourId = null;
  }
  await supabase
    .from("orders")
    .update({ date_envoi: tournee.deliveryAt.toISOString() })
    .eq("id", orderId)
    .eq("organization_id", orgId);
  if (tourId) {
    await supabase
      .from("order_lines")
      .update({ tour_id: tourId })
      .eq("order_id", orderId)
      .eq("organization_id", orgId);
  }
  return tourId;
}

export async function createQuoteRow(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  payload: CreateOrderPayload,
) {
  const ref = await nextQuoteRef(supabase, orgId);
  const { data, error } = await supabase
    .from("quotes")
    .insert({
      organization_id: orgId,
      ref,
      created_by_id: userId,
      payload: payload as unknown as Record<string, unknown>,
    })
    .select("id, ref")
    .single();
  if (error) {
    throw error;
  }
  return data as { id: string; ref: string };
}
