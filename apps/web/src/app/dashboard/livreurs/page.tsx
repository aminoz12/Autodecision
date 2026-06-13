"use client";

import { RefreshCw, Truck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, loadDeliveryTours, type DeliveryTourRow } from "@/lib/data/saas";

export default function LivreursPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<DeliveryTourRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadDeliveryTours(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">
            Livreurs et tournees
            <span className="rl-title-icon"><Truck className="h-5 w-5" /></span>
          </h1>
          <p className="rl-subtitle">
            Tournees issues de delivery_tours et lignes rattachees.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="rl-refresh" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table">
            <thead>
              <tr>
                <th>Tournee</th>
                <th>Date</th>
                <th>Vehicule</th>
                <th>Statut</th>
                <th className="rl-th-center">Lignes</th>
                <th className="rl-th-center">Pieces</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="rl-client">{row.name}</td>
                  <td className="rl-muted-strong">{fmtDate(row.date)}</td>
                  <td className="rl-reffour">{row.vehicle ?? "-"}</td>
                  <td><span className="rt-badge rt-badge--blue">{row.status}</span></td>
                  <td className="rl-th-center rl-qte">{row.lineCount}</td>
                  <td className="rl-th-center rl-qte">{row.pieceCount}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted">Aucune tournee planifiee.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
