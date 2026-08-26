import type { SupabaseClient } from "@supabase/supabase-js";
import { computeTournee, findOrCreateTour, type TourneeInfo } from "@/lib/data/orders";

type Embedded<T> = T | T[] | null | undefined;

function first<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function toNumber(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function fmtMoney(value: number | string | null | undefined): string {
  return `${toNumber(value).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("fr-FR");
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isMissingRpcError(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null;
  return (
    err?.code === "PGRST202" ||
    err?.code === "42883" ||
    Boolean(err?.message?.toLowerCase().includes("could not find the function"))
  );
}

export type SupplierSummary = {
  id: string;
  name: string;
  code: string | null;
  pendingLines: number;
  pendingPieces: number;
  createdAt: string;
};

export async function loadSuppliers(
  supabase: SupabaseClient,
  orgId: string,
): Promise<SupplierSummary[]> {
  const [suppliersRes, linesRes] = await Promise.all([
    supabase
      .from("suppliers")
      .select("id,name,code,created_at")
      .eq("organization_id", orgId)
      .order("name"),
    supabase
      .from("order_lines")
      .select("supplier_id,quantity,qte_recue,reception_status")
      .eq("organization_id", orgId)
      .neq("reception_status", "RECEIVED")
      .not("supplier_id", "is", null),
  ]);

  if (suppliersRes.error) throw new Error(suppliersRes.error.message);
  if (linesRes.error) throw new Error(linesRes.error.message);

  const pending = new Map<string, { lines: number; pieces: number }>();
  for (const raw of linesRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const supplierId = String(row.supplier_id ?? "");
    if (!supplierId) continue;
    const qty = Math.max(toNumber(row.quantity) - toNumber(row.qte_recue), 0);
    const current = pending.get(supplierId) ?? { lines: 0, pieces: 0 };
    pending.set(supplierId, {
      lines: current.lines + 1,
      pieces: current.pieces + qty,
    });
  }

  return (suppliersRes.data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const p = pending.get(String(row.id)) ?? { lines: 0, pieces: 0 };
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      code: (row.code as string | null) ?? null,
      pendingLines: p.lines,
      pendingPieces: p.pieces,
      createdAt: String(row.created_at ?? ""),
    };
  });
}

export async function createSupplier(
  supabase: SupabaseClient,
  orgId: string,
  input: { name: string; code?: string },
): Promise<void> {
  const { error } = await supabase.from("suppliers").insert({
    organization_id: orgId,
    name: input.name.trim(),
    code: input.code?.trim() || null,
  });
  if (error) throw new Error(error.message);
}

export type ClientOption = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  immatriculation: string | null;
  vehicleModel: string | null;
};

export async function loadClients(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ClientOption[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("id,name,phone,email,immatriculation,vehicle_model")
    .eq("organization_id", orgId)
    .order("name");

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      phone: (row.phone as string | null) ?? null,
      email: (row.email as string | null) ?? null,
      immatriculation: (row.immatriculation as string | null) ?? null,
      vehicleModel: (row.vehicle_model as string | null) ?? null,
    };
  });
}

export type SupplierOption = {
  id: string;
  name: string;
};

/** Minimal supplier list for pickers — avoids columns the form doesn't need. */
export async function loadSupplierOptions(
  supabase: SupabaseClient,
  orgId: string,
): Promise<SupplierOption[]> {
  const { data, error } = await supabase
    .from("suppliers")
    .select("id,name")
    .eq("organization_id", orgId)
    .order("name");

  if (error) throw new Error(error.message);
  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return { id: String(row.id), name: String(row.name ?? "") };
  });
}

export async function createClientRecord(
  supabase: SupabaseClient,
  orgId: string,
  input: {
    name: string;
    phone?: string;
    email?: string;
    immatriculation?: string;
    vehicleModel?: string;
  },
): Promise<ClientOption> {
  const { data, error } = await supabase
    .from("clients")
    .insert({
      organization_id: orgId,
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      immatriculation: input.immatriculation?.trim() || null,
      vehicle_model: input.vehicleModel?.trim() || null,
    })
    .select("id,name,phone,email,immatriculation,vehicle_model")
    .single();

  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    immatriculation: (row.immatriculation as string | null) ?? null,
    vehicleModel: (row.vehicle_model as string | null) ?? null,
  };
}

export type ReceptionLine = {
  id: string;
  orderId: string;
  orderRef: string;
  orderDate: string | null;
  clientName: string;
  clientPhone: string | null;
  reference: string;
  /** Supplier reference used for a stock re-order (alongside `reference`). */
  referenceCommande: string | null;
  designation: string;
  supplierName: string;
  supplierId: string | null;
  quantity: number;
  receivedQuantity: number;
  expectedAt: string | null;
  updatedAt: string | null;
};

export async function loadReceptionLines(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ReceptionLine[]> {
  const { data, error } = await supabase
    .from("order_lines")
    .select(
      "id,order_id,reference,reference_commande,nom_produit,supplier_id,quantity,qte_recue,prevue_le,received_at,reception_status,orders(ref_demande,date_commande,client_phone,clients(name,phone)),suppliers(name)",
    )
    .eq("organization_id", orgId)
    .neq("reception_status", "RECEIVED")
    // Parts served from the magasin stock are not awaited from anyone: they
    // only show up here once re-ordered from a supplier (Stock → Commander).
    .or("depuis_magasin.not.is.true,supplier_id.not.is.null")
    .order("prevue_le", { ascending: true, nullsFirst: false })
    .limit(200);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const client = first(order?.clients as Embedded<Record<string, unknown>>);
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    return {
      id: String(row.id),
      orderId: String(row.order_id),
      orderRef: String(order?.ref_demande ?? row.order_id ?? ""),
      orderDate: (order?.date_commande as string | null) ?? null,
      clientName: String(client?.name ?? "Client non lie"),
      clientPhone:
        (client?.phone as string | null) ??
        (order?.client_phone as string | null) ??
        null,
      reference: String(row.reference ?? ""),
      referenceCommande: (row.reference_commande as string | null) || null,
      designation: String(row.nom_produit ?? ""),
      supplierName: String(supplier?.name ?? "Sans fournisseur"),
      supplierId: (row.supplier_id as string | null) ?? null,
      quantity: toNumber(row.quantity),
      receivedQuantity: toNumber(row.qte_recue),
      expectedAt: (row.prevue_le as string | null) ?? null,
      updatedAt: (row.received_at as string | null) ?? null,
    };
  });
}

export async function markLineReceived(
  supabase: SupabaseClient,
  orgId: string,
  line: Pick<ReceptionLine, "id" | "reference" | "designation" | "quantity" | "receivedQuantity">,
): Promise<void> {
  const rpc = await supabase.rpc("receive_order_line", { p_line_id: line.id });
  if (!rpc.error) return;
  if (!isMissingRpcError(rpc.error)) throw new Error(rpc.error.message);

  const qtyToReceive = Math.max(line.quantity - line.receivedQuantity, 0);
  const receivedAt = new Date().toISOString();
  const { error: lineErr } = await supabase
    .from("order_lines")
    .update({
      qte_recue: line.quantity,
      reception_status: "RECEIVED",
      received_at: receivedAt,
    })
    .eq("id", line.id)
    .eq("organization_id", orgId);

  if (lineErr) throw new Error(lineErr.message);
  if (qtyToReceive <= 0) return;

  const sku = line.reference.trim();
  const { data: existing, error: existingErr } = await supabase
    .from("stock_items")
    .select("id,quantity_on_hand")
    .eq("organization_id", orgId)
    .eq("sku", sku)
    .maybeSingle();

  if (existingErr) throw new Error(existingErr.message);

  if (existing) {
    const current = existing as { id: string; quantity_on_hand: number };
    const { error } = await supabase
      .from("stock_items")
      .update({ quantity_on_hand: toNumber(current.quantity_on_hand) + qtyToReceive })
      .eq("id", current.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from("stock_items").insert({
    organization_id: orgId,
    sku,
    name: line.designation,
    quantity_on_hand: qtyToReceive,
  });
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Restock alerts — parts taken from stock for a client order that     */
/*  still need to be re-ordered from a supplier to replenish stock.     */
/* ------------------------------------------------------------------ */

export type RestockAlert = {
  id: string;
  reference: string;
  designation: string;
  quantity: number;
  prixAchat: number;
  orderId: string;
  orderRef: string;
  orderDate: string | null;
  clientName: string;
};

export async function loadRestockAlerts(
  supabase: SupabaseClient,
  orgId: string,
): Promise<RestockAlert[]> {
  const { data, error } = await supabase
    .from("order_lines")
    .select(
      "id,reference,nom_produit,quantity,prix_achat_unitaire,order_id," +
        "orders(ref_demande,date_commande,client_phone,clients(name))",
    )
    .eq("organization_id", orgId)
    .eq("depuis_magasin", true)
    .is("supplier_id", null)
    .eq("retour_stock_fait", false)
    .limit(500);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const client = first(order?.clients as Embedded<Record<string, unknown>>);
    return {
      id: String(row.id),
      reference: String(row.reference ?? ""),
      designation: String(row.nom_produit ?? ""),
      quantity: toNumber(row.quantity),
      prixAchat: toNumber(row.prix_achat_unitaire),
      orderId: String(row.order_id),
      orderRef: String(order?.ref_demande ?? ""),
      orderDate: (order?.date_commande as string | null) ?? null,
      clientName: String(
        client?.name ?? order?.client_phone ?? "Client comptoir",
      ),
    };
  });
}

export type RestockHistoryStatus = "COMMANDE" | "RECU" | "RANGE";

export type RestockHistoryRow = {
  id: string;
  reference: string;
  referenceCommande: string | null;
  designation: string;
  quantity: number;
  supplierName: string;
  orderId: string;
  orderRef: string;
  status: RestockHistoryStatus;
  date: string | null;
};

/** History of stock re-orders: stock lines that were ordered from a supplier. */
export async function loadRestockHistory(
  supabase: SupabaseClient,
  orgId: string,
): Promise<RestockHistoryRow[]> {
  const { data, error } = await supabase
    .from("order_lines")
    .select(
      "id,reference,reference_commande,nom_produit,quantity,reception_status,retour_stock_fait," +
        "received_at,prevue_le,order_id,suppliers(name),orders(ref_demande,date_commande)",
    )
    .eq("organization_id", orgId)
    .eq("depuis_magasin", true)
    .not("supplier_id", "is", null)
    .limit(500);

  if (error) throw new Error(error.message);

  const rows = (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const received = String(row.reception_status) === "RECEIVED";
    const putAway = Boolean(row.retour_stock_fait);
    const status: RestockHistoryStatus = putAway
      ? "RANGE"
      : received
        ? "RECU"
        : "COMMANDE";
    return {
      id: String(row.id),
      reference: String(row.reference ?? ""),
      referenceCommande: (row.reference_commande as string | null) || null,
      designation: String(row.nom_produit ?? ""),
      quantity: toNumber(row.quantity),
      supplierName: String(supplier?.name ?? "Fournisseur"),
      orderId: String(row.order_id),
      orderRef: String(order?.ref_demande ?? ""),
      status,
      date:
        (row.received_at as string | null) ??
        (row.prevue_le as string | null) ??
        (order?.date_commande as string | null) ??
        null,
    };
  });

  return rows.sort((a, b) =>
    String(b.date ?? "").localeCompare(String(a.date ?? "")),
  );
}

/**
 * Re-order a stock line from a supplier: it becomes an awaited reception.
 * The expected arrival is the tournée matching the time of the order (same
 * rule as client orders), and the supplier reference is stored next to the
 * original one — both stay searchable.
 */
export async function commandRestockLine(
  supabase: SupabaseClient,
  orgId: string,
  lineId: string,
  input: { supplierId: string; referenceCommande?: string | null },
): Promise<TourneeInfo> {
  const tournee = computeTournee(new Date());
  let tourId: string | null = null;
  try {
    tourId = await findOrCreateTour(supabase, orgId, tournee);
  } catch {
    tourId = null;
  }

  const refCmd = input.referenceCommande?.trim() || null;
  const update: Record<string, unknown> = {
    supplier_id: input.supplierId,
    a_commander_pour_livreur: true,
    reception_status: "PENDING",
    prevue_le: tournee.deliveryAt.toISOString(),
    reference_commande: refCmd,
  };
  if (tourId) update.tour_id = tourId;

  const { error } = await supabase
    .from("order_lines")
    .update(update)
    .eq("id", lineId)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
  return tournee;
}

export type StockItem = {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  updatedAt: string;
};

export async function loadStockItems(
  supabase: SupabaseClient,
  orgId: string,
): Promise<StockItem[]> {
  const { data, error } = await supabase
    .from("stock_items")
    .select("id,sku,name,quantity_on_hand,updated_at")
    .eq("organization_id", orgId)
    .order("sku");

  if (error) throw new Error(error.message);
  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      id: String(row.id),
      sku: String(row.sku ?? ""),
      name: String(row.name ?? ""),
      quantity: toNumber(row.quantity_on_hand),
      updatedAt: String(row.updated_at ?? ""),
    };
  });
}

export async function adjustStockItem(
  supabase: SupabaseClient,
  orgId: string,
  input: { sku: string; name: string; delta: number },
): Promise<void> {
  const rpc = await supabase.rpc("adjust_stock_item", {
    p_delta: input.delta,
    p_name: input.name || input.sku,
    p_sku: input.sku,
  });
  if (!rpc.error) return;
  if (!isMissingRpcError(rpc.error)) throw new Error(rpc.error.message);

  const sku = input.sku.trim();
  const { data: existing, error: existingErr } = await supabase
    .from("stock_items")
    .select("id,quantity_on_hand")
    .eq("organization_id", orgId)
    .eq("sku", sku)
    .maybeSingle();

  if (existingErr) throw new Error(existingErr.message);

  if (existing) {
    const row = existing as { id: string; quantity_on_hand: number };
    const { error } = await supabase
      .from("stock_items")
      .update({ quantity_on_hand: toNumber(row.quantity_on_hand) + input.delta })
      .eq("id", row.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return;
  }

  const { error } = await supabase.from("stock_items").insert({
    organization_id: orgId,
    sku,
    name: input.name.trim(),
    quantity_on_hand: input.delta,
  });
  if (error) throw new Error(error.message);
}

export type PartSearchResult = {
  kind: "stock" | "order-line";
  id: string;
  reference: string;
  /** Supplier reference (stock re-orders), when different from `reference`. */
  referenceCommande?: string | null;
  designation: string;
  quantity: number;
  source: string;
};

export async function searchParts(
  supabase: SupabaseClient,
  orgId: string,
  query: string,
): Promise<PartSearchResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const pattern = `%${q}%`;

  const [stockBySku, stockByName, linesByRef, linesByName, linesByRefCmd] = await Promise.all([
    supabase
      .from("stock_items")
      .select("id,sku,name,quantity_on_hand")
      .eq("organization_id", orgId)
      .ilike("sku", pattern)
      .limit(20),
    supabase
      .from("stock_items")
      .select("id,sku,name,quantity_on_hand")
      .eq("organization_id", orgId)
      .ilike("name", pattern)
      .limit(20),
    supabase
      .from("order_lines")
      .select("id,reference,reference_commande,nom_produit,quantity,orders(ref_demande)")
      .eq("organization_id", orgId)
      .ilike("reference", pattern)
      .limit(20),
    supabase
      .from("order_lines")
      .select("id,reference,reference_commande,nom_produit,quantity,orders(ref_demande)")
      .eq("organization_id", orgId)
      .ilike("nom_produit", pattern)
      .limit(20),
    supabase
      .from("order_lines")
      .select("id,reference,reference_commande,nom_produit,quantity,orders(ref_demande)")
      .eq("organization_id", orgId)
      .ilike("reference_commande", pattern)
      .limit(20),
  ]);

  for (const res of [stockBySku, stockByName, linesByRef, linesByName, linesByRefCmd]) {
    if (res.error) throw new Error(res.error.message);
  }

  const seen = new Set<string>();
  const results: PartSearchResult[] = [];

  for (const raw of [...(stockBySku.data ?? []), ...(stockByName.data ?? [])]) {
    const row = raw as Record<string, unknown>;
    const key = `stock:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      kind: "stock",
      id: String(row.id),
      reference: String(row.sku ?? ""),
      designation: String(row.name ?? ""),
      quantity: toNumber(row.quantity_on_hand),
      source: "Stock magasin",
    });
  }

  for (const raw of [
    ...(linesByRef.data ?? []),
    ...(linesByRefCmd.data ?? []),
    ...(linesByName.data ?? []),
  ]) {
    const row = raw as Record<string, unknown>;
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const key = `line:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      kind: "order-line",
      id: String(row.id),
      reference: String(row.reference ?? ""),
      referenceCommande: (row.reference_commande as string | null) || null,
      designation: String(row.nom_produit ?? ""),
      quantity: toNumber(row.quantity),
      source: String(order?.ref_demande ?? "Commande"),
    });
  }

  return results.slice(0, 30);
}

export type GarageSummary = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  city: string | null;
  rating: number | null;
  active: boolean;
  orders: number;
  revenue: number;
  outstanding: number;
};

export async function loadGarages(
  supabase: SupabaseClient,
  orgId: string,
): Promise<GarageSummary[]> {
  const [clientsRes, ordersRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id,name,phone,email,city,rating,is_active")
      .eq("organization_id", orgId)
      .eq("is_garage", true)
      .order("name"),
    supabase
      .from("orders")
      .select("client_id,montant_total,solde_restant")
      .eq("organization_id", orgId)
      .eq("devis", false),
  ]);

  if (clientsRes.error) throw new Error(clientsRes.error.message);
  if (ordersRes.error) throw new Error(ordersRes.error.message);

  const totals = new Map<string, { orders: number; revenue: number; outstanding: number }>();
  for (const raw of ordersRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const clientId = String(row.client_id ?? "");
    if (!clientId) continue;
    const current = totals.get(clientId) ?? { orders: 0, revenue: 0, outstanding: 0 };
    totals.set(clientId, {
      orders: current.orders + 1,
      revenue: current.revenue + toNumber(row.montant_total),
      outstanding: current.outstanding + Math.max(toNumber(row.solde_restant), 0),
    });
  }

  return (clientsRes.data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const t = totals.get(String(row.id)) ?? { orders: 0, revenue: 0, outstanding: 0 };
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      phone: (row.phone as string | null) ?? null,
      email: (row.email as string | null) ?? null,
      city: (row.city as string | null) ?? null,
      rating: row.rating == null ? null : toNumber(row.rating),
      active: row.is_active !== false,
      ...t,
    };
  });
}

export async function createGarage(
  supabase: SupabaseClient,
  orgId: string,
  input: { name: string; phone?: string; email?: string; city?: string },
): Promise<void> {
  const { error } = await supabase.from("clients").insert({
    organization_id: orgId,
    name: input.name.trim(),
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
    city: input.city?.trim() || null,
    is_garage: true,
    is_professional: true,
  });
  if (error) throw new Error(error.message);
}

export type ReturnRow = {
  id: string;
  ref: string;
  createdAt: string;
  supplier: string;
  client: string;
  reference: string;
  reason: string;
  type: string;
  treatment: string;
  decotePct: number;
  amount: number;
};

export async function loadReturns(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ReturnRow[]> {
  const { data, error } = await supabase
    .from("sales_returns")
    .select(
      "id,ref,created_at,order_id,reason,motif,designation,type_retour,statut_traitement,decote_pct,montant,clients(name),suppliers(name),orders(ref_demande,clients(name))",
    )
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);

  return (data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const orderClient = first(order?.clients as Embedded<Record<string, unknown>>);
    return {
      id: String(row.id),
      ref: String(row.ref ?? order?.ref_demande ?? row.order_id ?? "-"),
      createdAt: String(row.created_at ?? ""),
      supplier: String(supplier?.name ?? "Sans fournisseur"),
      client: String(client?.name ?? orderClient?.name ?? "Client non lie"),
      reference: String(row.designation ?? row.ref ?? "-"),
      reason: String(row.motif ?? row.reason ?? "-"),
      type: String(row.type_retour ?? "RETOURNABLE"),
      treatment: String(row.statut_traitement ?? "A_TRAITER"),
      decotePct: toNumber(row.decote_pct),
      amount: toNumber(row.montant),
    };
  });
}

export type ReturnTreatment =
  | "A_TRAITER"
  | "DEMANDE_ENVOYEE"
  | "A_RECUPERER"
  | "ACCEPTE"
  | "REFUSE"
  | "REMBOURSE"
  | "AVOIR";

/**
 * Advance a return through its treatment pipeline
 * (A_TRAITER → DEMANDE_ENVOYEE → A_RECUPERER → ACCEPTE/REFUSE → REMBOURSE).
 */
export async function updateReturnTreatment(
  supabase: SupabaseClient,
  orgId: string,
  returnId: string,
  treatment: ReturnTreatment,
): Promise<void> {
  const { error } = await supabase
    .from("sales_returns")
    .update({ statut_traitement: treatment })
    .eq("organization_id", orgId)
    .eq("id", returnId);
  if (error) throw new Error(error.message);
}

/* ------------------------------------------------------------------ */
/*  Walk-in refunds: a client comes back to the magasin and asks for a  */
/*  refund. Each order line can be refunded UNLESS it is flagged        */
/*  retour_impossible, or it was already refunded once.                 */
/* ------------------------------------------------------------------ */

export type RefundableLine = {
  id: string;
  reference: string;
  designation: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  retourImpossible: boolean;
  alreadyReturned: boolean;
};

export type RefundableOrder = {
  id: string;
  ref: string;
  date: string | null;
  clientId: string | null;
  client: string;
  total: number;
  lines: RefundableLine[];
};

export async function loadRefundableOrders(
  supabase: SupabaseClient,
  orgId: string,
): Promise<RefundableOrder[]> {
  const [ordersRes, returnsRes] = await Promise.all([
    supabase
      .from("orders")
      .select(
        "id,ref_demande,date_commande,client_id,montant_total,clients(name)," +
          "order_lines(id,reference,nom_produit,quantity,prix_vente_unitaire,retour_impossible)",
      )
      .eq("organization_id", orgId)
      .eq("devis", false)
      .order("date_commande", { ascending: false })
      .limit(150),
    supabase
      .from("sales_returns")
      .select("order_line_id")
      .eq("organization_id", orgId)
      .not("order_line_id", "is", null),
  ]);

  if (ordersRes.error) throw new Error(ordersRes.error.message);
  if (returnsRes.error) throw new Error(returnsRes.error.message);

  const returnedLineIds = new Set(
    (returnsRes.data ?? []).map((r) =>
      String((r as Record<string, unknown>).order_line_id),
    ),
  );

  return (ordersRes.data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    const lines = (
      (row.order_lines as Embedded<Record<string, unknown>>) as
        | Record<string, unknown>[]
        | undefined
    )?.map((l) => {
      const qty = toNumber(l.quantity);
      const unit = toNumber(l.prix_vente_unitaire);
      return {
        id: String(l.id),
        reference: String(l.reference ?? ""),
        designation: String(l.nom_produit ?? ""),
        quantity: qty,
        unitPrice: unit,
        lineTotal: qty * unit,
        retourImpossible: Boolean(l.retour_impossible),
        alreadyReturned: returnedLineIds.has(String(l.id)),
      };
    });
    return {
      id: String(row.id),
      ref: String(row.ref_demande ?? ""),
      date: (row.date_commande as string | null) ?? null,
      clientId: (row.client_id as string | null) ?? null,
      client: String(client?.name ?? row.client_phone ?? "Client comptoir"),
      total: toNumber(row.montant_total),
      lines: lines ?? [],
    };
  });
}

/** Next sequential avoir number for an org: AV-YYYY-NNNNN. */
async function nextAvoirSeq(
  supabase: SupabaseClient,
  orgId: string,
  year: number,
): Promise<number> {
  const prefix = `AV-${year}-`;
  const { data } = await supabase
    .from("credit_notes")
    .select("num")
    .eq("organization_id", orgId)
    .like("num", `${prefix}%`)
    .order("num", { ascending: false })
    .limit(1)
    .maybeSingle();
  const ref = (data as { num?: string } | null)?.num;
  if (ref) {
    const num = parseInt(ref.replace(prefix, ""), 10);
    if (!Number.isNaN(num)) return num + 1;
  }
  return 1;
}

/**
 * Record a walk-in return, compensated either in cash (REMBOURSE) or with a
 * credit note (AVOIR — one avoir for the whole return, valable 1 an comme
 * sur la feuille legacy). With compensation FOURNISSEUR (stock part sent
 * back to its supplier) nothing is paid to a client: the return simply
 * enters the supplier pipeline (A_TRAITER) on the Retours page.
 */
export async function createWalkInReturn(
  supabase: SupabaseClient,
  orgId: string,
  input: {
    orderId: string;
    clientId: string | null;
    reason: string;
    lines: RefundableLine[];
    compensation?: "REMBOURSEMENT" | "AVOIR" | "FOURNISSEUR";
    /** Supplier the part goes back to (FOURNISSEUR mode). */
    supplierId?: string | null;
  },
): Promise<{ avoirNum: string | null }> {
  const refundable = input.lines.filter(
    (l) => !l.retourImpossible && !l.alreadyReturned,
  );
  if (refundable.length === 0) {
    throw new Error("Aucune ligne remboursable sélectionnée.");
  }
  const toSupplier = input.compensation === "FOURNISSEUR";
  const asAvoir = input.compensation === "AVOIR";
  const motif =
    input.reason.trim() || (toSupplier ? "Retour fournisseur" : "Remboursement comptoir");

  const year = new Date().getFullYear();
  const stamp = Date.now() % 100000;
  const rows = refundable.map((l, i) => ({
    organization_id: orgId,
    client_id: input.clientId,
    order_id: input.orderId,
    order_line_id: l.id,
    ref: `RET-${year}-${String((stamp + i) % 100000).padStart(5, "0")}`,
    designation: l.designation,
    reason: motif,
    motif,
    type_retour: "RETOURNABLE",
    statut_traitement: toSupplier ? "A_TRAITER" : asAvoir ? "AVOIR" : "REMBOURSE",
    decote_pct: 0,
    montant: l.lineTotal,
    ...(toSupplier && input.supplierId ? { supplier_id: input.supplierId } : {}),
  }));

  const { error } = await supabase.from("sales_returns").insert(rows);
  if (error) throw new Error(error.message);

  if (!asAvoir) return { avoirNum: null };

  const total = refundable.reduce((s, l) => s + l.lineTotal, 0);
  const echeance = new Date();
  echeance.setFullYear(echeance.getFullYear() + 1);
  const seq = await nextAvoirSeq(supabase, orgId, year);
  const num = `AV-${year}-${String(seq).padStart(5, "0")}`;

  const { error: avErr } = await supabase.from("credit_notes").insert({
    organization_id: orgId,
    client_id: input.clientId,
    order_id: input.orderId,
    num,
    amount: total,
    used_amount: 0,
    statut: "EN_COURS",
    echeance: echeance.toISOString().slice(0, 10),
    motif,
    designation: refundable.map((l) => l.designation).join(", "),
  });
  if (avErr) {
    throw new Error(
      `Retour enregistré mais la création de l'avoir a échoué : ${avErr.message}`,
    );
  }
  return { avoirNum: num };
}

