"use client";

import { AlertTriangle, Boxes, Loader2, PackageCheck, Route } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LeaveSection } from "@/components/espace/LeaveSection";
import { loadLivreurStats, pctChange, periodLabel, type LivreurStats, type PeriodPreset } from "@/lib/data/espace";
import { presetRange, ymd, type ReportRange } from "@/lib/data/rapports";
import { createClient } from "@/lib/supabase/client";

const PRESETS: PeriodPreset[] = ["7d", "month", "last_month"];

function rangeFor(preset: PeriodPreset): ReportRange {
  if (preset === "7d") {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 6);
    return { from: ymd(from), to: ymd(to) };
  }
  return presetRange(preset === "year" ? "year" : preset === "last_month" ? "last_month" : preset === "30d" ? "30d" : "month");
}

/**
 * Onglet « Mon espace » du livreur : ses livraisons de la période (faites,
 * non livrées, pièces récupérées chez les fournisseurs, tournées terminées)
 * et ses congés. Servi par my_livreur_stats() — aucun montant, aucune
 * lecture directe des commandes.
 */
export function EspaceTab({ online, onNotice }: { online: boolean; onNotice: (message: string) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [preset, setPreset] = useState<PeriodPreset>("7d");
  const range = useMemo(() => rangeFor(preset), [preset]);
  const [stats, setStats] = useState<LivreurStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await loadLivreurStats(supabase, range));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = stats ? pctChange(stats.delivered, stats.prevDelivered) : null;
  const vs = periodLabel(preset).vs;

  return (
    <div className="me-stack">
      <div className="me-card-head">
        <p className="lp-section">Mes chiffres</p>
        <div className="me-period" role="tablist" aria-label="Période">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={preset === p}
              className={`nc-chip${preset === p ? " nc-chip--on" : ""}`}
              onClick={() => setPreset(p)}
            >
              {periodLabel(p).label}
            </button>
          ))}
        </div>
      </div>

      {!online && !stats && <p className="me-empty">Les chiffres s&apos;affichent dès que le téléphone a du réseau.</p>}
      {error && <div className="nc-error">{error}</div>}

      <section aria-label="Mes livraisons" className="me-kpis">
        <div className="me-kpi">
          <span className="me-kpi-icon"><PackageCheck /></span>
          <span className="me-kpi-label">Livraisons faites</span>
          <span className="me-kpi-value">{stats ? stats.delivered : loading ? <Loader2 className="h-5 w-5 nc-spin" /> : "—"}</span>
          {stats && change ? (
            <span className={`me-kpi-sub ${stats.delivered >= stats.prevDelivered ? "me-kpi-sub--up" : "me-kpi-sub--down"}`}>
              {change} <span>{vs}</span>
            </span>
          ) : (
            <span className="me-kpi-sub">Commandes livrées par vous</span>
          )}
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><AlertTriangle /></span>
          <span className="me-kpi-label">Non livrées</span>
          <span className="me-kpi-value">{stats ? stats.failed : "—"}</span>
          <span className="me-kpi-sub">Passages sans remise</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><Boxes /></span>
          <span className="me-kpi-label">Pièces récupérées</span>
          <span className="me-kpi-value">{stats ? stats.pickups : "—"}</span>
          <span className="me-kpi-sub">Chez les fournisseurs</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><Route /></span>
          <span className="me-kpi-label">Tournées terminées</span>
          <span className="me-kpi-value">{stats ? stats.tours : "—"}</span>
          <span className="me-kpi-sub">Tournées fournisseurs</span>
        </div>
      </section>

      <p className="lp-section">Mes congés</p>
      <LeaveSection onNotice={onNotice} />
    </div>
  );
}
