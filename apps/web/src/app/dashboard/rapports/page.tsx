"use client";

import {
  Banknote,
  ChartColumn,
  ClipboardList,
  Loader2,
  Receipt,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  TrendingUp,
  Wallet,
  Warehouse,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney } from "@/lib/data/saas";
import { loadReportData, type ReportData } from "@/lib/data/rapports";

export default function RapportsPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const supabase = useMemo(() => createClient(), []);

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await loadReportData(supabase, orgId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const maxMonth = useMemo(
    () => Math.max(1, ...(data?.months.map((m) => m.ca) ?? [1])),
    [data],
  );
  const maxClient = useMemo(
    () => Math.max(1, ...(data?.topClients.map((c) => c.amount) ?? [1])),
    [data],
  );
  const maxSupplier = useMemo(
    () => Math.max(1, ...(data?.topFournisseurs.map((s) => s.count) ?? [1])),
    [data],
  );

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            Mes <span className="nc-title-accent">rapports</span>
          </h1>
          <p className="rl-subtitle">
            Chiffre d&apos;affaires, marge estimée, meilleurs clients et fournisseurs — calculés en direct sur vos commandes.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      {loading && !data ? (
        <TableSkeleton rows={6} cols={5} />
      ) : data ? (
        <>
          <div className="rp-kpis">
            <div className="ga-stat">
              <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#635BFF" }}><ClipboardList className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{data.orders}</p><p className="ga-stat-label">Commandes · panier {fmtMoney(data.panierMoyen)}</p></div>
            </div>
            <div className="ga-stat">
              <span className="ga-stat-icon" style={{ background: "#D6ECFF", color: "#0055BC" }}><ShoppingCart className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{fmtMoney(data.ca)}</p><p className="ga-stat-label">Chiffre d&apos;affaires</p></div>
            </div>
            <div className="ga-stat">
              <span className="ga-stat-icon" style={{ background: "#D7F7C2", color: "#0E6245" }}><Banknote className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{fmtMoney(data.encaisse)}</p><p className="ga-stat-label">Encaissé</p></div>
            </div>
            <div className="ga-stat">
              <span className="ga-stat-icon" style={{ background: data.solde > 0 ? "#FFE7F2" : "#F6F8FA", color: data.solde > 0 ? "#B3093C" : "#697386" }}><Wallet className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{fmtMoney(data.solde)}</p><p className="ga-stat-label">Reste à encaisser</p></div>
            </div>
            <div className="ga-stat">
              <span className="ga-stat-icon" style={{ background: "#FCEDB9", color: "#983705" }}><TrendingUp className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{fmtMoney(data.marge)}</p><p className="ga-stat-label">Marge estimée (PV − PA)</p></div>
            </div>
          </div>

          {/* ---- CA by month ---- */}
          <section className="od-card rp-card">
            <p className="admin-card-title"><ChartColumn className="h-4 w-4 rp-title-icon" /> Chiffre d&apos;affaires — 6 derniers mois</p>
            <div className="rp-chart">
              {data.months.map((m) => (
                <div key={m.key} className="rp-bar-col" title={`${m.label} : ${fmtMoney(m.ca)} (${m.orders} commandes)`}>
                  <span className="rp-bar-value">{m.ca > 0 ? fmtMoney(m.ca) : ""}</span>
                  <div className="rp-bar-track">
                    <div className="rp-bar" style={{ height: `${Math.max(m.ca > 0 ? 4 : 0, Math.round((m.ca / maxMonth) * 100))}%` }} />
                  </div>
                  <span className="rp-bar-label">{m.label}</span>
                  <span className="rp-bar-sub">{m.orders} cmd</span>
                </div>
              ))}
            </div>
          </section>

          <div className="rp-grid">
            {/* ---- Top clients & garages ---- */}
            <section className="od-card rp-card">
              <p className="admin-card-title"><Wrench className="h-4 w-4 rp-title-icon" /> Meilleurs clients &amp; garages</p>
              <div className="rp-list">
                {data.topClients.map((c) => (
                  <div key={c.name} className="rp-row">
                    <span className="rp-row-name">
                      {c.name}
                      {c.isGarage && <span className="rc-type rc-type--garage rc-type--inline">Garage</span>}
                      <em>{c.count} commande{c.count > 1 ? "s" : ""}</em>
                    </span>
                    <div className="rp-row-track"><div className="rp-row-fill" style={{ width: `${Math.round((c.amount / maxClient) * 100)}%` }} /></div>
                    <span className="rp-row-amount">{fmtMoney(c.amount)}</span>
                  </div>
                ))}
                {data.topClients.length === 0 && <p className="rl-muted">Aucune commande.</p>}
              </div>
            </section>

            {/* ---- Top suppliers ---- */}
            <section className="od-card rp-card">
              <p className="admin-card-title"><Warehouse className="h-4 w-4 rp-title-icon" /> Fournisseurs les plus commandés</p>
              <div className="rp-list">
                {data.topFournisseurs.map((s) => (
                  <div key={s.name} className="rp-row">
                    <span className="rp-row-name">
                      {s.name}
                      <em>{s.count} pièce{s.count > 1 ? "s" : ""}</em>
                    </span>
                    <div className="rp-row-track"><div className="rp-row-fill rp-row-fill--blue" style={{ width: `${Math.round((s.count / maxSupplier) * 100)}%` }} /></div>
                    <span className="rp-row-amount">{fmtMoney(s.amount)}</span>
                  </div>
                ))}
                {data.topFournisseurs.length === 0 && <p className="rl-muted">Aucune pièce commandée chez un fournisseur.</p>}
              </div>
            </section>
          </div>

          <div className="rp-kpis rp-kpis--secondary">
            <div className="ga-stat">
              <span className="ga-stat-icon" style={{ background: "#FFE7CC", color: "#C4320A" }}><RotateCcw className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{data.retours}</p><p className="ga-stat-label">Retours · {fmtMoney(data.retoursMontant)}</p></div>
            </div>
            <div className="ga-stat">
              <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#4B2FD8" }}><Receipt className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{fmtMoney(data.avoirsEmis)}</p><p className="ga-stat-label">Avoirs émis · reste {fmtMoney(data.avoirsRestant)}</p></div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
