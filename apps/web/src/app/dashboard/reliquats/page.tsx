"use client";

import { Calendar, Check, Clock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  fmtDateTime,
  loadReceptionLines,
  markLineReceived,
  type ReceptionLine,
} from "@/lib/data/saas";

export default function ReliquatsPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<ReceptionLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadReceptionLines(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return {
      pending: rows.length,
      today: rows.filter((r) => r.expectedAt?.slice(0, 10) === today).length,
      tomorrow: rows.filter((r) => r.expectedAt?.slice(0, 10) === tomorrow).length,
      pieces: rows.reduce((sum, row) => sum + Math.max(row.quantity - row.receivedQuantity, 0), 0),
    };
  }, [rows]);

  async function receive(row: ReceptionLine) {
    if (!profile?.organization_id) return;
    setWorkingId(row.id);
    setError(null);
    try {
      const sb = createClient();
      await markLineReceived(sb, profile.organization_id, row);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">
            Reliquats
            <span className="rl-title-icon"><Clock className="h-5 w-5" /></span>
          </h1>
          <p className="rl-subtitle">
            Pieces commandees non encore recues depuis order_lines.
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
        <div className="rl-stat"><span className="rl-stat-icon"><Clock className="h-5 w-5" /></span><span className="rl-stat-label">En attente</span><span className="rl-stat-value">{stats.pending}</span></div>
        <div className="rl-stat"><span className="rl-stat-icon"><Calendar className="h-5 w-5" /></span><span className="rl-stat-label">Prevues aujourd&apos;hui</span><span className="rl-stat-value">{stats.today}</span></div>
        <div className="rl-stat"><span className="rl-stat-icon"><Calendar className="h-5 w-5" /></span><span className="rl-stat-label">Prevues demain</span><span className="rl-stat-value">{stats.tomorrow}</span></div>
        <div className="rl-stat"><span className="rl-stat-icon"><Clock className="h-5 w-5" /></span><span className="rl-stat-label">Pieces restantes</span><span className="rl-stat-value">{stats.pieces}</span></div>
      </div>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table">
            <thead>
              <tr>
                <th>N CMD / Date</th>
                <th>Client</th>
                <th>Reference / Designation</th>
                <th>Fournisseur</th>
                <th className="rl-th-center">Qte cmd.</th>
                <th className="rl-th-center">Qte recue</th>
                <th>Prevue le</th>
                <th className="rl-th-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td><p className="rl-cmd">{row.orderRef}</p><p className="rl-muted">{row.orderDate ?? "-"}</p></td>
                  <td><p className="rl-client">{row.clientName}</p><p className="rl-muted">{row.clientPhone ?? "-"}</p></td>
                  <td><p className="rl-ref">{row.reference}</p><p className="rl-muted">{row.designation}</p></td>
                  <td><span className="rl-brand rl-brand--blue">{row.supplierName}</span></td>
                  <td className="rl-th-center rl-qte">{row.quantity}</td>
                  <td className="rl-th-center"><span className="rl-qte-recue rl-qte-recue--orange">{row.receivedQuantity}</span></td>
                  <td className="rl-muted-strong">{fmtDateTime(row.expectedAt)}</td>
                  <td className="rl-th-actions">
                    <button type="button" className="rl-recu-btn" onClick={() => void receive(row)} disabled={workingId === row.id}>
                      <Check className="h-4 w-4" />
                      {workingId === row.id ? "..." : "Piece recue"}
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-muted">Aucun reliquat.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
