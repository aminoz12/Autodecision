"use client";

import {
  AlertTriangle,
  ChevronDown,
  Loader2,
  PackageOpen,
  Plus,
  RefreshCw,
  ShoppingCart,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  adjustStockItem,
  commandRestockLine,
  fmtDateTime,
  loadRestockAlerts,
  loadStockItems,
  loadSupplierOptions,
  type RestockAlert,
  type StockItem,
  type SupplierOption,
} from "@/lib/data/saas";

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
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [delta, setDelta] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      const [items, restock, sups] = await Promise.all([
        loadStockItems(sb, orgId),
        loadRestockAlerts(sb, orgId),
        loadSupplierOptions(sb, orgId),
      ]);
      setRows(items);
      setAlerts(restock);
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !sku.trim()) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const sb = createClient();
      await adjustStockItem(sb, orgId, { sku, name, delta });
      setSku("");
      setName("");
      setDelta(1);
      setMessage("Stock mis à jour.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

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
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">
            Stock magasin
            <span className="rl-title-icon"><PackageOpen className="h-5 w-5" /></span>
          </h1>
          <p className="rl-subtitle">
            Alerte de réapprovisionnement : recommandez les pièces sorties du stock.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="rl-refresh" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="rl-stats">
        <div className="rl-stat">
          <span className="rl-stat-icon"><PackageOpen className="h-5 w-5" /></span>
          <span className="rl-stat-label">Références</span>
          <span className="rl-stat-value">{totals.refs}</span>
        </div>
        <div className="rl-stat">
          <span className="rl-stat-icon"><PackageOpen className="h-5 w-5" /></span>
          <span className="rl-stat-label">Pièces en stock</span>
          <span className="rl-stat-value">{totals.pieces}</span>
        </div>
        <div className="rl-stat">
          <span className="rl-stat-icon" style={{ background: "#FEF3C7", color: "#D97706" }}>
            <AlertTriangle className="h-5 w-5" />
          </span>
          <span className="rl-stat-label">À recommander</span>
          <span className="rl-stat-value">{totals.toRestock}</span>
        </div>
      </div>

      {/* ---- À recommander : stock-sourced lines awaiting re-order ---- */}
      <section className="od-card rl-table-card">
        <div className="st-section-head">
          <h2 className="st-section-title">
            <AlertTriangle className="h-4 w-4" style={{ color: "#D97706" }} />
            Pièces à recommander
          </h2>
          <span className="st-section-sub">
            Sorties du stock pour un client — à recommander pour réapprovisionner.
          </span>
        </div>
        <div className="rl-table-wrap">
          <table className="rl-table st-table">
            <thead>
              <tr>
                <th>Référence / Désignation</th>
                <th>Commande / Client</th>
                <th className="rl-th-center">Qté</th>
                <th>Date</th>
                <th className="rl-th-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a) => (
                <tr key={a.id}>
                  <td>
                    <p className="rl-ref">{a.reference}</p>
                    <p className="rl-muted">{a.designation}</p>
                  </td>
                  <td>
                    <Link href={`/dashboard/commandes/${a.orderId}`} className="rc-cmd">
                      {a.orderRef}
                    </Link>
                    <p className="rl-muted">{a.clientName}</p>
                  </td>
                  <td className="rl-th-center rl-qte">{a.quantity}</td>
                  <td className="rl-muted-strong">{fmtDay(a.orderDate)}</td>
                  <td className="rl-th-center">
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
                  <td colSpan={5} className="text-muted" style={{ textAlign: "center", padding: "24px 0" }}>
                    Aucune pièce à recommander. Votre stock est à jour 👍
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Manual stock adjustment ---- */}
      <section className="od-card st-rajout">
        <header className="st-rajout-head">
          <h2 className="st-rajout-title">Ajustement manuel du stock</h2>
        </header>
        <form onSubmit={submit} className="st-rajout-grid">
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sku">SKU / référence</label>
            <input id="sku" className="od-input" value={sku} onChange={(e) => setSku(e.target.value)} required />
          </div>
          <div className="od-field st-f-desig">
            <label className="od-label" htmlFor="name">Désignation si nouveau</label>
            <input id="name" className="od-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="od-field st-f-qty">
            <label className="od-label" htmlFor="delta">Variation</label>
            <input
              id="delta"
              className="od-input"
              type="number"
              value={delta}
              onChange={(e) => setDelta(Number(e.target.value) || 0)}
              required
            />
          </div>
          <div className="st-rajout-submit">
            <button type="submit" className="od-btn od-btn--primary" disabled={saving}>
              <Plus className="h-4 w-4" />
              {saving ? "..." : "Appliquer"}
            </button>
          </div>
        </form>
        {message && <p className="stat-change" style={{ color: "var(--clr-success)" }}>{message}</p>}
      </section>

      {/* ---- Current inventory ---- */}
      <section className="od-card rl-table-card">
        <div className="st-section-head">
          <h2 className="st-section-title">Inventaire actuel</h2>
        </div>
        <div className="rl-table-wrap">
          <table className="rl-table st-table">
            <thead>
              <tr>
                <th>Référence</th>
                <th>Désignation</th>
                <th className="rl-th-center">Quantité</th>
                <th>Dernière mise à jour</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="rl-reffour">{row.sku}</td>
                  <td className="rl-client">{row.name}</td>
                  <td className="rl-th-center">
                    <span className={`rl-qte-recue rl-qte-recue--${row.quantity <= 0 ? "red" : "green"}`}>
                      {row.quantity}
                    </span>
                  </td>
                  <td className="rl-muted-strong">{fmtDateTime(row.updatedAt)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-muted">Aucun stock.</td>
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
