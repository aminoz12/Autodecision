import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

type Embedded<T> = T | T[] | null | undefined;
function first<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

/* ------------------------------------------------------------------ */
/*  Consignes (returnable deposits / core charges).                    */
/*  ACTIF  = deposit held, old part (core) not yet brought back.        */
/*  RENDUE = core returned, deposit refunded to the client.             */
/* ------------------------------------------------------------------ */

export type ConsigneRow = {
  id: string;
  num: string;
  createdAt: string;
  client: string;
  reference: string;
  description: string;
  quantity: number;
  amount: number;
  status: string;
  orderRef: string | null;
  /* ---- Double boucle (migration 20260920020000) ; null on a database without it. ---- */
  clientId: string | null;
  /** Date limite de retour annoncée au client à la vente. */
  clientDeadline: string | null;
  returnedAt: string | null;
  /** COMPLET / INCOMPLET / CASSE / VIDE — constaté à la reprise. */
  coreState: string | null;
  hasCorePhoto: boolean;
  supplierId: string | null;
  supplierName: string | null;
  /** A_RENVOYER / RENVOYE / AVOIR_RECU / REFUSE ; null = pas de boucle fournisseur. */
  supplierStatus: string | null;
  supplierDeadline: string | null;
  supplierCreditAmount: number | null;
  /** Retour fournisseur (type CONSIGNE) confié à la tournée. */
  returnId: string | null;
};

export async function loadConsignes(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ConsigneRow[]> {
  const BASE = "id,num,created_at,reference,description,quantity,montant,status,client_id,echeance,clients(name),orders(ref_demande)";
  const LOOP = ",returned_at,core_state,core_photo_path,supplier_id,supplier_status,supplier_deadline,supplier_credit_amount,return_id,suppliers(name)";
  const query = (select: string) =>
    supabase.from("consignment_entries").select(select).eq("organization_id", orgId).order("created_at", { ascending: false }).limit(300);
  let { data, error } = await query(BASE + LOOP);
  // A database without the after-sales migration still lists the consignes.
  if (error && /core_state|supplier_status|returned_at|return_id|supplier_deadline|core_photo/i.test(error.message)) {
    ({ data, error } = await query(BASE));
  }

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    return {
      id: String(row.id),
      num: String(row.num ?? `CO-${String(row.id).slice(0, 8)}`),
      createdAt: String(row.created_at ?? ""),
      client: String(client?.name ?? "Client comptoir"),
      reference: String(row.reference ?? "-"),
      description: String(row.description ?? "-"),
      quantity: toNumber(row.quantity),
      amount: toNumber(row.montant),
      status: String(row.status ?? "ACTIF"),
      orderRef: (order?.ref_demande as string | null) ?? null,
      clientId: (row.client_id as string | null) ?? null,
      clientDeadline: (row.echeance as string | null) ?? null,
      returnedAt: (row.returned_at as string | null) ?? null,
      coreState: (row.core_state as string | null) ?? null,
      hasCorePhoto: Boolean(row.core_photo_path),
      supplierId: (row.supplier_id as string | null) ?? null,
      supplierName: (supplier?.name as string | null) ?? null,
      supplierStatus: (row.supplier_status as string | null) ?? null,
      supplierDeadline: (row.supplier_deadline as string | null) ?? null,
      supplierCreditAmount: row.supplier_credit_amount == null ? null : toNumber(row.supplier_credit_amount),
      returnId: (row.return_id as string | null) ?? null,
    };
  });
}

/** Core brought back → refund the deposit and close the consigne. */
export async function markConsigneReturned(
  supabase: SupabaseClient,
  _orgId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_consignment_status", {
    p_entry_id: id,
    p_status: "RENDUE",
  });
  if (error) throw new Error(error.message);
}

/** Re-open a consigne marked returned by mistake. */
export async function reopenConsigne(
  supabase: SupabaseClient,
  _orgId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase.rpc("set_consignment_status", {
    p_entry_id: id,
    p_status: "ACTIF",
  });
  if (error) throw new Error(error.message);
}
