"use client";

import { Building2, Clock, RefreshCw, RotateCcw, Send, Truck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtMoney, loadReturns, type ReturnRow } from "@/lib/data/saas";

const TREATMENT_LABEL: Record<string, string> = {
  A_TRAITER: "A traiter",
  DEMANDE_ENVOYEE: "Demande envoyee",
  A_RECUPERER: "A recuperer",
  ACCEPTE: "Accepte",
  REFUSE: "Refuse",
  REMBOURSE: "Rembourse",
};

function treatmentTone(status: string) {
  if (status === "ACCEPTE" || status === "REMBOURSE") return "green";
  if (status === "REFUSE") return "red";
  if (status === "DEMANDE_ENVOYEE") return "blue";
  if (status === "A_RECUPERER") return "violet";
  return "amber";
}

export default function RetoursPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadReturns(sb, profile.organization_id));
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
    const byStatus = (status: string) => rows.filter((row) => row.treatment === status).length;
    return [
      { label: "A traiter", value: byStatus("A_TRAITER"), icon: Clock, color: "#D97706", bg: "#FEF3C7" },
      { label: "Demande envoyee", value: byStatus("DEMANDE_ENVOYEE"), icon: Send, color: "#2563EB", bg: "#DBEAFE" },
      { label: "A recuperer", value: byStatus("A_RECUPERER"), icon: Truck, color: "#7C3AED", bg: "#F3E8FF" },
      { label: "Total retours", value: rows.length, icon: RotateCcw, color: "#059669", bg: "#DCFCE7" },
    ];
  }, [rows]);

  const topSuppliers = useMemo(() => {
    const map = new Map<string, { retours: number; amount: number }>();
    for (const row of rows) {
      const current = map.get(row.supplier) ?? { retours: 0, amount: 0 };
      map.set(row.supplier, { retours: current.retours + 1, amount: current.amount + row.amount });
    }
    return [...map.entries()]
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.retours - a.retours)
      .slice(0, 5);
  }, [rows]);

  return (
    <div className="rt-layout">
      <div className="rt-main">
        <header className="rt-header">
          <div className="rt-title-wrap">
            <span className="rt-title-icon"><RotateCcw className="h-6 w-6" /></span>
            <div>
              <h1 className="rt-title">Retours</h1>
              <p className="rt-subtitle">Retours clients et fournisseur depuis Supabase</p>
            </div>
          </div>
          <div className="rt-header-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              Actualiser
            </button>
          </div>
        </header>

        {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

        <div className="rt-stats">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rt-stat">
                <span className="rt-stat-icon" style={{ background: stat.bg, color: stat.color }}><Icon className="h-5 w-5" /></span>
                <p className="rt-stat-value">{stat.value}</p>
                <p className="rt-stat-label">{stat.label}</p>
              </div>
            );
          })}
        </div>

        <section className="od-card rt-table-card">
          <div className="rt-table-wrap">
            <table className="rt-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Reference</th>
                  <th>Fournisseur</th>
                  <th>Client / Garage</th>
                  <th>Statut retour</th>
                  <th>Traitement</th>
                  <th>Decote</th>
                  <th>Montant</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="rt-cell-date">{fmtDate(row.createdAt)}</td>
                    <td className="rt-cell-ref">{row.ref}</td>
                    <td>{row.supplier}</td>
                    <td>{row.client}</td>
                    <td><span className="rt-badge rt-badge--green">{row.type}</span></td>
                    <td><span className={`rt-badge rt-badge--${treatmentTone(row.treatment)}`}>{TREATMENT_LABEL[row.treatment] ?? row.treatment}</span></td>
                    <td className="rt-decote">{row.decotePct}%</td>
                    <td className="rt-decote">{fmtMoney(row.amount)}</td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && (
                  <tr><td colSpan={8} className="text-muted">Aucun retour.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="od-card">
          <h3 className="rt-bcard-title">Top fournisseurs</h3>
          <div className="rt-suppliers">
            {topSuppliers.map((supplier) => (
              <div key={supplier.name} className="rt-supplier-row">
                <span className="rt-supplier-icon"><Building2 className="h-4 w-4" /></span>
                <div className="rt-supplier-info">
                  <p className="rt-supplier-name">{supplier.name}</p>
                  <p className="rt-supplier-sub">{supplier.retours} retours</p>
                </div>
                <span className="rt-supplier-amount">{fmtMoney(supplier.amount)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
