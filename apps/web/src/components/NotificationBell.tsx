"use client";

import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import {
  loadNotifications,
  markNotificationsRead,
  relativeTime,
  type Notification,
} from "@/lib/data/notifications";

/**
 * In-app notification bell, shared by the three spaces. RLS decides what
 * each account sees (staff of the org / one garage / one livreur). Live via
 * Supabase Realtime, with a 60 s poll as fallback; also pings the email
 * dispatcher so pending emails leave within a minute of the event.
 */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const { supabase, profile } = useAuth();
  const orgId = profile?.organization_id;
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    try {
      const { items: list, unread: n } = await loadNotifications(supabase, orgId);
      setItems(list);
      setUnread(n);
    } catch {
      /* the bell is best-effort */
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void refresh();
    if (!orgId) return;
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

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const readAll = async () => {
    try {
      await markNotificationsRead(supabase);
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      setUnread(0);
    } catch {
      /* ignore */
    }
  };

  const readOne = (n: Notification) => {
    if (n.readAt) return;
    void markNotificationsRead(supabase, [n.id]).catch(() => {});
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
    setUnread((u) => Math.max(0, u - 1));
  };

  return (
    <div className={`nb-wrap${compact ? " nb-wrap--compact" : ""}`} ref={wrap}>
      <button
        type="button"
        className="nb-btn"
        aria-label={unread > 0 ? `${unread} notification(s) non lue(s)` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Bell className="h-5 w-5" />
        {unread > 0 && <span className="nb-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="nb-panel" role="dialog" aria-label="Notifications">
          <div className="nb-head">
            <strong>Notifications</strong>
            <button type="button" className="nb-readall" onClick={() => void readAll()} disabled={unread === 0}>
              <CheckCheck className="h-3.5 w-3.5" /> Tout marquer lu
            </button>
          </div>
          <div className="nb-list">
            {items.length === 0 && <p className="nb-empty">Rien pour l&apos;instant.</p>}
            {items.map((n) => {
              const inner = (
                <>
                  <span className={`nb-dot${n.readAt ? "" : " is-unread"}`} />
                  <span className="nb-text">
                    <span className="nb-title">{n.title}</span>
                    {n.body && <span className="nb-body">{n.body}</span>}
                    <span className="nb-time">{relativeTime(n.createdAt)}</span>
                  </span>
                </>
              );
              return n.href ? (
                <Link key={n.id} href={n.href} className="nb-item" onClick={() => { readOne(n); setOpen(false); }}>
                  {inner}
                </Link>
              ) : (
                <button key={n.id} type="button" className="nb-item" onClick={() => readOne(n)}>
                  {inner}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
