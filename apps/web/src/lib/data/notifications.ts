import type { SupabaseClient } from "@supabase/supabase-js";

export type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
  readAt: string | null;
};

function map(raw: unknown): Notification {
  const r = raw as Record<string, unknown>;
  return {
    id: String(r.id),
    type: String(r.type ?? ""),
    title: String(r.title ?? ""),
    body: (r.body as string | null) ?? null,
    href: (r.href as string | null) ?? null,
    createdAt: String(r.created_at),
    readAt: (r.read_at as string | null) ?? null,
  };
}

/** Latest notifications visible to the signed-in user (RLS decides the audience). */
export async function loadNotifications(
  supabase: SupabaseClient,
  orgId: string,
  limit = 20,
): Promise<{ items: Notification[]; unread: number }> {
  const [listRes, countRes] = await Promise.all([
    supabase
      .from("notifications")
      .select("id,type,title,body,href,created_at,read_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(limit),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("read_at", null),
  ]);
  if (listRes.error) throw new Error(listRes.error.message);
  return { items: (listRes.data ?? []).map(map), unread: countRes.count ?? 0 };
}

export async function markNotificationsRead(supabase: SupabaseClient, ids?: string[]): Promise<void> {
  const { error } = await supabase.rpc("mark_notifications_read", { p_ids: ids && ids.length > 0 ? ids : null });
  if (error) throw new Error(error.message);
}

/** Relative time in French ("il y a 5 min"). */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  const min = Math.round(diff / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `il y a ${d} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
}
