"use client";

import { Loader2, RefreshCw, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { loadGarageOrders, WORKFLOW_LABEL, type GarageOrder } from "@/lib/data/garage";

function eur(v: number) {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

export default function FacturesPage() {
  const { supabase, profile } = useAuth();
  const [orders, setOrders] = useState<GarageOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    setLoading(true);
    setError(null);
    try {
      setOrders(await loadGarageOrders(supabase, profile.organization_id, profile.client_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.organization_id, profile?.client_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const billed = orders.filter((o) => o.total > 0);
    return {
      total: billed.reduce((s, o) => s + o.total, 0),
      paid: billed.reduce((s, o) => s + o.paid, 0),
      balance: billed.reduce((s, o) => s + o.balance, 0),
    };
  }, [orders]);

  const billed = orders.filter((o) => o.total > 0);

  return (
    <div className="gp-page">
      <header className="gp-header gp-header--row">
        <div>
          <h1 className="gp-title">Factures &amp; encours</h1>
          <p className="gp-subtitle">Le détail de vos commandes facturées et votre solde.</p>
        </div>
        <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualiser
        </button>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="gp-stats">
        <div className="gp-stat"><span className="gp-stat-label">Total facturé</span><span className="gp-stat-value">{eur(totals.total)}</span></div>
        <div className="gp-stat"><span className="gp-stat-label">Payé</span><span className="gp-stat-value" style={{ color: "#16A34A" }}>{eur(totals.paid)}</span></div>
        <div className="gp-stat gp-stat--accent">
          <span className="gp-stat-label"><Wallet className="h-4 w-4" /> Encours (reste à payer)</span>
          <span className="gp-stat-value" style={{ color: totals.balance > 0 ? "#DC2626" : "#16A34A" }}>{eur(totals.balance)}</span>
        </div>
      </div>

      <section className="gp-card">
        <div className="gp-card-title">Détail par commande</div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr><th>Commande</th><th>Date</th><th>Statut</th><th className="stk-th-center">Total</th><th className="stk-th-center">Payé</th><th className="stk-th-center">Reste</th></tr>
            </thead>
            <tbody>
              {billed.map((o) => {
                const st = WORKFLOW_LABEL[o.workflow] ?? { label: o.workflow, cls: "amber" };
                return (
                  <tr key={o.id}>
                    <td className="stk-ref">{o.ref}</td>
                    <td className="rl-muted-strong">{frDate(o.date)}</td>
                    <td><span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span></td>
                    <td className="stk-td-center">{eur(o.total)}</td>
                    <td className="stk-td-center">{eur(o.paid)}</td>
                    <td className="stk-td-center" style={{ color: o.balance > 0 ? "#DC2626" : "#16A34A", fontWeight: 700 }}>{eur(o.balance)}</td>
                  </tr>
                );
              })}
              {!loading && billed.length === 0 && (
                <tr><td colSpan={6} className="stk-empty">Aucune facture pour le moment. Les montants apparaissent une fois la commande chiffrée par le magasin.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="gp-note">
        💳 Le paiement et l&apos;envoi de justificatifs (capture de virement) seront
        bientôt disponibles ici.
      </p>
    </div>
  );
}
