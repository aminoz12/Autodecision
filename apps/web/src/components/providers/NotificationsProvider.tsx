"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import {
  loadNotifications,
  loadUnreadHrefs,
  markNotificationsRead,
  type Notification,
} from "@/lib/data/notifications";

export type NotificationsFeed = {
  items: Notification[];
  unread: number;
  /** Destination of every unread notification (one entry per notification). */
  unreadHrefs: string[];
  refresh: () => Promise<void>;
  readAll: () => Promise<void>;
  readOne: (n: Notification) => void;
};

/**
 * Notifications of the signed-in account: latest items, unread count and the
 * unread destinations (for the per-page counters in the menu). RLS decides
 * what each account sees. Live through Supabase Realtime, with a 60 s poll as
 * fallback; also pings the email dispatcher so pending emails leave within a
 * minute of the event. Pass `null` to keep the hook idle (a provider higher
 * in the tree already feeds the component).
 */
export function useNotificationsFeed(orgId: string | null | undefined): NotificationsFeed {
  const { supabase } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [unreadHrefs, setUnreadHrefs] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    try {
      const [{ items: list, unread: n }, hrefs] = await Promise.all([
        loadNotifications(supabase, orgId),
        loadUnreadHrefs(supabase, orgId),
      ]);
      setItems(list);
      setUnread(n);
      setUnreadHrefs(hrefs);
    } catch {
      /* the feed is best-effort */
    }
  }, [supabase, orgId]);

  useEffect(() => {
    if (!orgId) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const channel = supabase
      .channel(`notifications:${orgId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "notifications", filter: `organization_id=eq.${orgId}` },
        () => void refresh(),
      )
      .subscribe();
    // Opportunistic email fan-out (server-side, rate limited).
    const ping = () => void fetch("/api/notifications/dispatch", { method: "POST" }).catch(() => {});
    ping();
    const pingTimer = window.setInterval(ping, 5 * 60_000);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(pingTimer);
      void supabase.removeChannel(channel);
    };
  }, [supabase, orgId, refresh]);

  const readAll = useCallback(async () => {
    try {
      await markNotificationsRead(supabase);
      const at = new Date().toISOString();
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? at })));
      setUnread(0);
      setUnreadHrefs([]);
    } catch {
      /* ignore */
    }
  }, [supabase]);

  const readOne = useCallback(
    (n: Notification) => {
      if (n.readAt) return;
      void markNotificationsRead(supabase, [n.id]).catch(() => {});
      const at = new Date().toISOString();
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: at } : x)));
      setUnread((u) => Math.max(0, u - 1));
      const href = n.href;
      if (href) {
        setUnreadHrefs((prev) => {
          const i = prev.indexOf(href);
          if (i < 0) return prev;
          const next = prev.slice();
          next.splice(i, 1);
          return next;
        });
      }
    },
    [supabase],
  );

  return useMemo(
    () => ({ items, unread, unreadHrefs, refresh, readAll, readOne }),
    [items, unread, unreadHrefs, refresh, readAll, readOne],
  );
}

const Ctx = createContext<NotificationsFeed | null>(null);

/** One feed for the whole shell: the bell in the top bar and the counters in the menu share it. */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  const feed = useNotificationsFeed(profile?.organization_id ?? null);
  return <Ctx.Provider value={feed}>{children}</Ctx.Provider>;
}

/** The shared feed when a provider is above, else null. */
export function useNotifications(): NotificationsFeed | null {
  return useContext(Ctx);
}

/**
 * Unread notifications per menu destination. Each notification href is matched
 * to the most specific menu href (query string ignored); the dashboard root
 * only counts exact matches.
 */
export function countByDestination(unreadHrefs: string[], menuHrefs: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const sorted = [...menuHrefs].sort((a, b) => b.length - a.length);
  for (const raw of unreadHrefs) {
    const path = raw.split(/[?#]/)[0];
    const hit = sorted.find((h) => path === h || (h !== "/dashboard" && path.startsWith(`${h}/`)));
    if (!hit) continue;
    counts[hit] = (counts[hit] ?? 0) + 1;
  }
  return counts;
}
