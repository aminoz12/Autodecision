import type { SupabaseClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ */
/*  Delivery: the livreur's tour, proof of delivery, failures, links   */
/* ------------------------------------------------------------------ */

export const DELIVERY_FAILURE_REASONS = [
  "Client absent",
  "Adresse introuvable",
  "Client a refusé la livraison",
  "Pièce manquante ou abîmée",
  "Fermé / horaires",
  "Autre",
] as const;

export type TourPiece = {
  name: string;
  reference: string;
  quantity: number;
  /** Not received from the supplier yet: not in the van. */
  pending: boolean;
};

/** One stop of the livreur's tour — only what the mobile screen shows. */
export type TourStop = {
  id: string;
  ref: string;
  client: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  isGarage: boolean;
  workflow: string;
  dateEnvoi: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failedReason: string | null;
  attempts: number;
  note: string | null;
  pieces: TourPiece[];
};

export class LivreurDisabledError extends Error {
  constructor() {
    super("Votre accès livreur est désactivé. Contactez votre magasin.");
    this.name = "LivreurDisabledError";
  }
}

/** The request never reached the server (no network): safe to retry later. */
export class DeliveryNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryNetworkError";
  }
}

const NETWORK_RE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed|network connection was lost|appears to be offline/i;

export function isNetworkError(err: unknown): boolean {
  if (err instanceof DeliveryNetworkError) return true;
  return err instanceof Error && NETWORK_RE.test(err.message);
}

const SERVER_MESSAGES: Array<[RegExp, string]> = [
  [/already been delivered/i, "Cette commande est déjà marquée livrée."],
  [/assigned to another livreur/i, "Cette livraison a été confiée à un autre livreur."],
  [/has been cancelled/i, "Cette commande a été annulée par le magasin."],
  [/only a delivery in progress/i, "Cette commande n'est plus en cours de livraison : le magasin l'a reprise."],
  [/access is disabled/i, "Votre accès livreur est désactivé. Contactez votre magasin."],
  [/staff access is required|livreur access is required/i, "Accès refusé : reconnectez-vous avec votre compte livreur."],
  [/order not found/i, "Commande introuvable."],
  [/proof of delivery must be stored/i, "La photo n'a pas été enregistrée au bon endroit. Reprenez la photo."],
  [/row-level security/i, "Envoi refusé : cette livraison n'est plus à votre nom ou n'est plus en cours."],
  [/a reason is required/i, "Précisez le motif."],
  [/mime type|invalid_mime/i, "Format de photo non accepté (JPEG, PNG ou WebP)."],
  [/payload too large|maximum allowed size|exceeded the maximum/i, "Photo trop lourde (5 Mo maximum)."],
];

/** Server (English) error → what the livreur or the counter can act on. */
export function deliveryErrorMessage(raw: string): string {
  for (const [re, fr] of SERVER_MESSAGES) if (re.test(raw)) return fr;
  return raw;
}

function toDeliveryError(message: string): Error {
  return NETWORK_RE.test(message)
    ? new DeliveryNetworkError(message)
    : new Error(deliveryErrorMessage(message));
}

/** Google Maps directions deep link (works on iOS and Android, opens the app when installed). */
export function mapsLink(address: string | null, city: string | null): string | null {
  const q = [address, city].filter(Boolean).join(", ").trim();
  if (!q) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}

/** "Client absent — rappelé à 15 h"; "Autre" needs the detail. Empty when incomplete. */
export function buildFailureReason(reason: string, detail: string): string {
  const d = detail.trim();
  if (reason === "Autre") return d;
  return d ? `${reason} — ${d}` : reason;
}

