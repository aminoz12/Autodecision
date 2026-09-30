"use client";

import { Bell, CheckCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { useNotifications, useNotificationsFeed } from "@/components/providers/NotificationsProvider";
import { relativeTime } from "@/lib/data/notifications";

/**
 * In-app notification bell, shared by the three spaces. Reads the shared feed
 * when a NotificationsProvider is above (dashboard shell); otherwise it runs
 * its own feed (garagiste portal, livreur page).
 */
export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const { profile } = useAuth();
  const shared = useNotifications();
  const own = useNotificationsFeed(shared ? null : profile?.organization_id ?? null);
  const { items, unread, readAll, readOne } = shared ?? own;
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

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
