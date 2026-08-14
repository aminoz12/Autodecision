"use client";

import { Coins, PackageCheck, RefreshCw, RotateCcw, Wallet } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtMoney } from "@/lib/data/saas";
import {
  loadConsignes,
  markConsigneReturned,
  reopenConsigne,
  type ConsigneRow,
} from "@/lib/data/consignes";

const STATUS_CLASS: Record<string, string> = {
  ACTIF: "encours",
  RENDUE: "utilise",
};

export default function ConsignesPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<ConsigneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadConsignes(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleStatus = useCallback(
    async (row: ConsigneRow) => {
      if (!profile?.organization_id) return;
      setBusyId(row.id);
      setError(null);
      try {
        const sb = createClient();
        if (row.status === "ACTIF") {
          await markConsigneReturned(sb, profile.organization_id, row.id);
        } else {
          await reopenConsigne(sb, profile.organization_id, row.id);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [profile?.organization_id, load],
  );

  const totals = useMemo(() => {
    const active = rows.filter((r) => r.status === "ACTIF");
    const returned = rows.filter((r) => r.status === "RENDUE");
    return {
      held: active.reduce((s, r) => s + r.amount, 0),
      activeCount: active.length,
      returned: returned.reduce((s, r) => s + r.amount, 0),
    };
  }, [rows]);

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">Consignes</h1>
          <p className="rl-subtitle">
            Suivi des cautions sur pièces échange / réparation : montant retenu
            jusqu&apos;au retour de la vieille pièce (cœur).
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="rl-refresh" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      <div className="av-summary">
        <div className="av-sum-card av-sum-card--orange">
          <span className="av-sum-icon av-sum-icon--orange"><Wallet className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Consignes en cours (caution retenue)</p>
            <p className="av-sum-value av-sum-value--orange">{fmtMoney(totals.held)}</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--green">
          <span className="av-sum-icon av-sum-icon--green"><Coins className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Pièces à récupérer</p>
            <p className="av-sum-value av-sum-value--green">{totals.activeCount}</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--green">
          <span className="av-sum-icon av-sum-icon--green"><PackageCheck className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Consignes rendues</p>
            <p className="av-sum-value av-sum-value--green">{fmtMoney(totals.returned)}</p>
          </div>
        </div>
      </div>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table av-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>N° Consigne</th>
                <th>Client</th>
                <th>Commande</th>
                <th>Référence</th>
                <th>Pièce</th>
                <th className="av-th-right">Qté</th>
                <th className="av-th-right">Caution</th>
                <th>Statut</th>
                <th aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="rl-muted-strong">{fmtDate(row.createdAt)}</td>
                  <td><span className="av-num av-num--consigne">{row.num}</span></td>
                  <td><p className="rl-client">{row.client}</p></td>
                  <td className="rl-reffour">{row.orderRef ?? "-"}</td>
                  <td className="rl-reffour">{row.reference}</td>
                  <td><p className="av-motif">{row.description}</p></td>
                  <td className="av-th-right">{row.quantity}</td>
                  <td className="av-th-right av-montant av-montant--consigne">{fmtMoney(row.amount)}</td>
                  <td><span className={`av-statut av-statut--${STATUS_CLASS[row.status] ?? "encours"}`}>{row.status}</span></td>
                  <td className="od-td-right">
                    <button
                      type="button"
                      className="od-btn od-btn--ghost"
                      disabled={busyId === row.id}
                      onClick={() => void toggleStatus(row)}
                    >
                      <RotateCcw className="h-4 w-4" />
                      {row.status === "ACTIF" ? "Marquer rendue" : "Rouvrir"}
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={10} className="text-muted">Aucune consigne.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{rows.length} consigne(s)</span>
        </div>
      </section>
    </div>
  );
}