/* ------------------------------------------------------------------ */
/*  Tour                                                              */
/* ------------------------------------------------------------------ */

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** livreur_tour() JSON → stops. */
export function parseTourStops(json: unknown): TourStop[] {
  if (!Array.isArray(json)) return [];
  return json
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const pieces = Array.isArray(r.pieces) ? r.pieces : [];
      return {
        id: String(r.id ?? ""),
        ref: String(r.ref ?? ""),
        client: text(r.client_name) ?? "Client",
        phone: text(r.client_phone),
        address: text(r.address),
        city: text(r.city),
        isGarage: r.is_garage === true,
        workflow: String(r.workflow ?? ""),
        dateEnvoi: text(r.date_envoi),
        deliveredAt: text(r.delivered_at),
        failedAt: text(r.failed_at),
        failedReason: text(r.failed_reason),
        attempts: count(r.attempts),
        note: text(r.note),
        pieces: pieces.map((p) => {
          const x = (p ?? {}) as Record<string, unknown>;
          return {
            name: String(x.name ?? ""),
            reference: String(x.reference ?? ""),
            quantity: count(x.quantity),
            pending: x.pending === true,
          };
        }),
      };
    })
    .filter((s) => s.id);
}

function time(v: string | null): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

function sameDay(v: string | null, now: Date): boolean {
  const t = time(v);
  return t !== null && new Date(t).toDateString() === now.toDateString();
}

export type TourSections = {
  /** In delivery, departure slot first (no slot last). */
  toDeliver: TourStop[];
  /** Reported « non livrée » today, latest first. */
  failedToday: TourStop[];
  /** Delivered today, latest first. */
  deliveredToday: TourStop[];
};

export function splitTour(stops: TourStop[], now: Date = new Date()): TourSections {
  const latestFirst = (pick: (s: TourStop) => string | null) => (a: TourStop, b: TourStop) =>
    (time(pick(b)) ?? 0) - (time(pick(a)) ?? 0);
  return {
    toDeliver: stops
      .filter((s) => s.workflow === "IN_TRANSIT")
      .sort((a, b) => {
        const ta = time(a.dateEnvoi);
        const tb = time(b.dateEnvoi);
        if (ta !== tb) return ta === null ? 1 : tb === null ? -1 : ta - tb;
        return a.ref.localeCompare(b.ref);
      }),
    failedToday: stops
      .filter((s) => s.workflow !== "IN_TRANSIT" && s.workflow !== "DELIVERED" && sameDay(s.failedAt, now))
      .sort(latestFirst((s) => s.failedAt)),
    deliveredToday: stops
      .filter((s) => s.workflow === "DELIVERED" && sameDay(s.deliveredAt, now))
      .sort(latestFirst((s) => s.deliveredAt)),
  };
}

function directRowToStop(raw: unknown): TourStop {
  const row = raw as Record<string, unknown>;
  const clients = row.clients as Record<string, unknown> | Record<string, unknown>[] | null;
  const client = Array.isArray(clients) ? clients[0] ?? null : clients;
  const lines = (row.order_lines as Record<string, unknown>[] | null) ?? [];
  const phone = text(row.client_phone);
  return {
    id: String(row.id),
    ref: String(row.ref_demande ?? ""),
    client: text(client?.name) ?? (phone && phone !== "-" ? phone : "Client"),
    phone: text(client?.phone) ?? (phone && phone !== "-" ? phone : null),
    address: text(client?.address),
    city: text(client?.city),
    isGarage: client?.is_garage === true,
    workflow: String(row.workflow_status ?? ""),
    dateEnvoi: text(row.date_envoi),
    deliveredAt: text(row.delivered_at),
    failedAt: text(row.delivery_failed_at),
    failedReason: text(row.delivery_failed_reason),
    attempts: count(row.delivery_attempts),
    note: text(row.consigne),
    pieces: lines
      .filter((l) => l.reception_status !== "NOT_RECEIVED")
      .map((l) => ({
        name: String(l.nom_produit ?? ""),
        reference: String(l.reference ?? ""),
        quantity: count(l.quantity),
        pending: !l.depuis_magasin && ["PENDING", "BACKORDER", "PARTIAL"].includes(String(l.reception_status)),
      })),
  };
}