/* ------------------------------------------------------------------ */
/*  Avoirs as payment: pick a client's open credit notes at checkout.  */
/* ------------------------------------------------------------------ */

export type ClientCredit = {
  id: string;
  num: string;
  remaining: number;
  dueAt: string | null;
};

/** Open, unexpired avoirs of a client, most recent first. */
export async function loadClientCredits(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
): Promise<ClientCredit[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("credit_notes")
    .select("id,num,amount,used_amount,echeance")
    .eq("organization_id", orgId)
    .eq("client_id", clientId)
    .in("statut", ["EN_COURS", "PARTIEL"])
    .or(`echeance.is.null,echeance.gte.${today}`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);

  return (data ?? [])
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id),
        num: String(row.num ?? `AV-${String(row.id).slice(0, 8)}`),
        remaining: Math.max(0, toNumber(row.amount) - toNumber(row.used_amount)),
        dueAt: (row.echeance as string | null) ?? null,
      };
    })
    .filter((c) => c.remaining > 0);
}

export type CreditConsignRow = {
  id: string;
  kind: "avoir" | "consigne";
  createdAt: string;
  num: string;
  client: string;
  reference: string;
  motif: string;
  designation: string;
  amount: number;
  /** Avoir only: amount already consumed / balance left. */
  usedAmount: number;
  remaining: number;
  status: string;
  dueAt: string | null;
};

