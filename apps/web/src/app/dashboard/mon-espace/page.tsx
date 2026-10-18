"use client";

import {
  BadgeEuro,
  ChartColumn,
  ClipboardCheck,
  Loader2,
  PackageCheck,
  RefreshCw,
  ShoppingCart,
  Target,
  Trophy,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { LeaveSection } from "@/components/espace/LeaveSection";
import { Toast } from "@/components/ui/Toast";
import { fmtMoney } from "@/lib/data/saas";
import { presetRange, type ReportRange } from "@/lib/data/rapports";
import { loadCounterStats, ordinalFr, pctChange, periodLabel, type CounterStats, type PeriodPreset } from "@/lib/data/espace";
import { createClient } from "@/lib/supabase/client";

const PRESETS: PeriodPreset[] = ["month", "last_month", "30d", "year"];

type Bar = { key: string; label: string; title: string; ca: number; orders: number };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** One bar per day (per month beyond two months), holes filled with zeros. */
function buildBars(range: ReportRange, days: CounterStats["days"]): Bar[] {
  const start = new Date(`${range.from}T00:00:00Z`);
  const end = new Date(`${range.to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const span = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const byMonth = span > 62;
  const bars = new Map<string, Bar>();
  const cursor = new Date(start);
  while (cursor <= end) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth();
    const key = byMonth ? `${y}-${pad(m + 1)}` : `${y}-${pad(m + 1)}-${pad(cursor.getUTCDate())}`;
    if (!bars.has(key)) {
      bars.set(key, {
        key,
        label: byMonth
          ? cursor.toLocaleDateString("fr-FR", { month: "short", timeZone: "UTC" }).replace(".", "")
          : String(cursor.getUTCDate()),
        title: byMonth
          ? cursor.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" })
          : cursor.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }),
        ca: 0,
        orders: 0,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  for (const d of days) {
    const key = byMonth ? d.day.slice(0, 7) : d.day.slice(0, 10);
    const bar = bars.get(key);
    if (bar) {
      bar.ca += d.ca;
      bar.orders += d.orders;
    }
  }
  return [...bars.values()];
}

function pct(part: number, total: number): string {
  if (total <= 0) return "—";
  return `${Math.round((part / total) * 1000) / 10}`.replace(".", ",") + " %";
}

/**
 * « Mon espace » du caissier : ses chiffres sur la période (CA, ventes,
 * devis transformés, classement, pointages) et ses congés. Un administrateur
 * y voit ses propres ventes au même titre qu'un vendeur.
 */
export default function MonEspacePage() {
  const { profile, ready } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [preset, setPreset] = useState<PeriodPreset>("month");
  const range = useMemo<ReportRange>(() => presetRange(preset === "7d" ? "30d" : preset), [preset]);
  const [stats, setStats] = useState<CounterStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await loadCounterStats(supabase, range));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, range]);

  useEffect(() => {
    if (!ready || !profile) return;
    void load();
  }, [ready, profile, load]);

  const bars = useMemo(() => (stats ? buildBars(range, stats.days) : []), [stats, range]);
  const maxBar = useMemo(() => Math.max(1, ...bars.map((b) => b.ca)), [bars]);
  const change = stats ? pctChange(stats.ca, stats.prevCa) : null;
  const rank = ordinalFr(stats?.rank ?? 0);
  const vs = periodLabel(preset).vs;
  const firstName = profile?.display_name?.trim().split(/\s+/)[0] ?? "";

  return (
    <div className="rl-page me-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">Mon espace</h1>
          <p className="rl-subtitle">
            {firstName ? `${firstName}, v` : "V"}os chiffres de la période et vos demandes de congés.
          </p>
        </div>
        <div className="rl-header-actions">
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
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading} aria-label="Actualiser">
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      <section aria-label="Mes chiffres" className="me-kpis">
        <div className="me-kpi">
          <span className="me-kpi-icon"><BadgeEuro /></span>
          <span className="me-kpi-label">Mon chiffre d&apos;affaires</span>
          <span className="me-kpi-value">{stats ? fmtMoney(stats.ca) : "—"}</span>
          {stats && change ? (
            <span className={`me-kpi-sub ${stats.ca >= stats.prevCa ? "me-kpi-sub--up" : "me-kpi-sub--down"}`}>
              {change} <span>{vs}</span>
            </span>
          ) : (
            <span className="me-kpi-sub">{stats ? `Pas de vente sur la période précédente (${vs.replace("vs ", "")})` : "…"}</span>
          )}
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><ShoppingCart /></span>
          <span className="me-kpi-label">Mes ventes</span>
          <span className="me-kpi-value">{stats ? stats.orders : "—"}</span>
          <span className="me-kpi-sub">{stats && stats.orders > 0 ? `Panier moyen ${fmtMoney(stats.panierMoyen)}` : "Commandes enregistrées par vous"}</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><Target /></span>
          <span className="me-kpi-label">Devis transformés</span>
          <span className="me-kpi-value">{stats ? pct(stats.devisAccepted, stats.devisTotal) : "—"}</span>
          <span className="me-kpi-sub">{stats ? `${stats.devisAccepted} accepté${stats.devisAccepted > 1 ? "s" : ""} sur ${stats.devisTotal} devis` : "…"}</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><Trophy /></span>
          <span className="me-kpi-label">Mon classement</span>
          <span className="me-kpi-value">
            {stats && stats.orders > 0 ? (
              <>
                {rank.value}
                <span className="me-kpi-ord">{rank.suffix}</span>
              </>
            ) : (
              "—"
            )}
          </span>
          <span className="me-kpi-sub">
            {stats && stats.orders > 0
              ? `sur ${stats.sellers} vendeur${stats.sellers > 1 ? "s" : ""}, au chiffre d'affaires`
              : "Aucune vente sur la période"}
          </span>
        </div>
      </section>

      <section aria-label="Mon activité" className="me-kpis me-kpis--secondary">
        <div className="me-kpi">
          <span className="me-kpi-icon"><ClipboardCheck /></span>
          <span className="me-kpi-label">Pièces pointées</span>
          <span className="me-kpi-value">{stats ? stats.linesPointed : "—"}</span>
          <span className="me-kpi-sub">Réceptions pointées par vous</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><PackageCheck /></span>
          <span className="me-kpi-label">Pièces remises</span>
          <span className="me-kpi-value">{stats ? stats.linesHanded : "—"}</span>
          <span className="me-kpi-sub">Remises au client ou au livreur</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><Users /></span>
          <span className="me-kpi-label">Ma part du chiffre d&apos;affaires</span>
          <span className="me-kpi-value">{stats ? pct(stats.ca, stats.teamCa) : "—"}</span>
          <span className="me-kpi-sub">{stats ? `Magasin : ${fmtMoney(stats.teamCa)} sur la période` : "…"}</span>
        </div>
      </section>

      <section className="me-card me-chart-card" aria-labelledby="me-chart-title">
        <div className="me-card-head">
          <h2 id="me-chart-title" className="me-card-title">
            <ChartColumn /> Mon chiffre d&apos;affaires {bars.length > 0 && bars[0].key.length === 7 ? "par mois" : "par jour"}
          </h2>
          {stats && stats.remises > 0 && <span className="me-hint">Remises accordées : {fmtMoney(stats.remises)}</span>}
        </div>
        {loading && !stats ? (
          <p className="me-chart-empty">Chargement…</p>
        ) : stats && stats.orders === 0 ? (
          <p className="me-chart-empty">Aucune vente sur la période.</p>
        ) : (
          <div className="me-chart" role="img" aria-label="Chiffre d'affaires par période">
            {bars.map((b) => (
              <div key={b.key} className="me-chart-col" title={`${b.title} : ${fmtMoney(b.ca)} · ${b.orders} commande${b.orders > 1 ? "s" : ""}`}>
                <div className="me-chart-track">
                  <div className="me-chart-bar" style={{ height: `${b.ca > 0 ? Math.max(4, Math.round((b.ca / maxBar) * 100)) : 0}%` }} />
                </div>
                <span className="me-chart-label">{b.label}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <LeaveSection onNotice={setNotice} />
    </div>
  );
}