/** Before migration 20260914010000 is pushed: the livreur still reads orders through RLS. */
async function loadTourDirect(
  supabase: SupabaseClient,
  orgId: string,
  livreurId: string,
  now: Date,
): Promise<TourStop[]> {
  const cols =
    "id,ref_demande,workflow_status,date_envoi,delivered_at,delivery_attempts,delivery_failed_reason,delivery_failed_at,consigne,client_phone," +
    "clients(name,phone,address,city,is_garage),order_lines(nom_produit,reference,quantity,reception_status,depuis_magasin)";
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const base = () =>
    supabase
      .from("orders")
      .select(cols)
      .eq("organization_id", orgId)
      .eq("livreur_id", livreurId)
      .eq("devis", false)
      .is("cancelled_at", null);
  const results = await Promise.all([
    base().eq("workflow_status", "IN_TRANSIT").limit(300),
    base().eq("workflow_status", "DELIVERED").gte("delivered_at", since).limit(300),
    base().not("workflow_status", "in", "(IN_TRANSIT,DELIVERED)").gte("delivery_failed_at", since).limit(300),
  ]);
  const rows: unknown[] = [];
  for (const r of results) {
    if (r.error) throw toDeliveryError(r.error.message);
    rows.push(...(r.data ?? []));
  }
  return rows.map(directRowToStop);
}

/** The signed-in livreur's tour: in delivery + delivered / failed today. */
export async function loadLivreurTour(
  supabase: SupabaseClient,
  ctx: { orgId: string; livreurId: string },
  now: Date = new Date(),
): Promise<TourStop[]> {
  const { data, error } = await supabase.rpc("livreur_tour");
  if (!error) return parseTourStops(data);
  if (/access is disabled/i.test(error.message)) throw new LivreurDisabledError();
  if (error.code === "PGRST202" || /could not find the function/i.test(error.message)) {
    return loadTourDirect(supabase, ctx.orgId, ctx.livreurId, now);
  }
  throw toDeliveryError(error.message);
}

/* ------------------------------------------------------------------ */
/*  Outcomes                                                          */
/* ------------------------------------------------------------------ */

/** Storage path of a proof photo: <org>/<order>-<timestamp>.<ext> (checked by the RPC). */
export function proofPath(orgId: string, orderId: string, mimeType: string, stamp: number): string {
  const ext = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
  return `${orgId}/${orderId}-${stamp}.${ext}`;
}

/** Upload the proof photo to the private `pod` bucket. */
export async function uploadProofOfDelivery(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
  file: Blob,
): Promise<string> {
  const path = proofPath(orgId, orderId, file.type, Date.now());
  const { error } = await supabase.storage
    .from("pod")
    .upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
  if (error) throw toDeliveryError(error.message);
  return path;
}

export async function deliverOrder(
  supabase: SupabaseClient,
  input: { orderId: string; recipient?: string; note?: string; podPath?: string | null },
): Promise<void> {
  const { error } = await supabase.rpc("mark_order_delivered", {
    p_order_id: input.orderId,
    p_recipient: input.recipient?.trim() || null,
    p_note: input.note?.trim() || null,
    p_pod_path: input.podPath ?? null,
  });
  if (error) throw toDeliveryError(error.message);
}

export async function reportDeliveryFailure(
  supabase: SupabaseClient,
  input: { orderId: string; reason: string },
): Promise<void> {
  const { error } = await supabase.rpc("report_delivery_failure", {
    p_order_id: input.orderId,
    p_reason: input.reason.trim(),
  });
  if (error) throw toDeliveryError(error.message);
}

/** Signed URL (1 h) to view a proof photo — staff only through RLS on storage. */
export async function proofUrl(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from("pod").createSignedUrl(path, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/** Counter side: record the delivery address the livreur navigates to. */
export async function updateClientAddress(
  supabase: SupabaseClient,
  orgId: string,
  clientId: string,
  input: { address: string; city: string },
): Promise<void> {
  const { error } = await supabase
    .from("clients")
    .update({
      address: input.address.trim() || null,
      city: input.city.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", clientId)
    .eq("organization_id", orgId);
  if (error) throw new Error(error.message);
}

/** Shrink a camera photo client-side (max 1280 px, JPEG 0.8) before upload. */
export async function compressImage(file: File): Promise<File> {
  if (typeof window === "undefined" || !("createImageBitmap" in window)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 900_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
