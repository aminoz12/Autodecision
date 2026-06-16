"use client";

import {
  Box,
  Check,
  CheckCircle2,
  Clock,
  ClipboardCheck,
  FileText,
  Hourglass,
  Info,
  Loader2,
  MessageSquare,
  RefreshCw,
  Truck,
  User,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { markLineReceived } from "@/lib/data/saas";
import {
  loadReceptionBoard,
  loadSmsStates,
  markLinePutAway,
  markOrderSmsTreated,
  recordSmsSent,
  setLineReceptionStatus,
  type BoardLine,
  type ReceptionStatus,
  type SmsState,
} from "@/lib/data/commandes";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const STATUT: Record<
  ReceptionStatus,
  { label: string; cls: string; icon: LucideIcon }
> = {
  PENDING: { label: "En attente", cls: "attente", icon: Clock },
  RECEIVED: { label: "Reçu", cls: "recu", icon: CheckCircle2 },
  BACKORDER: { label: "Reliquat", cls: "reliquat", icon: Hourglass },
  NOT_RECEIVED: { label: "Non reçu", cls: "nonrecu", icon: XCircle },
};

const TOUR_COLORS = ["#3B82F6", "#EF4444", "#F59E0B", "#10B981", "#7C3AED"];

function fmtDay(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function fmtDayTime(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  const day = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `${day} à ${time}`;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function ReceptionCommandesPage() {
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;

  const [board, setBoard] = useState<BoardLine[]>([]);
  const [sms, setSms] = useState<Map<string, SmsState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [tab, setTab] = useState("apointer");
  const [tourFilter, setTourFilter] = useState<string | null>(null);
  const [smsFilter, setSmsFilter] = useState<"all" | "complet" | "partiel">("all");

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [b, s] = await Promise.all([
        loadReceptionBoard(supabase, orgId),
        loadSmsStates(supabase, orgId),
      ]);
      setBoard(b);
      setSms(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---- derived sets ---- */
  const pending = useMemo(
    () => board.filter((l) => l.status !== "RECEIVED"),
    [board],
  );
  const backorders = useMemo(
    () => board.filter((l) => l.status === "BACKORDER"),
    [board],
  );
  const history = useMemo(
    () =>
      board
        .filter((l) => l.status === "RECEIVED")
        .sort((a, b) =>
          String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")),
        ),
    [board],
  );

  const tours = useMemo(() => {
    const map = new Map<string, { id: string | null; name: string; count: number }>();
    for (const l of pending) {
      const key = l.tourId ?? "none";
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else
        map.set(key, {
          id: l.tourId,
          name: l.tourName ?? "Hors tournée",
          count: 1,
        });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [pending]);

  const pointerRows = useMemo(
    () =>
      tourFilter === null
        ? pending
        : pending.filter((l) => (l.tourId ?? "none") === tourFilter),
    [pending, tourFilter],
  );

  /**
   * Orders ready for SMS — CLIENT lines only (depuis_magasin = false).
   * Stock-replenishment lines never notify a client; they go to the
   * "Retour en stock" tab. An order with no client line is excluded here.
   */
  const smsOrders = useMemo(() => {
    const byOrder = new Map<string, BoardLine[]>();
    for (const l of board) {
      if (l.fromStock) continue; // skip stock lines entirely
      const arr = byOrder.get(l.orderId);
      if (arr) arr.push(l);
      else byOrder.set(l.orderId, [l]);
    }
    const rows = [...byOrder.entries()]
      .map(([orderId, lines]) => {
        const receivedLines = lines.filter((l) => l.status === "RECEIVED");
        const last = receivedLines
          .slice()
          .sort((a, b) =>
            String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")),
          )[0];
        return {
          orderId,
          ref: lines[0].orderRef,
          date: lines[0].orderDate,
          clientId: lines[0].clientId,
          clientName: lines[0].clientName,
          clientPhone: lines[0].clientPhone,
          vehicle: lines[0].vehicle,
          plate: lines[0].plate,
          total: lines.length,
          received: receivedLines.length,
          complet: receivedLines.length === lines.length,
          lastAt: last?.receivedAt ?? null,
          lastSupplier: last?.supplierName ?? null,
          state: sms.get(orderId) ?? { sent: false, treated: false },
        };
      })
      .filter((o) => o.received > 0 && !o.state.treated)
      .sort((a, b) => String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? "")));
    return rows;
  }, [board, sms]);

  /** Received STOCK lines awaiting put-away (à ranger en stock). */
  const putAwayRows = useMemo(
    () =>
      board
        .filter((l) => l.fromStock && l.status === "RECEIVED" && !l.putAway)
        .sort((a, b) =>
          String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")),
        ),
    [board],
  );

  const smsRows = useMemo(
    () =>
      smsFilter === "all"
        ? smsOrders
        : smsOrders.filter((o) => (smsFilter === "complet" ? o.complet : !o.complet)),
    [smsOrders, smsFilter],
  );

  /* ---- actions ---- */
  const withBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const actReceive = (line: BoardLine) =>
    withBusy(line.id, async () => {
      if (!orgId) return;
      await markLineReceived(supabase, orgId, {
        id: line.id,
        reference: line.reference,
        designation: line.designation,
        quantity: line.quantity,
        receivedQuantity: line.received,
      });
      const now = new Date().toISOString();
      setBoard((prev) =>
        prev.map((l) =>
          l.id === line.id
            ? { ...l, status: "RECEIVED", received: l.quantity, receivedAt: now }
            : l,
        ),
      );
    });

  const actStatus = (line: BoardLine, status: "BACKORDER" | "NOT_RECEIVED") =>
    withBusy(line.id, async () => {
      if (!orgId) return;
      await setLineReceptionStatus(supabase, orgId, line.id, status);
      setBoard((prev) =>
        prev.map((l) => (l.id === line.id ? { ...l, status } : l)),
      );
    });

  const actSms = (o: (typeof smsOrders)[number]) =>
    withBusy(`sms-${o.orderId}`, async () => {
      if (!orgId) return;
      await recordSmsSent(supabase, orgId, {
        orderId: o.orderId,
        clientId: o.clientId,
        phone: o.clientPhone,
      });
      setSms((prev) => {
        const next = new Map(prev);
        const cur = next.get(o.orderId) ?? { sent: false, treated: false };
        next.set(o.orderId, { ...cur, sent: true });
        return next;
      });
    });

  const actTreated = (o: (typeof smsOrders)[number]) =>
    withBusy(`done-${o.orderId}`, async () => {
      if (!orgId) return;
      await markOrderSmsTreated(supabase, orgId, o.orderId);
      setSms((prev) => {
        const next = new Map(prev);
        const cur = next.get(o.orderId) ?? { sent: false, treated: false };
        next.set(o.orderId, { ...cur, treated: true });
        return next;
      });
    });

  const actPutAway = (line: BoardLine) =>
    withBusy(line.id, async () => {
      if (!orgId) return;
      await markLinePutAway(supabase, orgId, line.id);
      setBoard((prev) =>
        prev.map((l) => (l.id === line.id ? { ...l, putAway: true } : l)),
      );
    });

  /* ---- tabs ---- */
  const TABS: { id: string; label: string; sub: string; icon: LucideIcon; count?: number }[] = [
    { id: "apointer", label: "À pointer", sub: "Livraisons à réceptionner", icon: ClipboardCheck, count: pending.length },
    { id: "sms", label: "Commande SMS", sub: "Clients prêts à prévenir", icon: User, count: smsOrders.length },
    { id: "reliquats", label: "Reliquats", sub: "En attente de livraison", icon: Clock, count: backorders.length },
    { id: "retour", label: "Retour en stock", sub: "À ranger en stock", icon: Box, count: putAwayRows.length },
    { id: "historique", label: "Historique", sub: "Réceptions passées", icon: FileText },
  ];

  /* ---------------------------------------------------------------- */
  /*  Shared line table                                                */
  /* ---------------------------------------------------------------- */

  function LinesTable({ rows, showActions }: { rows: BoardLine[]; showActions: boolean }) {
    return (
      <section className="od-card rc-table-card">
        <div className="rc-table-wrap">
          <table className="rc-table">
            <thead>
              <tr>
                <th>N° CMD / Date</th>
                <th>Type</th>
                <th>Client</th>
                <th>Référence / Désignation</th>
                <th>Fournisseur</th>
                <th className="rc-th-center">Qté cmd.</th>
                <th className="rc-th-center">Qté reçue</th>
                <th>Statut</th>
                <th>Reçu le</th>
                {showActions && <th className="rc-th-center">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const St = STATUT[r.status];
                const StIcon = St.icon;
                const type = r.fromStock ? "stock" : "client";
                const isBusy = busy.has(r.id);
                return (
                  <tr key={r.id} className={`rc-row rc-row--${type}`}>
                    <td>
                      <Link href={`/dashboard/commandes/${r.orderId}`} className="rc-cmd">
                        {r.orderRef}
                      </Link>
                      <p className="rl-muted">{fmtDay(r.orderDate)}</p>
                    </td>
                    <td>
                      <span className={`rc-type rc-type--${type}`}>
                        {r.fromStock ? "Stock" : "Client"}
                      </span>
                    </td>
                    <td>
                      <p className="rl-client">{r.clientName}</p>
                      {r.clientPhone && <p className="rl-muted">{r.clientPhone}</p>}
                    </td>
                    <td>
                      <p className="rl-ref">{r.reference}</p>
                      <p className="rl-muted">{r.designation}</p>
                    </td>
                    <td>
                      <span
                        className="rc-brand"
                        style={{ color: r.supplierName ? "#DC2626" : "#1D4ED8" }}
                      >
                        {r.supplierName ?? "Stock magasin"}
                      </span>
                      {r.expectedAt && r.status !== "RECEIVED" && (
                        <p className="rl-muted">Prévu {fmtDayTime(r.expectedAt)}</p>
                      )}
                    </td>
                    <td className="rc-th-center rl-qte">{r.quantity}</td>
                    <td className="rc-th-center rl-qte">{r.received}</td>
                    <td>
                      <span className={`rc-statut rc-statut--${St.cls}`}>
                        <StIcon className="h-3.5 w-3.5" />
                        {St.label}
                      </span>
                    </td>
                    <td className="rl-muted-strong">{fmtDayTime(r.receivedAt)}</td>
                    {showActions && (
                      <td>
                        <div className="rc-actions">
                          <button
                            type="button"
                            className="rc-act rc-act--recu"
                            disabled={isBusy}
                            onClick={() => actReceive(r)}
                          >
                            Reçu{" "}
                            {isBusy ? (
                              <Loader2 className="h-3.5 w-3.5 nc-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="rc-act rc-act--reliquat"
                            disabled={isBusy || r.status === "BACKORDER"}
                            onClick={() => actStatus(r, "BACKORDER")}
                          >
                            Reliquat <Hourglass className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="rc-act rc-act--nonrecu"
                            disabled={isBusy || r.status === "NOT_RECEIVED"}
                            onClick={() => actStatus(r, "NOT_RECEIVED")}
                          >
                            Non reçu <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={showActions ? 10 : 9} className="rc-empty-cell">
                    Aucune ligne.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{rows.length} résultat(s)</span>
        </div>
      </section>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="rc-page">
      {/* Header */}
      <header className="rc-header">
        <h1 className="rc-title">Réception des commandes</h1>
        <div className="rc-header-actions">
          <button
            type="button"
            className="od-btn od-btn--primary"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 nc-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      {/* Tabs */}
      <div className="rc-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rc-tab${t.id === tab ? " rc-tab--active" : ""}`}
            >
              <span className="rc-tab-icon">
                <Icon className="h-5 w-5" />
              </span>
              <span className="rc-tab-text">
                <span className="rc-tab-label">
                  {t.label}
                  {t.count !== undefined && (
                    <span className="rc-tab-count">{t.count}</span>
                  )}
                </span>
                <span className="rc-tab-sub">{t.sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      {loading && board.length === 0 ? (
        <div className="od-card rc-empty">
          <p>Chargement des commandes…</p>
        </div>
      ) : (
        <>
          {/* ---- À pointer ---- */}
          {tab === "apointer" && (
            <>
              {tours.length > 0 && (
                <div className="rc-tournees">
                  {tours.map((t, i) => {
                    const key = t.id ?? "none";
                    const color = TOUR_COLORS[i % TOUR_COLORS.length];
                    const active = tourFilter === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setTourFilter(active ? null : key)}
                        className={`rc-tournee${active ? " rc-tournee--active" : ""}`}
                      >
                        <span
                          className="rc-tournee-icon"
                          style={{ background: `${color}1A`, color }}
                        >
                          <Truck className="h-5 w-5" />
                        </span>
                        <span className="rc-tournee-text">
                          <span className="rc-tournee-label">{t.name}</span>
                          <span className="rc-tournee-sub">
                            {t.id ? "Tournée" : "Livraison externe"}
                          </span>
                        </span>
                        <span className="rc-tournee-count">{t.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <LinesTable rows={pointerRows} showActions />

              <div className="od-note rc-note">
                <Info className="h-4 w-4" />
                <div className="rc-note-text">
                  <p className="rl-note-strong">
                    Pensez à bien pointer toutes les pièces reçues et à gérer les
                    reliquats pour éviter les oublis.
                  </p>
                  <p className="rl-note-sub">
                    «&nbsp;Reçu&nbsp;» ajoute automatiquement la quantité restante au
                    stock magasin.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ---- Commande SMS ---- */}
          {tab === "sms" && (
            <>
              <div className="rc-sms-filters">
                <button
                  type="button"
                  onClick={() => setSmsFilter("all")}
                  className={`rc-sms-all${smsFilter === "all" ? " rc-sms-all--active" : ""}`}
                >
                  Tous les clients prêts
                  <span className="rc-sms-all-count">{smsOrders.length}</span>
                </button>
                <div className="rc-sms-group">
                  <button
                    type="button"
                    onClick={() => setSmsFilter("complet")}
                    className="rc-sms-seg rc-sms-seg--green"
                  >
                    <span className="rc-sms-seg-top">
                      <span className="rc-sms-seg-dot" />
                      Complet
                      <span className="rc-sms-seg-count">
                        {smsOrders.filter((o) => o.complet).length}
                      </span>
                    </span>
                    <span className="rc-sms-seg-sub">Toutes les pièces reçues</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSmsFilter("partiel")}
                    className="rc-sms-seg rc-sms-seg--orange"
                  >
                    <span className="rc-sms-seg-top">
                      <span className="rc-sms-seg-dot" />
                      Partiel
                      <span className="rc-sms-seg-count">
                        {smsOrders.filter((o) => !o.complet).length}
                      </span>
                    </span>
                    <span className="rc-sms-seg-sub">Certaines pièces en reliquat</span>
                  </button>
                </div>
              </div>

              <section className="od-card rc-table-card">
                <div className="rc-table-wrap">
                  <table className="rc-table">
                    <thead>
                      <tr>
                        <th>N° CMD / Date</th>
                        <th>Client</th>
                        <th>Véhicule</th>
                        <th>
                          Pièces reçues
                          <span className="rc-th-sub">Reçues / Commandées</span>
                        </th>
                        <th>Statut</th>
                        <th>Dernière pièce reçue</th>
                        <th className="rc-th-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {smsRows.map((o) => {
                        const pct = Math.round((o.received / o.total) * 100);
                        const manque = o.total - o.received;
                        return (
                          <tr key={o.orderId} className="rc-row">
                            <td>
                              <Link
                                href={`/dashboard/commandes/${o.orderId}`}
                                className="rc-cmd"
                              >
                                {o.ref}
                              </Link>
                              <p className="rl-muted">{fmtDay(o.date)}</p>
                            </td>
                            <td>
                              <p className="rl-client">{o.clientName}</p>
                              <p className="rl-muted">{o.clientPhone ?? "—"}</p>
                            </td>
                            <td>
                              <p className="rc-vehicle">{o.vehicle ?? "—"}</p>
                              <p className="rl-muted">{o.plate ?? ""}</p>
                            </td>
                            <td>
                              <div className="rc-prog">
                                <span className="rc-prog-label">
                                  {o.received} / {o.total}
                                </span>
                                <span className="rc-prog-track">
                                  <span
                                    className={`rc-prog-fill rc-prog-fill--${o.complet ? "green" : "orange"}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </span>
                              </div>
                            </td>
                            <td>
                              <div className="rc-statcell">
                                <span
                                  className={`rt-badge rt-badge--${o.complet ? "green" : "amber"}`}
                                >
                                  {o.complet ? "Complet" : "Partiel"}
                                </span>
                                <span className="rc-statcell-sub">
                                  {o.complet
                                    ? "Toutes les pièces reçues"
                                    : `${manque} pièce${manque > 1 ? "s" : ""} en reliquat`}
                                </span>
                              </div>
                            </td>
                            <td>
                              <p className="rc-last">{fmtDayTime(o.lastAt)}</p>
                              <p className="rc-last-sub">{o.lastSupplier ?? ""}</p>
                            </td>
                            <td>
                              <div className="rc-actions">
                                <button
                                  type="button"
                                  className="rc-sms-act rc-sms-act--sms"
                                  disabled={busy.has(`sms-${o.orderId}`)}
                                  onClick={() => actSms(o)}
                                >
                                  <MessageSquare className="h-4 w-4" />
                                  {o.state.sent ? "SMS envoyé" : "SMS"}
                                </button>
                                <button
                                  type="button"
                                  className="rc-sms-act rc-sms-act--traite"
                                  disabled={busy.has(`done-${o.orderId}`)}
                                  onClick={() => actTreated(o)}
                                >
                                  <Check className="h-4 w-4" />
                                  Traité
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!loading && smsRows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="rc-empty-cell">
                            Aucun client à prévenir.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <div className="od-note rc-note">
                <Info className="h-4 w-4" />
                <div className="rc-note-text">
                  <p className="rl-note-strong">
                    Envoyez un SMS au client pour l&apos;informer que ses pièces sont
                    disponibles.
                  </p>
                  <p className="rl-note-sub">
                    Cliquez sur «&nbsp;Traité&nbsp;» une fois le client informé — la
                    commande disparaîtra de cette liste.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ---- Reliquats ---- */}
          {tab === "reliquats" && <LinesTable rows={backorders} showActions />}

          {/* ---- Historique ---- */}
          {tab === "historique" && (
            <LinesTable rows={history} showActions={false} />
          )}

          {/* ---- Retour en stock — received stock lines to put away ---- */}
          {tab === "retour" && (
            <>
              <section className="od-card rc-table-card">
                <div className="rc-table-wrap">
                  <table className="rc-table">
                    <thead>
                      <tr>
                        <th>N° CMD / Date</th>
                        <th>Référence / Désignation</th>
                        <th>Fournisseur</th>
                        <th className="rc-th-center">Qté</th>
                        <th>Reçu le</th>
                        <th className="rc-th-center">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {putAwayRows.map((r) => (
                        <tr key={r.id} className="rc-row rc-row--stock">
                          <td>
                            <Link
                              href={`/dashboard/commandes/${r.orderId}`}
                              className="rc-cmd"
                            >
                              {r.orderRef}
                            </Link>
                            <p className="rl-muted">{fmtDay(r.orderDate)}</p>
                          </td>
                          <td>
                            <p className="rl-ref">{r.reference}</p>
                            <p className="rl-muted">{r.designation}</p>
                          </td>
                          <td>
                            <span
                              className="rc-brand"
                              style={{ color: r.supplierName ? "#DC2626" : "#1D4ED8" }}
                            >
                              {r.supplierName ?? "Stock magasin"}
                            </span>
                          </td>
                          <td className="rc-th-center rl-qte">{r.quantity}</td>
                          <td className="rl-muted-strong">{fmtDayTime(r.receivedAt)}</td>
                          <td>
                            <div className="rc-actions">
                              <button
                                type="button"
                                className="rc-act rc-act--recu"
                                disabled={busy.has(r.id)}
                                onClick={() => actPutAway(r)}
                              >
                                Rangé{" "}
                                {busy.has(r.id) ? (
                                  <Loader2 className="h-3.5 w-3.5 nc-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!loading && putAwayRows.length === 0 && (
                        <tr>
                          <td colSpan={6} className="rc-empty-cell">
                            Aucune pièce à ranger en stock.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="av-foot">
                  <span className="av-foot-count">
                    {putAwayRows.length} pièce(s) à ranger
                  </span>
                </div>
              </section>

              <div className="od-note rc-note">
                <Info className="h-4 w-4" />
                <div className="rc-note-text">
                  <p className="rl-note-strong">
                    Pièces de stock reçues, à ranger dans le magasin.
                  </p>
                  <p className="rl-note-sub">
                    Cliquez sur «&nbsp;Rangé&nbsp;» une fois la pièce mise en rayon —
                    elle disparaîtra de cette liste.
                  </p>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
