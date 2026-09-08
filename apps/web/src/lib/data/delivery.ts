import type { SupabaseClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ */
/*  Delivery: proof of delivery, failures, navigation links            */
/* ------------------------------------------------------------------ */

export const DELIVERY_FAILURE_REASONS = [
  "Client absent",
  "Adresse introuvable",
  "Client a refusé la livraison",
  "Pièce manquante ou abîmée",
  "Fermé / horaires",
  "Autre",
] as const;

/** Google Maps directions deep link (works on iOS and Android, opens the app when installed). */
export function mapsLink(address: string | null, city: string | null): string | null {
  const q = [address, city].filter(Boolean).join(", ").trim();
  if (!q) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}

/** Upload the proof photo to the private `pod` bucket (path = <org>/<order>-<ts>.jpg). */
export async function uploadProofOfDelivery(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
  file: File,
): Promise<string> {
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${orgId}/${orderId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("pod").upload(path, file, { contentType: file.type || "image/jpeg", upsert: false });
  if (error) throw new Error(error.message);
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
  if (error) throw new Error(error.message);
}

export async function reportDeliveryFailure(
  supabase: SupabaseClient,
  input: { orderId: string; reason: string },
): Promise<void> {
  const { error } = await supabase.rpc("report_delivery_failure", {
    p_order_id: input.orderId,
    p_reason: input.reason.trim(),
  });
  if (error) throw new Error(error.message);
}

/** Signed URL (1 h) to view a proof photo — staff only through RLS on storage. */
export async function proofUrl(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from("pod").createSignedUrl(path, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
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
