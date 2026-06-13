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

export async function createOrderWithLines(
  supabase: SupabaseClient,
  userId: string,
  orgId: string,
  payload: CreateOrderPayload,
) {
  const paid = payload.montant_paye ?? 0;
  const advance = payload.avance_payee ?? 0;
  const { total, remaining } = computeOrderMoney(payload.lines, paid, advance);
  const sendToDelivery = Boolean(payload.envoyer_au_livreur);
  const workflow_status = sendToDelivery ? "TO_COLLECT" : "PENDING";

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
        devis: Boolean(payload.devis),
        statut_paiement: payload.statut_paiement,
        montant_paye: paid,
        avance_payee: advance,
        solde_restant: remaining,
        envoyer_au_livreur: sendToDelivery,
        date_envoi: payload.date_envoi
          ? new Date(payload.date_envoi).toISOString()
          : null,
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

  return order as { id: string; ref_demande: string };
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
