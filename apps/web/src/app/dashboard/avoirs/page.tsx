"use client";

import { ChevronRight, FileText, Package, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  fmtDate,
  fmtMoney,
  loadCreditsAndConsignments,
  type CreditConsignRow,
} from "@/lib/data/saas";

const STATUS_CLASS: Record<string, string> = {
  EN_COURS: "encours",
  PARTIEL: "partiel",
  UTILISE: "utilise",
  EXPIRE: "expire",
  ACTIF: "encours",
};

export default function AvoirsPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<CreditConsignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadCreditsAndConsignments(sb, profile.organization_id));
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
      credits: rows.filter((r) => r.kind === "avoir").reduce((sum, r) => sum + r.amount, 0),
      consignments: rows.filter((r) => r.kind === "consigne").reduce((sum, r) => sum + r.amount, 0),
    }),
    [rows],
  );

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">Suivi des avoirs et consignes</h1>
          <p className="rl-subtitle">Donnees issues de credit_notes et consignment_entries.</p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="rl-refresh" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      <div className="av-summary">
        <div className="av-sum-card av-sum-card--green">
          <span className="av-sum-icon av-sum-icon--green"><FileText className="h-6 w-6" /></span>
          <div><p className="av-sum-label">Total avoirs</p><p className="av-sum-value av-sum-value--green">{fmtMoney(totals.credits)}</p></div>
        </div>
        <div className="av-sum-card av-sum-card--orange">
          <span className="av-sum-icon av-sum-icon--orange"><Package className="h-6 w-6" /></span>
          <div><p className="av-sum-label">Total consignes</p><p className="av-sum-value av-sum-value--orange">{fmtMoney(totals.consignments)}</p></div>
        </div>
      </div>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table av-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>N Avoir / Consigne</th>
                <th>Type</th>
                <th>Client</th>
                <th>Reference</th>
                <th>Motif / Designation</th>
                <th className="av-th-right">Montant</th>
                <th>Statut</th>
                <th>Echeance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}-${row.id}`}>
                  <td className="rl-muted-strong">{fmtDate(row.createdAt)}</td>
                  <td><span className={`av-num av-num--${row.kind}`}>{row.num}</span></td>
                  <td><span className={`av-type av-type--${row.kind}`}>{row.kind === "avoir" ? "Avoir" : "Consigne"}</span></td>
                  <td><p className="rl-client">{row.client}</p></td>
                  <td className="rl-reffour">{row.reference}</td>
                  <td><p className="av-motif">{row.motif}</p><p className="rl-muted">{row.designation}</p></td>
                  <td className={`av-th-right av-montant av-montant--${row.kind}`}>{fmtMoney(row.amount)}</td>
                  <td><span className={`av-statut av-statut--${STATUS_CLASS[row.status] ?? "encours"}`}>{row.status}</span></td>
                  <td className="rl-muted-strong">{fmtDate(row.dueAt)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={9} className="text-muted">Aucun avoir ou consigne.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{rows.length} resultat(s)</span>
          <div className="av-pag"><button type="button" className="av-pag-btn av-pag-btn--active">1</button><button type="button" className="av-pag-btn av-pag-arrow" aria-label="Suivant"><ChevronRight className="h-4 w-4" /></button></div>
        </div>
      </section>
    </div>
  );
}
