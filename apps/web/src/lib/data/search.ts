import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Global search — orders, clients, garages, parts, stock in one go.  */
/* ------------------------------------------------------------------ */

export type SearchHit = {
  kind: "order" | "client" | "garage" | "part" | "stock";
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** Small right-aligned tag (status, quantity…). */
  tag?: string;
};

export type SearchResults = {
  orders: SearchHit[];
  clients: SearchHit[];
  garages: SearchHit[];
  parts: SearchHit[];
  stock: SearchHit[];
  total: number;
};

type Embedded<T> = T | T[] | null | undefined;
function first<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

/** PostgREST `or=` filters break on commas/parentheses: strip them. */
function pattern(q: string): string {
  const clean = q.replace(/[,()%_]/g, " ").trim().replace(/\s+/g, " ");
  return `%${clean}%`;
}

const WORKFLOW: Record<string, string> = {
  PENDING: "En attente",
  TO_COLLECT: "En préparation",
  IN_TRANSIT: "En livraison",
  DELIVERED: "Livrée",
};

export async function globalSearch(
  supabase: SupabaseClient,
  orgId: string,
  query: string,
): Promise<SearchResults> {
  const q = query.trim();
  const empty: SearchResults = { orders: [], clients: [], garages: [], parts: [], stock: [], total: 0 };
  if (q.length < 2) return empty;
  const p = pattern(q);
  const digits = q.replace(/\D/g, "");
  const phoneP = digits.length >= 4 ? `%${digits.split("").join("%")}%` : null;

  const [ordersRes, clientsRes, linesRes, stockRes] = await Promise.all([
    supabase
      .from("orders")
      .select("id,ref_demande,date_commande,client_phone,immatriculation,vehicle_model,workflow_status,montant_total,clients(name)")
      .eq("organization_id", orgId)
      .eq("devis", false)
      .or(
        [
          `ref_demande.ilike.${p}`,
          `immatriculation.ilike.${p}`,
          `vehicle_model.ilike.${p}`,
          `client_phone.ilike.${p}`,
          ...(phoneP ? [`client_phone.ilike.${phoneP}`] : []),
        ].join(","),
      )
      .order("createdAt", { ascending: false })
      .limit(6),
    supabase
      .from("clients")
      .select("id,name,phone,email,immatriculation,vehicle_model,city,is_garage")
      .eq("organization_id", orgId)
      .or(
        [
          `name.ilike.${p}`,
          `phone.ilike.${p}`,
          `email.ilike.${p}`,
          `immatriculation.ilike.${p}`,
          `vehicle_model.ilike.${p}`,
          ...(phoneP ? [`phone.ilike.${phoneP}`] : []),
        ].join(","),
      )
      .order("name")
      .limit(8),
    supabase
      .from("order_lines")
      .select("id,order_id,reference,reference_commande,nom_produit,quantity,reception_status,orders!inner(ref_demande,devis,client_phone,clients(name))")
      .eq("organization_id", orgId)
      .eq("orders.devis", false)
      .or(`reference.ilike.${p},reference_commande.ilike.${p},nom_produit.ilike.${p}`)
      .limit(6),
    supabase
      .from("stock_items")
      .select("id,sku,name,quantity_on_hand")
      .eq("organization_id", orgId)
      .or(`sku.ilike.${p},name.ilike.${p}`)
      .limit(5),
  ]);
  for (const r of [ordersRes, clientsRes, linesRes, stockRes]) {
    if (r.error) throw new Error(r.error.message);
  }

  const orders: SearchHit[] = (ordersRes.data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const client = first(row.clients as Embedded<Record<string, unknown>>);
    return {
      kind: "order",
      id: String(row.id),
      title: String(row.ref_demande ?? ""),
      subtitle: [
        client?.name ?? row.client_phone ?? "Client comptoir",
        row.vehicle_model,
        row.immatriculation,
        row.date_commande ? new Date(String(row.date_commande)).toLocaleDateString("fr-FR") : null,
      ]
        .filter(Boolean)
        .join(" · "),
      href: `/dashboard/commandes/${row.id}`,
      tag: WORKFLOW[String(row.workflow_status)] ?? String(row.workflow_status ?? ""),
    };
  });

  const clients: SearchHit[] = [];
  const garages: SearchHit[] = [];
  for (const raw of clientsRes.data ?? []) {
    const row = raw as Record<string, unknown>;
    const isGarage = row.is_garage === true;
    const hit: SearchHit = {
      kind: isGarage ? "garage" : "client",
      id: String(row.id),
      title: String(row.name ?? ""),
      subtitle: [row.phone, row.vehicle_model, row.immatriculation, row.city].filter(Boolean).join(" · "),
      href: isGarage ? "/dashboard/garages" : `/dashboard/clients/${row.id}`,
    };
    (isGarage ? garages : clients).push(hit);
  }

  const parts: SearchHit[] = (linesRes.data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const order = first(row.orders as Embedded<Record<string, unknown>>);
    const client = first(order?.clients as Embedded<Record<string, unknown>>);
    return {
      kind: "part",
      id: String(row.id),
      title: `${row.reference}${row.reference_commande && row.reference_commande !== row.reference ? ` (${row.reference_commande})` : ""} — ${row.nom_produit ?? ""}`,
      subtitle: `${order?.ref_demande ?? ""} · ${client?.name ?? order?.client_phone ?? "Client comptoir"} · ×${toNumber(row.quantity)}`,
      href: `/dashboard/commandes/${row.order_id}`,
      tag:
        String(row.reception_status) === "RECEIVED"
          ? "Reçue"
          : String(row.reception_status) === "BACKORDER"
            ? "Reliquat"
            : String(row.reception_status) === "NOT_RECEIVED"
              ? "Non reçue"
              : "En attente",
    };
  });

  const stock: SearchHit[] = (stockRes.data ?? []).map((raw) => {
    const row = raw as Record<string, unknown>;
    const qty = toNumber(row.quantity_on_hand);
    return {
      kind: "stock",
      id: String(row.id),
      title: String(row.sku ?? ""),
      subtitle: String(row.name ?? ""),
      href: "/dashboard/stock",
      tag: `${qty} en stock`,
    };
  });

  return {
    orders,
    clients,
    garages,
    parts,
    stock,
    total: orders.length + clients.length + garages.length + parts.length + stock.length,
  };
}