/** Effective avoir status: an unexhausted avoir past its échéance is EXPIRE. */
function effectiveCreditStatus(statut: string, dueAt: string | null): string {
  if (statut === "UTILISE") return statut;
  if (dueAt && new Date(dueAt).getTime() < Date.now() - 86_400_000) return "EXPIRE";
  return statut;
}

export async function loadCreditsAndConsignments(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CreditConsignRow[]> {
  const [creditsRes, consignRes] = await Promise.all([
    supabase
      .from("credit_notes")
      .select("id,num,created_at,amount,used_amount,statut,echeance,motif,designation,clients(name),orders!credit_notes_order_id_fkey(ref_demande)")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("consignment_entries")
      .select("id,num,created_at,montant,status,echeance,motif,description,clients(name)")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (creditsRes.error) throw new Error(creditsRes.error.message);
  if (consignRes.error) throw new Error(consignRes.error.message);

  const rows: CreditConsignRow[] = [];
  for (const raw of creditsRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const amount = toNumber(row.amount);
    const usedAmount = toNumber(row.used_amount);
    const dueAt = (row.echeance as string | null) ?? null;
    rows.push({
      id: String(row.id),
      kind: "avoir",
      createdAt: String(row.created_at ?? ""),
      num: String(row.num ?? `AV-${String(row.id).slice(0, 8)}`),
      client: String(client?.name ?? "Client non lie"),
      reference: String(order?.ref_demande ?? "-"),
      motif: String(row.motif ?? "Avoir client"),
      designation: String(row.designation ?? "-"),
      amount,
      usedAmount,
      remaining: Math.max(0, amount - usedAmount),
      status: effectiveCreditStatus(String(row.statut ?? "EN_COURS"), dueAt),
      dueAt,
    });
  }
  for (const raw of consignRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    rows.push({
      id: String(row.id),
      kind: "consigne",
      createdAt: String(row.created_at ?? ""),
      num: String(row.num ?? `CO-${String(row.id).slice(0, 8)}`),
      client: String(client?.name ?? "Client non lie"),
      reference: String(row.num ?? "-"),
      motif: String(row.motif ?? "Consigne pieces"),
      designation: String(row.description ?? "-"),
      amount: toNumber(row.montant),
      usedAmount: 0,
      remaining: toNumber(row.montant),
      status: String(row.status ?? "ACTIF"),
      dueAt: (row.echeance as string | null) ?? null,
    });
  }

  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type DeliveryTourRow = {
  id: string;
  name: string;
  date: string;
  status: string;
  vehicle: string | null;
  lineCount: number;
  pieceCount: number;
};

export async function loadDeliveryTours(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DeliveryTourRow[]> {
  const [toursRes, linesRes] = await Promise.all([
    supabase
      .from("delivery_tours")
      .select("id,name,tour_date,status,vehicle_label")
      .eq("organization_id", orgId)
      .order("tour_date", { ascending: false })
      .limit(100),
    supabase
      .from("order_lines")
      .select("tour_id,quantity")
      .eq("organization_id", orgId)
      .not("tour_id", "is", null),
  ]);

  if (toursRes.error) throw new Error(toursRes.error.message);
  if (linesRes.error) throw new Error(linesRes.error.message);

  const counts = new Map<string, { lines: number; pieces: number }>();
  for (const raw of linesRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const tourId = String(row.tour_id ?? "");
    if (!tourId) continue;
    const current = counts.get(tourId) ?? { lines: 0, pieces: 0 };
    counts.set(tourId, {
      lines: current.lines + 1,
      pieces: current.pieces + toNumber(row.quantity),
    });
  }

  return (toursRes.data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const c = counts.get(String(row.id)) ?? { lines: 0, pieces: 0 };
    return {
      id: String(row.id),
      name: String(row.name ?? ""),
      date: String(row.tour_date ?? ""),
      status: String(row.status ?? "PLANIFIEE"),
      vehicle: (row.vehicle_label as string | null) ?? null,
      lineCount: c.lines,
      pieceCount: c.pieces,
    };
  });
}

export type ReportsOverview = {
  orderCount: number;
  revenue: number;
  paid: number;
  outstanding: number;
  returnAmount: number;
  returnCount: number;
  creditAmount: number;
  topSuppliers: { name: string; pieces: number }[];
};

/**
 * Fetch every row of a query by paging through PostgREST's 1000-row cap.
 * `makeQuery` must build a FRESH query for the given range (builders mutate),
 * ordered by a stable column so pages never overlap.
 */
async function fetchAllPages<T>(
  makeQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let page = 0; page < 100; page += 1) {
    const from = page * PAGE;
    const { data, error } = await makeQuery(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function loadReportsOverview(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ReportsOverview> {
  // PostgREST silently caps un-paged selects at 1000 rows, which would make
  // every figure here quietly wrong at scale — page through everything.
  const [orders, returns, credits, lines] = await Promise.all([
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("orders")
        .select("montant_total,montant_paye,solde_restant")
        .eq("organization_id", orgId)
        .eq("devis", false)
        .order("id")
        .range(from, to),
    ),
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("sales_returns")
        .select("montant")
        .eq("organization_id", orgId)
        .order("id")
        .range(from, to),
    ),
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("credit_notes")
        .select("amount")
        .eq("organization_id", orgId)
        .order("id")
        .range(from, to),
    ),
    fetchAllPages<Record<string, unknown>>((from, to) =>
      supabase
        .from("order_lines")
        .select("quantity,suppliers(name)")
        .eq("organization_id", orgId)
        .not("supplier_id", "is", null)
        .order("id")
        .range(from, to),
    ),
  ]);

  const supplierCounts = new Map<string, number>();
  for (const row of lines) {
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    const name = String(supplier?.name ?? "Sans fournisseur");
    supplierCounts.set(name, (supplierCounts.get(name) ?? 0) + toNumber(row.quantity));
  }

  return {
    orderCount: orders.length,
    revenue: orders.reduce((sum, row) => sum + toNumber(row.montant_total), 0),
    paid: orders.reduce((sum, row) => sum + toNumber(row.montant_paye), 0),
    outstanding: orders.reduce((sum, row) => sum + toNumber(row.solde_restant), 0),
    returnCount: returns.length,
    returnAmount: returns.reduce((sum, row) => sum + toNumber(row.montant), 0),
    creditAmount: credits.reduce((sum, row) => sum + toNumber(row.amount), 0),
    topSuppliers: [...supplierCounts.entries()]
      .map(([name, pieces]) => ({ name, pieces }))
      .sort((a, b) => b.pieces - a.pieces)
      .slice(0, 5),
  };
}

export type OrganizationSettings = {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  plan: string | null;
  subscriptionStatus: string;
  seatLimit: number;
};

export async function loadOrganizationSettings(
  supabase: SupabaseClient,
  orgId: string,
): Promise<OrganizationSettings> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id,name,phone,address,city,plan,subscription_status,seat_limit")
    .eq("id", orgId)
    .single();

  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    phone: (row.phone as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    plan: (row.plan as string | null) ?? null,
    subscriptionStatus: String(row.subscription_status ?? "active"),
    seatLimit: toNumber(row.seat_limit),
  };
}

export async function updateOrganizationSettings(
  supabase: SupabaseClient,
  orgId: string,
  input: Pick<OrganizationSettings, "name" | "phone" | "address" | "city">,
): Promise<void> {
  const { error } = await supabase
    .from("organizations")
    .update({
      name: input.name.trim(),
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      city: input.city?.trim() || null,
    })
    .eq("id", orgId);
  if (error) throw new Error(error.message);
}
