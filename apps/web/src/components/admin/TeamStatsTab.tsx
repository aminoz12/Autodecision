"use client";

import { BadgeEuro, CalendarDays, ChartColumn, Loader2, RefreshCw, ShoppingCart, Target, Truck, Users } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadTeamStats, pctChange, periodLabel, type PeriodPreset, type TeamStats } from "@/lib/data/espace";
import { presetRange, type ReportRange } from "@/lib/data/rapports";
import { fmtMoney } from "@/lib/data/saas";
import { createClient } from "@/lib/supabase/client";

const PRESETS: PeriodPreset[] = ["month", "last_month", "30d", "year"];
const ROLE_LABEL: Record<string, string> = { ADMIN: "Administrateur", CAISSIER: "Caissier", LIVREUR: "Livreur" };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function pct(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${String(v).replace(".", ",")} %`;
}

/**
 * Onglet « Stats équipe » de l'administration (2026-10-19, user: « l'admin
 * ne demande pas de congé, il doit avoir son propre espace : rentabilité
 * et travail des vendeurs, classement »). Chiffres du magasin sur la
 * période, classement des vendeurs (CA, ventes, devis transformés, marge,
 * retours, pointages, part du CA) et activité des livreurs.
 */
export function TeamStatsTab({ onOpenConges }: { onOpenConges: () => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [preset, setPreset] = useState<PeriodPreset>("month");
  const range = useMemo<ReportRange>(() => presetRange(preset === "7d" ? "30d" : preset), [preset]);
  const [stats, setStats] = useState<TeamStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await loadTeamStats(supabase, range));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const vs = periodLabel(preset).vs;
  const team = stats?.team ?? null;
  const caChange = stats ? pctChange(stats.team.ca, stats.prev.ca) : null;
  const ordersChange = stats ? pctChange(stats.team.orders, stats.prev.orders) : null;
  const sellers = stats?.sellers ?? [];
  const sellersCa = sellers.reduce((s, x) => s + x.ca, 0);
  const activeSellers = sellers.filter((s) => s.orders > 0).length;

  return (
    <div className="me-stack ts-tab">
      <div className="ts-head">
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
        <div className="me-period">
          <button type="button" className="od-btn od-btn--ghost" onClick={onOpenConges}>
            <CalendarDays className="h-4 w-4" /> Gérer les congés
          </button>
          <Link href="/dashboard/rapports" className="od-btn od-btn--ghost">
            <ChartColumn className="h-4 w-4" /> Rapports du magasin
          </Link>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading} aria-label="Actualiser">
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {error && <div className="nc-error">{error}</div>}

      <section aria-label="Chiffres du magasin" className="me-kpis">
        <div className="me-kpi">
          <span className="me-kpi-icon"><BadgeEuro /></span>
          <span className="me-kpi-label">Chiffre d&apos;affaires</span>
          <span className="me-kpi-value">{team ? fmtMoney(team.ca) : "—"}</span>
          {team && caChange ? (
            <span className={`me-kpi-sub ${team.ca >= stats!.prev.ca ? "me-kpi-sub--up" : "me-kpi-sub--down"}`}>
              {caChange} <span>{vs}</span>
            </span>
          ) : (
            <span className="me-kpi-sub">{team ? "Pas de référence sur la période précédente" : "…"}</span>
          )}
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><ShoppingCart /></span>
          <span className="me-kpi-label">Ventes</span>
          <span className="me-kpi-value">{team ? team.orders : "—"}</span>
          {team && ordersChange ? (
            <span className={`me-kpi-sub ${team.orders >= stats!.prev.orders ? "me-kpi-sub--up" : "me-kpi-sub--down"}`}>
              {ordersChange} <span>{vs}</span>
            </span>
          ) : (
            <span className="me-kpi-sub">{team && team.orders > 0 ? `Panier moyen ${fmtMoney(team.panierMoyen)}` : "Commandes de la période"}</span>
          )}
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><Target /></span>
          <span className="me-kpi-label">Devis transformés</span>
          <span className="me-kpi-value">{team ? fmtPct(pct(team.devisAccepted, team.devisTotal)) : "—"}</span>
          <span className="me-kpi-sub">{team ? `${team.devisAccepted} accepté${team.devisAccepted > 1 ? "s" : ""} sur ${team.devisTotal} devis` : "…"}</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><Users /></span>
          <span className="me-kpi-label">Marge estimée · retours</span>
          <span className="me-kpi-value">{team && team.marge > 0 ? fmtPct(pct(team.marge, team.ca)) : "—"}</span>
          <span className="me-kpi-sub">
            {team ? `${team.marge > 0 ? fmtMoney(team.marge) + " de marge" : "Marge inconnue (prix d'achat non saisis)"} · ${team.retours} retour${team.retours > 1 ? "s" : ""} (${fmtPct(pct(team.retours, team.orders))} des ventes)` : "…"}
          </span>
        </div>
      </section>

      <section className="me-card" aria-labelledby="ts-sellers-title">
        <div className="me-card-head">
          <h2 id="ts-sellers-title" className="me-card-title"><Users /> Classement des vendeurs</h2>
          <span className="me-hint">
            {stats ? `${activeSellers} vendeur${activeSellers > 1 ? "s" : ""} actif${activeSellers > 1 ? "s" : ""} sur ${sellers.length} · au chiffre d'affaires` : "…"}
          </span>
        </div>
        {loading && !stats ? (
          <p className="me-empty"><Loader2 className="h-4 w-4 nc-spin" /> Chargement…</p>
        ) : sellers.length === 0 ? (
          <p className="me-empty">Aucun vendeur dans l&apos;équipe.</p>
        ) : (
          <div className="me-table-wrap">
            <table className="me-table ts-table">
              <thead>
                <tr>
                  <th>Rang</th>
                  <th className="ts-left">Vendeur</th>
                  <th>Ventes</th>
                  <th>CA</th>
                  <th>Part</th>
                  <th>Panier</th>
                  <th>Devis transformés</th>
                  <th>Marge</th>
                  <th>Retours</th>
                  <th>Pointées</th>
                  <th>Remises</th>
                </tr>
              </thead>
              <tbody>
                {sellers.map((s, i) => {
                  const transfo = pct(s.devisAccepted, s.devisTotal);
                  const rank = s.orders > 0 ? i + 1 : null;
                  return (
                    <tr key={s.userId} className={s.orders === 0 ? "ts-row--idle" : ""}>
                      <td>{rank ? <span className={`ts-rank ts-rank--${Math.min(rank, 4)}`}>{rank}</span> : <span className="ts-muted">—</span>}</td>
                      <td className="ts-left">
                        <span className="ts-who">
                          <span className="me-avatar me-avatar--sm">{initials(s.name)}</span>
                          <span>
                            <span className="me-req-name">{s.name}</span>
                            <span className="me-req-meta"> · {ROLE_LABEL[s.role] ?? s.role}</span>
                          </span>
                        </span>
                      </td>
                      <td>{s.orders}</td>
                      <td><strong>{fmtMoney(s.ca)}</strong></td>
                      <td>{fmtPct(pct(s.ca, sellersCa))}</td>
                      <td>{s.orders > 0 ? fmtMoney(s.panierMoyen) : "—"}</td>
                      <td>
                        <span className="ts-bar">
                          <span className="ts-bar-track"><span className="ts-bar-fill" style={{ width: `${transfo ?? 0}%` }} /></span>
                          {fmtPct(transfo)}
                          <span className="ts-muted">· {s.devisTotal}</span>
                        </span>
                      </td>
                      <td>{s.ca > 0 && s.marge > 0 ? fmtPct(pct(s.marge, s.ca)) : "—"}</td>
                      <td>
                        {s.retours}
                        {s.orders > 0 && s.retours > 0 && <span className="ts-muted"> · {fmtPct(pct(s.retours, s.orders))}</span>}
                      </td>
                      <td>{s.linesPointed}</td>
                      <td>{s.linesHanded}</td>
                    </tr>
                  );
                })}
              </tbody>
              {team && (
                <tfoot>
                  <tr>
                    <td></td>
                    <td className="ts-left">Équipe comptoir</td>
                    <td>{sellers.reduce((n, s) => n + s.orders, 0)}</td>
                    <td>{fmtMoney(sellersCa)}</td>
                    <td>{fmtPct(pct(sellersCa, team.ca))}</td>
                    <td>{(() => { const n = sellers.reduce((x, s) => x + s.orders, 0); return n > 0 ? fmtMoney(sellersCa / n) : "—"; })()}</td>
                    <td>{fmtPct(pct(sellers.reduce((n, s) => n + s.devisAccepted, 0), sellers.reduce((n, s) => n + s.devisTotal, 0)))}</td>
                    <td>{sellersCa > 0 ? fmtPct(pct(sellers.reduce((n, s) => n + s.marge, 0), sellersCa)) : "—"}</td>
                    <td>{sellers.reduce((n, s) => n + s.retours, 0)}</td>
                    <td>{sellers.reduce((n, s) => n + s.linesPointed, 0)}</td>
                    <td>{sellers.reduce((n, s) => n + s.linesHanded, 0)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        <p className="me-hint">
          CA et ventes = commandes enregistrées par le vendeur (hors devis, réappro et annulations). « Part » = part du CA du comptoir ; le CA du
          magasin inclut aussi les commandes passées par les garages sur leur portail. Marge estimée sur les pièces dont le prix d&apos;achat est connu.
        </p>
      </section>

      <section className="me-card" aria-labelledby="ts-livreurs-title">
        <div className="me-card-head">
          <h2 id="ts-livreurs-title" className="me-card-title"><Truck /> Livreurs</h2>
          <Link href="/dashboard/livreurs" className="me-hint">Gérer les livreurs</Link>
        </div>
        {!stats ? (
          <p className="me-empty">…</p>
        ) : stats.livreurs.length === 0 ? (
          <p className="me-empty">Aucun livreur.</p>
        ) : (
          <div className="me-table-wrap">
            <table className="me-table ts-table">
              <thead>
                <tr>
                  <th className="ts-left">Livreur</th>
                  <th>Livraisons</th>
                  <th>Non livrées</th>
                  <th>Pièces récupérées</th>
                  <th>Tournées terminées</th>
                </tr>
              </thead>
              <tbody>
                {stats.livreurs.map((l) => (
                  <tr key={l.livreurId} className={l.active ? "" : "ts-row--idle"}>
                    <td className="ts-left">
                      <span className="ts-who">
                        <span className="me-avatar me-avatar--sm">{initials(l.name)}</span>
                        <span>
                          <span className="me-req-name">{l.name}</span>
                          <span className="me-req-meta"> · {l.active ? (l.userId ? "accès livreur" : "sans accès") : "désactivé"}</span>
                        </span>
                      </span>
                    </td>
                    <td><strong>{l.delivered}</strong></td>
                    <td>{l.failed}</td>
                    <td>{l.pickups}</td>
                    <td>{l.tours}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
