import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Livreurs — the magasin's delivery drivers ("Livreur 1/2/3" by     */
/*  default). Garage / delivery orders are dispatched to one of them.  */
/* ------------------------------------------------------------------ */

export type Livreur = {
  id: string;
  name: string;
  phone: string | null;
  active: boolean;
  sortOrder: number;
};

export async function loadLivreurs(
  supabase: SupabaseClient,
  orgId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<Livreur[]> {
  let query = supabase
    .from("livreurs")
    .select("id,name,phone,active,sort_order")
    .eq("organization_id", orgId)
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (opts.activeOnly) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      phone: (row.phone as string | null) ?? null,
      active: row.active !== false,
      sortOrder: toNumber(row.sort_order),
    };
  });
}

export async function createLivreur(
  supabase: SupabaseClient,
  orgId: string,
  input: { name: string; phone?: string | null; sortOrder?: number },
): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error("Le nom du livreur est obligatoire.");
  const { error } = await supabase.from("livreurs").insert({
    organization_id: orgId,
    name,
    phone: input.phone?.trim() || null,
    sort_order: input.sortOrder ?? 0,
  });
  if (error) {
    if (error.code === "23505") throw new Error(`Un livreur « ${name} » existe déjà.`);
    throw new Error(error.message);
  }
}

export async function updateLivreur(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
  patch: { name?: string; phone?: string | null; active?: boolean },
): Promise<void> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("Le nom du livreur est obligatoire.");
    update.name = name;
  }
  if (patch.phone !== undefined) update.phone = patch.phone?.trim() || null;
  if (patch.active !== undefined) update.active = patch.active;
  const { error } = await supabase
    .from("livreurs")
    .update(update)
    .eq("id", id)
    .eq("organization_id", orgId);
  if (error) {
    if (error.code === "23505") throw new Error("Un livreur porte déjà ce nom.");
    throw new Error(error.message);
  }
}

/* ------------------------------------------------------------------ */
/*  Dispatch                                                          */
/* ------------------------------------------------------------------ */

/** Hand an order to a livreur: workflow → IN_TRANSIT (en cours de livraison). */
export async function dispatchOrderToLivreur(
  supabase: SupabaseClient,
  orderId: string,
  livreurId: string,
): Promise<void> {
  const { error } = await supabase.rpc("dispatch_order_to_livreur", {
    p_order_id: orderId,
    p_livreur_id: livreurId,
  });
  if (error) throw new Error(error.message);
}

/** The livreur delivered the order: workflow → DELIVERED. */
export async function markOrderDelivered(
  supabase: SupabaseClient,
  orderId: string,
): Promise<void> {
  const { error } = await supabase.rpc("mark_order_delivered", {
    p_order_id: orderId,
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Deliveries in progress (Livreurs page)                            */
/* ------------------------------------------------------------------ */

export type LivreurDelivery = {
  orderId: string;
  orderRef: string;
  clientName: string;
  clientPhone: string | null;
  isGarage: boolean;
  livreurId: string | null;
  livreurName: string | null;
  workflow: string;
  dateEnvoi: string | null;
  pieces: number;
};

type Embedded<T> = T | T[] | null | undefined;
function first<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

/** Orders currently out for delivery (IN_TRANSIT), most recent first. */
export async function loadDeliveriesInProgress(
  supabase: SupabaseClient,
  orgId: string,
): Promise<LivreurDelivery[]> {
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id,ref_demande,client_phone,workflow_status,date_envoi,livreur_id," +
        "clients(name,phone,is_garage),livreurs(name),order_lines(quantity)",
    )
    .eq("organization_id", orgId)
    .eq("devis", false)
    .eq("workflow_status", "IN_TRANSIT")
    .order("date_envoi", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    const livreur = first(row.livreurs as Embedded<Record<string, unknown>>);
    const lines = (row.order_lines as Record<string, unknown>[] | null) ?? [];
    return {
      orderId: String(row.id),
      orderRef: String(row.ref_demande ?? ""),
      clientName: String(client?.name ?? row.client_phone ?? "Client comptoir"),
      clientPhone:
        (client?.phone as string | null) ?? (row.client_phone as string | null) ?? null,
      isGarage: client?.is_garage === true,
      livreurId: (row.livreur_id as string | null) ?? null,
      livreurName: livreur ? String(livreur.name ?? "") : null,
      workflow: String(row.workflow_status ?? "IN_TRANSIT"),
      dateEnvoi: (row.date_envoi as string | null) ?? null,
      pieces: lines.reduce((s, l) => s + toNumber(l.quantity), 0),
    };
  });
}
