import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateOrderPayload } from "@/lib/types/api";

/* ------------------------------------------------------------------ */
/*  Delivery tournées — fixed by order creation time:                  */
/*    17:00–09:30  → Tournée 1, livraison 10:00                         */
/*    09:31–12:00  → Tournée 2, livraison 13:00                         */
/*    12:01–14:30  → Tournée 3, livraison 15:00                         */
/*    14:31–17:00  → Tournée 4, livraison 17:30                         */
/* ------------------------------------------------------------------ */

export type TourneeInfo = {
  number: 1 | 2 | 3 | 4;
  name: string;
  /** Scheduled delivery datetime. */
  deliveryAt: Date;
  /** Delivery date (yyyy-mm-dd). */
  tourDate: string;
  /** Delivery time "HH:MM". */
  slot: string;
};

function ymdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function computeTournee(now: Date = new Date()): TourneeInfo {
  const mins = now.getHours() * 60 + now.getMinutes();
  let number: 1 | 2 | 3 | 4;
  let hour: number;
  let minute = 0;

  if (mins >= 571 && mins <= 720) {
    number = 2;
    hour = 13;
  } else if (mins >= 721 && mins <= 870) {
    number = 3;
    hour = 15;
  } else if (mins >= 871 && mins <= 1020) {
    number = 4;
    hour = 17;
    minute = 30;
  } else {
    // 17:01–23:59 and 00:00–09:30
    number = 1;
    hour = 10;
  }

  const deliveryAt = new Date(now);
  deliveryAt.setHours(hour, minute, 0, 0);
  // Evening orders (after 17:00) are delivered the next morning at 10:00.
  if (number === 1 && mins > 1020) {
    deliveryAt.setDate(deliveryAt.getDate() + 1);
  }

  return {
    number,
    name: `Tournée ${number}`,
    deliveryAt,
    tourDate: ymdLocal(deliveryAt),
    slot: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/** Find (or create) the delivery_tours row for a tournée on its delivery date. */
export async function findOrCreateTour(
  supabase: SupabaseClient,
  orgId: string,
  t: TourneeInfo,
): Promise<string | null> {
  const { data: existing, error: selErr } = await supabase
    .from("delivery_tours")
    .select("id")
    .eq("organization_id", orgId)
    .eq("name", t.name)
    .eq("tour_date", t.tourDate)
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return String((existing as { id: string }).id);

  const { data, error } = await supabase
    .from("delivery_tours")
    .insert({
      organization_id: orgId,
      name: t.name,
      tour_date: t.tourDate,
      slot_start: t.slot,
    })
    .select("id")
    .single();
  if (error) throw error;
  return String((data as { id: string }).id);
}

/** Next sequential consigne register number for an org: CO-YYYY-NNNNN. */
export async function createOrderWithLines(
  supabase: SupabaseClient,
  _userId: string,
  _orgId: string,
  payload: CreateOrderPayload,
) {
  // Tenant, financial values, reference allocation, consignes, stock, and
  // delivery scheduling are all derived by PostgreSQL in one transaction.
  const { data, error } = await supabase.rpc("create_order_with_lines", {
    p_payload: payload,
  });
  if (error) throw new Error(error.message);

  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        id?: string;
        ref_demande?: string;
        tour_name?: string | null;
        delivery_at?: string | null;
      }
    | null;
  if (!row?.id || !row.ref_demande) {
    throw new Error("La commande n'a pas pu etre creee.");
  }

  return {
    id: row.id,
    ref_demande: row.ref_demande,
    tourName: row.tour_name ?? "",
    deliveryAt: row.delivery_at ?? null,
    avoirWarning: null,
  };
}

/**
 * Assign the tournée for an order that becomes confirmed later (e.g. an
 * accepted devis): fixes the tour from now, schedules date_envoi, tags lines.
 */
export async function assignOrderTournee(
  supabase: SupabaseClient,
  orgId: string,
  orderId: string,
): Promise<string | null> {
  const tournee = computeTournee(new Date());
  let tourId: string | null = null;
  try {
    tourId = await findOrCreateTour(supabase, orgId, tournee);
  } catch {
    tourId = null;
  }
  await supabase
    .from("orders")
    .update({ date_envoi: tournee.deliveryAt.toISOString() })
    .eq("id", orderId)
    .eq("organization_id", orgId);
  if (tourId) {
    await supabase
      .from("order_lines")
      .update({ tour_id: tourId })
      .eq("order_id", orderId)
      .eq("organization_id", orgId);
  }
  return tourId;
}
