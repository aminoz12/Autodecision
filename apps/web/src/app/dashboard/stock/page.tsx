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
import { createClient } from "@/lib/supabase/client";
import {
  commandRestockLine,
  loadRestockAlerts,
  loadRestockHistory,
  loadStockItems,
  loadSupplierOptions,
  type RestockAlert,
  type RestockHistoryRow,
  type StockItem,
  type SupplierOption,
} from "@/lib/data/saas";

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

export default function StockPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [rows, setRows] = useState<StockItem[]>([]);
  const [alerts, setAlerts] = useState<RestockAlert[]>([]);
  const [history, setHistory] = useState<RestockHistoryRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Commander modal
  const [target, setTarget] = useState<RestockAlert | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [prixAchat, setPrixAchat] = useState(0);
  const [prevueLe, setPrevueLe] = useState("");
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

  function openCommander(a: RestockAlert) {
    setTarget(a);
    setSupplierId("");
    setPrixAchat(a.prixAchat || 0);
    setPrevueLe("");
    setModalError(null);
  }

  async function submitCommander(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !target) return;
    if (!supplierId) {
      setModalError("Choisissez un fournisseur.");
      return;
    }
    setCommanding(true);
    setModalError(null);
    try {
      const sb = createClient();
      await commandRestockLine(sb, orgId, target.id, {
        supplierId,
        prixAchat,
        prevueLe: prevueLe ? new Date(prevueLe).toISOString() : null,
      });
      setTarget(null);
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
          <h1 className="stk-title">
            <span className="stk-title-icon"><PackageOpen className="h-5 w-5" /></span>
            Stock magasin
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
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th>Référence / Désignation</th>
                <th>Commande / Client</th>
                <th className="stk-th-center">Qté</th>
                <th>Date</th>
                <th className="stk-th-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
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
                      onClick={() => openCommander(a)}
                    >
                      <ShoppingCart className="h-3.5 w-3.5" />
                      Commander
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && alerts.length === 0 && (
                <tr>
                  <td colSpan={5} className="stk-empty">
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
                      <p className="stk-ref">{h.reference}</p>
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

      {/* ---- Commander modal ---- */}
      {target && (
        <div className="ga-modal-overlay" onClick={() => !commanding && setTarget(null)}>
          <div className="ga-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <h2 className="ga-modal-title">Commander la pièce</h2>
              <button type="button" className="ga-modal-close" onClick={() => setTarget(null)} aria-label="Fermer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitCommander}>
              {modalError && <div className="nc-error">{modalError}</div>}

              <div className="st-cmd-part">
                <p className="rl-ref">{target.reference}</p>
                <p className="rl-muted">{target.designation} · Qté {target.quantity}</p>
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
                <div className="od-field">
                  <span className="od-label">Prix d&apos;achat unitaire</span>
                  <input className="od-input" type="number" min={0} step="0.01" value={prixAchat || ""} onChange={(e) => setPrixAchat(Number(e.target.value))} />
                </div>
                <div className="od-field">
                  <span className="od-label">Arrivée prévue</span>
                  <input className="od-input" type="date" value={prevueLe} onChange={(e) => setPrevueLe(e.target.value)} />
                </div>
              </div>

              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setTarget(null)} disabled={commanding}>Annuler</button>
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
