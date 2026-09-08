import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Stock — items with threshold / location / PMP, and the movements   */
/*  ledger written by the database on every quantity change.          */
/* ------------------------------------------------------------------ */

export type StockItemRow = {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  minQty: number;
  location: string | null;
  costPrice: number | null;
  supplierId: string | null;
  supplierName: string | null;
  updatedAt: string;
  /** quantity ≤ minQty (and a threshold is set). */
  low: boolean;
  /** quantity × cost price (0 when unknown). */
  value: number;
};

type Embedded<T> = T | T[] | null | undefined;
function first<T>(v: Embedded<T>): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export async function loadStockRows(supabase: SupabaseClient, orgId: string): Promise<StockItemRow[]> {
  const { data, error } = await supabase
    .from("stock_items")
    .select("id,sku,name,quantity_on_hand,min_qty,location,cost_price,supplier_id,updated_at,suppliers(name)")
    .eq("organization_id", orgId)
    .order("sku")
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const supplier = first(r.suppliers as Embedded<Record<string, unknown>>);
    const quantity = toNumber(r.quantity_on_hand);
    const minQty = toNumber(r.min_qty);
    const costPrice = r.cost_price == null ? null : toNumber(r.cost_price);
    return {
      id: String(r.id),
      sku: String(r.sku ?? ""),
      name: String(r.name ?? ""),
      quantity,
      minQty,
      location: (r.location as string | null) ?? null,
      costPrice,
      supplierId: (r.supplier_id as string | null) ?? null,
      supplierName: supplier ? String(supplier.name ?? "") : null,
      updatedAt: String(r.updated_at ?? ""),
      low: minQty > 0 && quantity <= minQty,
      value: costPrice ? Math.round(quantity * costPrice * 100) / 100 : 0,
    };
  });
}

export type StockReason = "VENTE" | "RECEPTION" | "RETOUR_CLIENT" | "AJUSTEMENT" | "INVENTAIRE" | "CASSE" | "DEVIS_ACCEPTE";
export const STOCK_REASON_LABEL: Record<string, string> = {
  VENTE: "Vente comptoir",
  RECEPTION: "Réception",
  RETOUR_CLIENT: "Retour client",
  AJUSTEMENT: "Ajustement",
  INVENTAIRE: "Inventaire",
  CASSE: "Casse / perte",
  DEVIS_ACCEPTE: "Devis garage accepté",
};

export type StockMovement = {
  id: string;
  sku: string;
  delta: number;
  quantityAfter: number;
  reason: string;
  ref: string | null;
  orderId: string | null;
  note: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
};

export async function loadStockMovements(
  supabase: SupabaseClient,
  orgId: string,
  opts: { sku?: string; limit?: number } = {},
): Promise<StockMovement[]> {
  let q = supabase
    .from("stock_movements")
    .select("id,sku,delta,quantity_after,reason,ref,order_id,note,created_by,created_at")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.sku) q = q.eq("sku", opts.sku);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Record<string, unknown>[];
  const ids = [...new Set(rows.map((r) => String(r.created_by ?? "")).filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("user_id,display_name").eq("organization_id", orgId).in("user_id", ids);
    for (const p of profiles ?? []) names.set(String((p as Record<string, unknown>).user_id), String((p as Record<string, unknown>).display_name ?? ""));
  }
  return rows.map((r) => {
    const by = (r.created_by as string | null) ?? null;
    return {
      id: String(r.id),
      sku: String(r.sku ?? ""),
      delta: toNumber(r.delta),
      quantityAfter: toNumber(r.quantity_after),
      reason: String(r.reason ?? ""),
      ref: (r.ref as string | null) ?? null,
      orderId: (r.order_id as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      createdBy: by,
      createdByName: by ? (names.get(by) ?? null) : null,
      createdAt: String(r.created_at),
    };
  });
}

export async function adjustStock(
  supabase: SupabaseClient,
  input: { sku: string; name?: string; delta: number; reason: "AJUSTEMENT" | "INVENTAIRE" | "CASSE" | "RETOUR_CLIENT" | "RECEPTION"; note?: string },
): Promise<void> {
  const { error } = await supabase.rpc("adjust_stock_item", {
    p_sku: input.sku,
    p_name: input.name ?? input.sku,
    p_delta: Math.trunc(input.delta),
    p_reason: input.reason,
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(error.message);
}

export async function setStockQuantity(
  supabase: SupabaseClient,
  input: { sku: string; quantity: number; reason?: "INVENTAIRE" | "AJUSTEMENT"; note?: string },
): Promise<void> {
  const { error } = await supabase.rpc("set_stock_quantity", {
    p_sku: input.sku,
    p_quantity: Math.max(0, Math.trunc(input.quantity)),
    p_reason: input.reason ?? "INVENTAIRE",
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(error.message);
}

export async function updateStockItem(
  supabase: SupabaseClient,
  input: { sku: string; minQty?: number | null; location?: string | null; costPrice?: number | null; supplierId?: string | null; name?: string | null },
): Promise<void> {
  const { error } = await supabase.rpc("update_stock_item", {
    p_sku: input.sku,
    p_min_qty: input.minQty ?? null,
    p_location: input.location ?? null,
    p_cost_price: input.costPrice ?? null,
    p_supplier_id: input.supplierId ?? null,
    p_name: input.name ?? null,
  });
  if (error) throw new Error(error.message);
}
