"use client";

import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  History,
  Loader2,
  PackageOpen,
  RefreshCw,
  ShoppingCart,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  reorderStockLines,
  loadRestockAlerts,
  loadRestockHistory,
  loadStockItems,
  loadSupplierOptions,
  type RestockAlert,
  type RestockHistoryRow,
  type StockItem,
  type SupplierOption,
} from "@/lib/data/saas";
import { computeTournee, type TourneeInfo } from "@/lib/data/orders";

const HISTORY_STATUS: Record<RestockHistoryRow["status"], { label: string; cls: string }> = {
  COMMANDE: { label: "Commandé", cls: "amber" },
  RECU: { label: "Reçu", cls: "blue" },
  RANGE: { label: "Rangé en stock", cls: "green" },
};

function fmtDay(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function fmtTournee(t: TourneeInfo): string {
  const d = t.deliveryAt;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const day = sameDay ? "aujourd'hui" : d.toLocaleDateString("fr-FR");
  return `${day} à ${t.slot}`;
}

export default function StockPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [rows, setRows] = useState<StockItem[]>([]);
  const [alerts, setAlerts] = useState<RestockAlert[]>([]);
  const [history, setHistory] = useState<RestockHistoryRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Commander modal — one or several parts, ONE supplier for all of them.
  const [targets, setTargets] = useState<RestockAlert[]>([]);
  const target = targets.length === 1 ? targets[0] : null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [supplierId, setSupplierId] = useState("");
  const [refCommande, setRefCommande] = useState("");
  const [tournee, setTournee] = useState<TourneeInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commanding, setCommanding] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      const [items, restock, hist, sups] = await Promise.all([
        loadStockItems(sb, orgId),
        loadRestockAlerts(sb, orgId),
        loadRestockHistory(sb, orgId),
        loadSupplierOptions(sb, orgId),
      ]);
      setRows(items);
      setAlerts(restock);
      setHistory(hist);
      setSuppliers(sups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () => ({
      refs: rows.length,
      pieces: rows.reduce((sum, row) => sum + row.quantity, 0),
      toRestock: alerts.length,
    }),
    [rows, alerts],
  );

  function openCommander(list: RestockAlert[]) {
    if (list.length === 0) return;
    setTargets(list);
    setSupplierId("");
    setRefCommande("");
    // Arrival follows the tournée matching the time the order is placed.
    setTournee(computeTournee(new Date()));
    setModalError(null);
    setNotice(null);
  }

  const allSelected = alerts.length > 0 && alerts.every((a) => selected.has(a.id));
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(alerts.map((a) => a.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const selectedAlerts = alerts.filter((a) => selected.has(a.id));

  async function submitCommander(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || targets.length === 0) return;
    if (!supplierId) {
      setModalError("Choisissez un fournisseur.");
      return;
    }
    setCommanding(true);
    setModalError(null);
    try {
      const sb = createClient();
      // One restock order (no client) for every selected part, same supplier.
      const res = await reorderStockLines(sb, orgId, {
        lineIds: targets.map((t) => t.id),
        supplierId,
        referenceCommandes: target ? { [target.id]: refCommande } : {},
      });
      const t = tournee ?? computeTournee(new Date());
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? "fournisseur";
      setNotice(
        targets.length === 1
          ? `${targets[0].reference} commandée chez ${supplierName} — ${res.orderRef}, ${res.tourName || t.name}, arrivée prévue ${fmtTournee(t)}.`
          : `${targets.length} pièces commandées chez ${supplierName} — commande stock ${res.orderRef}, ${res.tourName || t.name}, arrivée prévue ${fmtTournee(t)}.`,
      );
      setTargets([]);
      setSelected(new Set());
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommanding(false);
    }
  }

  return (
    <div className="stk-page">
      <header className="stk-header">
        <div>
          <h1 className="stk-title rl-title--upper">
            <span className="stk-title-icon"><PackageOpen className="h-5 w-5" /></span>
            Mon <span className="nc-title-accent">stock</span>
          </h1>
          <p className="stk-sub">
            Alerte de réapprovisionnement : recommandez les pièces sorties du stock
            pour garder votre inventaire à jour.
          </p>
        </div>
        <button
          type="button"
          className="od-btn od-btn--ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualiser
        </button>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="stk-stats">
        <div className="stk-stat stk-stat--violet">
          <span className="stk-stat-icon"><PackageOpen className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">Références en stock</span>
            <span className="stk-stat-value">{totals.refs}</span>
          </span>
        </div>
        <div className="stk-stat stk-stat--green">
          <span className="stk-stat-icon"><Boxes className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">Pièces en stock</span>
            <span className="stk-stat-value">{totals.pieces}</span>
          </span>
        </div>
        <div className="stk-stat stk-stat--amber">
          <span className="stk-stat-icon"><AlertTriangle className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">À recommander</span>
            <span className="stk-stat-value">{totals.toRestock}</span>
          </span>
        </div>
      </div>

      {/* ---- À recommander : stock-sourced lines awaiting re-order ---- */}
      <section className="stk-card">
        <div className="stk-card-head">
          <span className="stk-card-head-icon" style={{ background: "#FEF3C7", color: "#D97706" }}>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <span className="stk-card-titles">
            <span className="stk-card-title">Pièces à recommander</span>
            <span className="stk-card-sub">Sorties du stock pour un client — à recommander pour réapprovisionner.</span>
          </span>
          {alerts.length > 0 && (
            <span className="stk-card-badge" style={{ background: "#FEF3C7", color: "#B45309" }}>
              {alerts.length}
            </span>
          )}
          {alerts.length > 0 && (
            <div className="stk-bulk">
              <label className="rc-check rc-check--label">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                Tout sélectionner
              </label>
              <button
                type="button"
                className="od-btn od-btn--primary st-cmd-btn"
                disabled={selectedAlerts.length === 0}
                onClick={() => openCommander(selectedAlerts)}
                title="Commander toutes les pièces cochées chez le même fournisseur"
              >
                <ShoppingCart className="h-3.5 w-3.5" />
                Commander la sélection
                {selectedAlerts.length > 0 && (
                  <span className="rc-tab-count">{selectedAlerts.length}</span>
                )}
              </button>
            </div>
          )}
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th className="rc-th-check">
                  <input
                    type="checkbox"
                    className="rc-check"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Tout sélectionner"
                  />
                </th>
                <th>Référence / Désignation</th>
                <th>Commande / Client</th>
                <th className="stk-th-center">Qté</th>
                <th>Date</th>
                <th className="stk-th-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id} className={selected.has(a.id) ? "rc-row--selected" : undefined}>
                  <td className="rc-th-check">
                    <input
                      type="checkbox"
                      className="rc-check"
                      checked={selected.has(a.id)}
                      onChange={() => toggleOne(a.id)}
                      aria-label={`Sélectionner ${a.reference}`}
                    />
                  </td>
                  <td>
                    <p className="stk-ref">{a.reference}</p>
                    <p className="stk-desig">{a.designation}</p>
                  </td>
                  <td>
                    <Link href={`/dashboard/commandes/${a.orderId}`} className="rc-cmd">
                      {a.orderRef}
                    </Link>
                    <p className="stk-desig">{a.clientName}</p>
                  </td>
                  <td className="stk-td-center"><span className="stk-qty">{a.quantity}</span></td>
                  <td className="rl-muted-strong">{fmtDay(a.orderDate)}</td>
                  <td className="stk-td-center">
                    <button
                      type="button"
                      className="od-btn od-btn--primary st-cmd-btn"
                      onClick={() => openCommander([a])}
                    >
                      <ShoppingCart className="h-3.5 w-3.5" />
                      Commander
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && alerts.length === 0 && (
                <tr>
                  <td colSpan={6} className="stk-empty">
                    Aucune pièce à recommander. Votre stock est à jour 👍
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Historique : stock lines that were re-ordered ---- */}
      <section className="stk-card">
        <div className="stk-card-head">
          <span className="stk-card-head-icon" style={{ background: "#EEF2FF", color: "#5b4ee5" }}>
            <History className="h-4 w-4" />
          </span>
          <span className="stk-card-titles">
            <span className="stk-card-title">Historique des réapprovisionnements</span>
            <span className="stk-card-sub">Pièces commandées pour le stock — suivi jusqu&apos;à la mise en rayon.</span>
          </span>
          {history.length > 0 && (
            <span className="stk-card-badge" style={{ background: "#EEF2FF", color: "#4F46E5" }}>
              {history.length}
            </span>
          )}
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th>Référence / Désignation</th>
                <th>Fournisseur</th>
                <th>Commande</th>
                <th className="stk-th-center">Qté</th>
                <th>Date</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const st = HISTORY_STATUS[h.status];
                return (
                  <tr key={h.id}>
                    <td>
                      <p className="stk-ref">
                        {h.reference}
                        {h.referenceCommande && h.referenceCommande !== h.reference && (
                          <span className="stk-ref-cmd"> · cmd. {h.referenceCommande}</span>
                        )}
                      </p>
                      <p className="stk-desig">{h.designation}</p>
                    </td>
                    <td>
                      <span className="rc-brand" style={{ color: "#DC2626" }}>
                        {h.supplierName}
                      </span>
                    </td>
                    <td>
                      <Link href={`/dashboard/commandes/${h.orderId}`} className="rc-cmd">
                        {h.orderRef}
                      </Link>
                    </td>
                    <td className="stk-td-center"><span className="stk-qty">{h.quantity}</span></td>
                    <td className="rl-muted-strong">{fmtDay(h.date)}</td>
                    <td>
                      <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                    </td>
                  </tr>
                );
              })}
              {!loading && history.length === 0 && (
                <tr>
                  <td colSpan={6} className="stk-empty">
                    Aucun réapprovisionnement pour le moment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Toast message={notice} onClose={() => setNotice(null)} duration={8000} />

      {/* ---- Commander modal ---- */}
      {targets.length > 0 && (
        <div className="ga-modal-overlay" onClick={() => !commanding && setTargets([])}>
          <div className="ga-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <h2 className="ga-modal-title">
                {targets.length === 1
                  ? "Commander la pièce"
                  : `Commander ${targets.length} pièces (même fournisseur)`}
              </h2>
              <button type="button" className="ga-modal-close" onClick={() => setTargets([])} aria-label="Fermer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitCommander}>
              {modalError && <div className="nc-error">{modalError}</div>}

              <div className="st-cmd-part st-cmd-part--list">
                {targets.map((t) => (
                  <div key={t.id} className="st-cmd-part-row">
                    <span>
                      <p className="rl-ref">{t.reference}</p>
                      <p className="rl-muted">{t.designation}</p>
                    </span>
                    <span className="stk-qty">×{t.quantity}</span>
                  </div>
                ))}
                <p className="st-cmd-hint">
                  Une commande de réapprovisionnement séparée est créée pour le stock :
                  les pièces ne restent pas liées au client.
                </p>
              </div>

              <div className="od-field">
                <span className="od-label">Fournisseur *</span>
                <div className="od-select">
                  <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">— Choisir un fournisseur —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="h-4 w-4" />
                </div>
                {suppliers.length === 0 && (
                  <span className="st-cmd-hint">
                    Aucun fournisseur. Ajoutez-en un dans{" "}
                    <Link href="/dashboard/fournisseurs" className="rc-cmd">Fournisseurs</Link>.
                  </span>
                )}
              </div>

              <div className="ga-modal-row">
                {target && (
                <div className="od-field">
                  <span className="od-label">Référence commandée</span>
                  <input
                    className="od-input"
                    placeholder="Réf. fournisseur (gardée avec la réf. d'origine)"
                    value={refCommande}
                    onChange={(e) => setRefCommande(e.target.value)}
                  />
                  <span className="st-cmd-hint">
                    La référence d&apos;origine <strong>{target.reference}</strong> est conservée ; les deux seront recherchables.
                  </span>
                </div>
                )}
                <div className="od-field">
                  <span className="od-label">Arrivée prévue</span>
                  <input
                    className="od-input nc-readonly"
                    readOnly
                    value={tournee ? `${tournee.name} — ${fmtTournee(tournee)}` : ""}
                  />
                  <span className="st-cmd-hint">Déterminée automatiquement par l&apos;heure de la commande.</span>
                </div>
              </div>

              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setTargets([])} disabled={commanding}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={commanding}>
                  {commanding ? <Loader2 className="h-4 w-4 nc-spin" /> : <ShoppingCart className="h-4 w-4" />}
                  {commanding ? "Commande…" : "Commander"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
