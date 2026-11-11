import type { SupabaseClient } from "@supabase/supabase-js";

/*
 * « À réintégrer pour le stock » (2026-11-11): restock parts pointed received
 * and still to put back on the shelf. The counts are already in the stock
 * (reception adds them); this is the physical to-do, ticked line by line.
 */

export type ShelveRow = {
  lineId: string;
  orderId: string;
  orderRef: string;
  reference: string;
  referenceCommande: string | null;
  designation: string;
  quantity: number;
  received: number;
  shelved: number;
  /** Units received and not yet put on the shelf. */
  toShelve: number;
  receivedAt: string | null;
  supplierName: string | null;
};

const MIGRATION_HINT = "« À réintégrer pour le stock » demande la migration 20261111010000 (npx supabase db push).";

function missing(message: string): boolean {
  return /restock_to_shelve|shelve_restock_line|shelved_qty|schema cache/i.test(message);
}

export async function loadRestockToShelve(supabase: SupabaseClient): Promise<ShelveRow[]> {
  const { data, error } = await supabase.rpc("restock_to_shelve");
  if (error) throw new Error(missing(error.message) ? MIGRATION_HINT : error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    lineId: String(r.line_id),
    orderId: String(r.order_id),
    orderRef: String(r.order_ref ?? ""),
    reference: String(r.reference ?? ""),
    referenceCommande: (r.reference_commande as string | null) || null,
    designation: String(r.designation ?? ""),
    quantity: Number(r.quantity ?? 0),
    received: Number(r.qte_recue ?? 0),
    shelved: Number(r.shelved_qty ?? 0),
    toShelve: Number(r.to_shelve ?? 0),
    receivedAt: (r.received_at as string | null) ?? null,
    supplierName: (r.supplier_name as string | null) || null,
  }));
}

/** The counter next to the menu entry: parts (lines) still to put away. Zero on a database before the migration. */
export async function countRestockToShelve(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.rpc("restock_to_shelve");
  if (error) {
    if (missing(error.message)) return 0;
    throw new Error(error.message);
  }
  return (data ?? []).length;
}

/** « Rangée » : every received unit of the line is on the shelf. */
export async function shelveRestockLine(supabase: SupabaseClient, lineId: string): Promise<void> {
  const { error } = await supabase.rpc("shelve_restock_line", { p_line_id: lineId });
  if (error) throw new Error(missing(error.message) ? MIGRATION_HINT : error.message);
}

/** Window event (detail = count) the page fires so the menu counter follows it at once. */
export const SHELVE_COUNT_EVENT = "restock-shelve-count";
