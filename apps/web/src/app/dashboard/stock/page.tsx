"use client";

import { PackageOpen, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  adjustStockItem,
  fmtDateTime,
  loadStockItems,
  type StockItem,
} from "@/lib/data/saas";

export default function StockPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<StockItem[]>([]);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [delta, setDelta] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadStockItems(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () => ({
      refs: rows.length,
      pieces: rows.reduce((sum, row) => sum + row.quantity, 0),
      alerts: rows.filter((row) => row.quantity <= 0).length,
    }),
    [rows],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.organization_id || !sku.trim()) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const sb = createClient();
      await adjustStockItem(sb, profile.organization_id, { sku, name, delta });
      setSku("");
      setName("");
      setDelta(1);
      setMessage("Stock mis a jour.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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
            Inventaire stock_items synchronise avec les receptions fournisseur.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="rl-refresh" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      <div className="rl-stats">
        <div className="rl-stat">
          <span className="rl-stat-icon"><PackageOpen className="h-5 w-5" /></span>
          <span className="rl-stat-label">References</span>
          <span className="rl-stat-value">{totals.refs}</span>
        </div>
        <div className="rl-stat">
          <span className="rl-stat-icon"><PackageOpen className="h-5 w-5" /></span>
          <span className="rl-stat-label">Pieces en stock</span>
          <span className="rl-stat-value">{totals.pieces}</span>
        </div>
        <div className="rl-stat">
          <span className="rl-stat-icon"><PackageOpen className="h-5 w-5" /></span>
          <span className="rl-stat-label">Alertes rupture</span>
          <span className="rl-stat-value">{totals.alerts}</span>
        </div>
      </div>

      <section className="od-card st-rajout">
        <header className="st-rajout-head">
          <h2 className="st-rajout-title">Ajustement stock</h2>
        </header>
        <form onSubmit={submit} className="st-rajout-grid">
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sku">SKU / reference</label>
            <input id="sku" className="od-input" value={sku} onChange={(e) => setSku(e.target.value)} required />
          </div>
          <div className="od-field st-f-desig">
            <label className="od-label" htmlFor="name">Designation si nouveau</label>
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
        {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}
      </section>

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table st-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Designation</th>
                <th className="rl-th-center">Quantite</th>
                <th>Derniere mise a jour</th>
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
    </div>
  );
}
