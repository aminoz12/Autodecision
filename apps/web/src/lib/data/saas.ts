import type { SupabaseClient } from "@supabase/supabase-js";

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
      "id,order_id,reference,nom_produit,supplier_id,quantity,qte_recue,prevue_le,received_at,reception_status,orders(ref_demande,date_commande,client_phone,clients(name,phone)),suppliers(name)",
    )
    .eq("organization_id", orgId)
    .neq("reception_status", "RECEIVED")
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

/** Re-order a stock line from a supplier: it becomes an awaited reception. */
export async function commandRestockLine(
  supabase: SupabaseClient,
  orgId: string,
  lineId: string,
  input: { supplierId: string; prixAchat?: number; prevueLe?: string | null },
): Promise<void> {
  const update: Record<string, unknown> = {
    supplier_id: input.supplierId,
    a_commander_pour_livreur: true,
    reception_status: "PENDING",
  };
  if (input.prixAchat != null && input.prixAchat > 0) {
    update.prix_achat_unitaire = input.prixAchat;
  }
  if (input.prevueLe) update.prevue_le = input.prevueLe;

  const { error } = await supabase
    .from("order_lines")
    .update(update)
    .eq("id", lineId)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
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

  const [stockBySku, stockByName, linesByRef, linesByName] = await Promise.all([
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
      .select("id,reference,nom_produit,quantity,orders(ref_demande)")
      .eq("organization_id", orgId)
      .ilike("reference", pattern)
      .limit(20),
    supabase
      .from("order_lines")
      .select("id,reference,nom_produit,quantity,orders(ref_demande)")
      .eq("organization_id", orgId)
      .ilike("nom_produit", pattern)
      .limit(20),
  ]);

  for (const res of [stockBySku, stockByName, linesByRef, linesByName]) {
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

  for (const raw of [...(linesByRef.data ?? []), ...(linesByName.data ?? [])]) {
    const row = raw as Record<string, unknown>;
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const key = `line:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      kind: "order-line",
      id: String(row.id),
      reference: String(row.reference ?? ""),
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
      .eq("organization_id", orgId),
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
  status: string;
  dueAt: string | null;
};

export async function loadCreditsAndConsignments(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CreditConsignRow[]> {
  const [creditsRes, consignRes] = await Promise.all([
    supabase
      .from("credit_notes")
      .select("id,num,created_at,amount,statut,echeance,motif,designation,clients(name),orders(ref_demande)")
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
    rows.push({
      id: String(row.id),
      kind: "avoir",
      createdAt: String(row.created_at ?? ""),
      num: String(row.num ?? `AV-${String(row.id).slice(0, 8)}`),
      client: String(client?.name ?? "Client non lie"),
      reference: String(order?.ref_demande ?? "-"),
      motif: String(row.motif ?? "Avoir client"),
      designation: String(row.designation ?? "-"),
      amount: toNumber(row.amount),
      status: String(row.statut ?? "EN_COURS"),
      dueAt: (row.echeance as string | null) ?? null,
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

export async function loadReportsOverview(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ReportsOverview> {
  const [ordersRes, returnsRes, creditsRes, linesRes] = await Promise.all([
    supabase
      .from("orders")
      .select("montant_total,montant_paye,solde_restant")
      .eq("organization_id", orgId),
    supabase
      .from("sales_returns")
      .select("montant")
      .eq("organization_id", orgId),
    supabase
      .from("credit_notes")
      .select("amount")
      .eq("organization_id", orgId),
    supabase
      .from("order_lines")
      .select("quantity,suppliers(name)")
      .eq("organization_id", orgId)
      .not("supplier_id", "is", null),
  ]);

  for (const res of [ordersRes, returnsRes, creditsRes, linesRes]) {
    if (res.error) throw new Error(res.error.message);
  }

  const supplierCounts = new Map<string, number>();
  for (const raw of linesRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const supplier = first(row.suppliers as Embedded<Record<string, unknown>>);
    const name = String(supplier?.name ?? "Sans fournisseur");
    supplierCounts.set(name, (supplierCounts.get(name) ?? 0) + toNumber(row.quantity));
  }

  return {
    orderCount: ordersRes.data?.length ?? 0,
    revenue: (ordersRes.data ?? []).reduce((sum, row) => sum + toNumber(row.montant_total), 0),
    paid: (ordersRes.data ?? []).reduce((sum, row) => sum + toNumber(row.montant_paye), 0),
    outstanding: (ordersRes.data ?? []).reduce((sum, row) => sum + toNumber(row.solde_restant), 0),
    returnCount: returnsRes.data?.length ?? 0,
    returnAmount: (returnsRes.data ?? []).reduce((sum, row) => sum + toNumber(row.montant), 0),
    creditAmount: (creditsRes.data ?? []).reduce((sum, row) => sum + toNumber(row.amount), 0),
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
