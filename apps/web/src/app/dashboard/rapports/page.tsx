"use client";

import { BarChart3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney, loadReportsOverview, type ReportsOverview } from "@/lib/data/saas";

export default function RapportsPage() {
  const { profile } = useAuth();
  const [data, setData] = useState<ReportsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setData(await loadReportsOverview(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const cards = [
    ["Commandes", String(data?.orderCount ?? 0)],
    ["Chiffre d'affaires", fmtMoney(data?.revenue ?? 0)],
    ["Encaisse", fmtMoney(data?.paid ?? 0)],
    ["Solde restant", fmtMoney(data?.outstanding ?? 0)],
    ["Retours", String(data?.returnCount ?? 0)],
    ["Montant retours", fmtMoney(data?.returnAmount ?? 0)],
    ["Avoirs", fmtMoney(data?.creditAmount ?? 0)],
  ];

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">
            Rapports
            <span className="rl-title-icon"><BarChart3 className="h-5 w-5" /></span>
          </h1>
          <p className="rl-subtitle">
            Indicateurs calcules depuis les tables commandes, retours, avoirs et fournisseurs.
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

      <div className="ga-stats">
        {cards.map(([label, value]) => (
          <div key={label} className="ga-stat">
            <span className="ga-stat-icon" style={{ background: "#F3E8FF", color: "#7C3AED" }}>
              <BarChart3 className="h-5 w-5" />
            </span>
            <div>
              <p className="ga-stat-value">{loading ? "-" : value}</p>
              <p className="ga-stat-label">{label}</p>
            </div>
          </div>
        ))}
      </div>

      <section className="od-card rl-table-card">
        <h2 className="st-rajout-title">Top fournisseurs par pieces commandees</h2>
        <div className="rt-suppliers">
          {(data?.topSuppliers ?? []).map((supplier) => (
            <div key={supplier.name} className="rt-supplier-row">
              <span className="rt-supplier-icon"><BarChart3 className="h-4 w-4" /></span>
              <div className="rt-supplier-info">
                <p className="rt-supplier-name">{supplier.name}</p>
                <p className="rt-supplier-sub">{supplier.pieces} pieces</p>
              </div>
            </div>
          ))}
          {!loading && (data?.topSuppliers.length ?? 0) === 0 && (
            <p className="text-muted">Aucune ligne fournisseur.</p>
          )}
        </div>
      </section>
    </div>
  );
}
