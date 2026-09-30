"use client";

import { ArrowRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { loadGarageReturns, RETURN_LABEL, type GarageReturn } from "@/lib/data/garage";

function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

/**
 * The garage follows its return requests here. A request is made from
 * « Mes commandes », article by article; the magasin validates, the livreur
 * collects, the magasin receives.
 */
export default function GarageReturnsPage() {
  const { supabase, profile } = useAuth();
  const [returns, setReturns] = useState<GarageReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    setLoading(true);
    setError(null);
    try {
      setReturns(await loadGarageReturns(supabase, profile.organization_id, profile.client_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.organization_id, profile?.client_id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="gp-page">
      <header className="gp-header">
        <h1 className="gp-title">Retours</h1>
        <p className="gp-subtitle">Vos demandes de retour et leur avancement : validation par le magasin, passage du livreur, réception.</p>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="gp-card gp-return-howto">
        <RotateCcw className="h-5 w-5" />
        <div>
          <strong>Pour demander un retour</strong>
          <span>Ouvrez la commande dans « Mes commandes » et cliquez « Demander un retour » sur l&apos;article : quantité, motif, commentaire.</span>
        </div>
        <Link href="/garagiste/dashboard/commandes" className="od-btn od-btn--primary">
          Mes commandes <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <section className="gp-card">
        <div className="gp-card-title">Mes demandes de retour</div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th>Réf.</th>
                <th>Pièce</th>
                <th>Motif</th>
                <th>Commande</th>
                <th>Date</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => {
                const st = RETURN_LABEL[r.status] ?? { label: r.status, cls: "amber" };
                return (
                  <tr key={r.id}>
                    <td className="stk-ref">{r.ref}</td>
                    <td>
                      {r.quantity > 1 ? `${r.quantity} × ` : ""}
                      {r.designation}
                    </td>
                    <td className="rl-muted">{r.reason}</td>
                    <td>{r.orderRef ?? "—"}</td>
                    <td className="rl-muted-strong">{frDate(r.createdAt)}</td>
                    <td>
                      <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                      {r.status === "A_RECUPERER" && r.legDone && <span className="rl-muted"> · récupérée par le livreur</span>}
                    </td>
                  </tr>
                );
              })}
              {!loading && returns.length === 0 && (
                <tr>
                  <td colSpan={6} className="stk-empty">Aucune demande de retour pour l&apos;instant.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
