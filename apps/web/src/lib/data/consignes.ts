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
};

export async function loadConsignes(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ConsigneRow[]> {
  const { data, error } = await supabase
    .from("consignment_entries")
    .select(
      "id,num,created_at,reference,description,quantity,montant,status,clients(name),orders(ref_demande)",
    )
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    const order = first(row.orders as Embedded<Record<string, unknown>>);
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
    };
  });
}

/** Core brought back → refund the deposit and close the consigne. */
export async function markConsigneReturned(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("consignment_entries")
    .update({ status: "RENDUE" })
    .eq("id", id)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
}

/** Re-open a consigne marked returned by mistake. */
export async function reopenConsigne(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from("consignment_entries")
    .update({ status: "ACTIF" })
    .eq("id", id)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
}
