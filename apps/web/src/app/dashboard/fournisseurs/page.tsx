"use client";

import { Plus, RefreshCw, Warehouse } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  createSupplier,
  fmtDate,
  loadSuppliers,
  type SupplierSummary,
} from "@/lib/data/saas";

export default function FournisseursPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<SupplierSummary[]>([]);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
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
      setRows(await loadSuppliers(sb, profile.organization_id));
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
      suppliers: rows.length,
      pendingLines: rows.reduce((sum, row) => sum + row.pendingLines, 0),
      pendingPieces: rows.reduce((sum, row) => sum + row.pendingPieces, 0),
    }),
    [rows],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.organization_id || !name.trim()) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const sb = createClient();
      await createSupplier(sb, profile.organization_id, { name, code });
      setName("");
      setCode("");
      setMessage("Fournisseur ajoute.");
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
          <h1 className="rl-title">Fournisseurs</h1>
          <p className="rl-subtitle">
            Fiches fournisseurs et volumes de pieces encore en attente.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      <div className="ga-stats">
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#FEE2E2", color: "#EF4444" }}>
            <Warehouse className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{totals.suppliers}</p>
            <p className="ga-stat-label">Fournisseurs</p>
          </div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#D97706" }}>
            <Warehouse className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{totals.pendingLines}</p>
            <p className="ga-stat-label">Lignes en attente</p>
          </div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}>
            <Warehouse className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{totals.pendingPieces}</p>
            <p className="ga-stat-label">Pieces a recevoir</p>
          </div>
        </div>
      </div>

      <section className="od-card st-rajout">
        <header className="st-rajout-head">
          <h2 className="st-rajout-title">Ajouter un fournisseur</h2>
        </header>
        <form onSubmit={submit} className="st-rajout-grid">
          <div className="od-field st-f-desig">
            <label className="od-label" htmlFor="supplier-name">Nom</label>
            <input
              id="supplier-name"
              className="od-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex : BOSCH"
              required
            />
          </div>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="supplier-code">Code</label>
            <input
              id="supplier-code"
              className="od-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Optionnel"
            />
          </div>
          <div className="st-rajout-submit">
            <button type="submit" className="od-btn od-btn--primary" disabled={saving}>
              <Plus className="h-4 w-4" />
              {saving ? "Ajout..." : "Ajouter"}
            </button>
          </div>
        </form>
        {message && <p className="stat-change" style={{ color: "var(--clr-success)" }}>{message}</p>}
        {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}
      </section>

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table">
            <thead>
              <tr>
                <th>Fournisseur</th>
                <th>Code</th>
                <th className="rl-th-center">Lignes en attente</th>
                <th className="rl-th-center">Pieces a recevoir</th>
                <th>Creation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="rl-client">{row.name}</td>
                  <td className="rl-reffour">{row.code ?? "-"}</td>
                  <td className="rl-th-center rl-qte">{row.pendingLines}</td>
                  <td className="rl-th-center rl-qte">{row.pendingPieces}</td>
                  <td className="rl-muted-strong">{fmtDate(row.createdAt)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted">Aucun fournisseur.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
