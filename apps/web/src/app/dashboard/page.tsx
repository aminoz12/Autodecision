"use client";

import {
  ArrowRight,
  Calendar,
  ChevronDown,
  CirclePlus,
  ClipboardCheck,
  Clock,
  Package,
  RotateCcw,
  ShoppingCart,
  Star,
  Trophy,
  TrendingDown,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { GlobalSearch } from "@/components/ui/GlobalSearch";
import { createClient } from "@/lib/supabase/client";
import {
  loadDashboardOverview,
  workflowLabel,
  type DashboardOverview,
} from "@/lib/data/dashboard";

/* ------------------------------------------------------------------ */
/*  Static (non-data) navigation cards                                */
/* ------------------------------------------------------------------ */

const secondaryActions = [
  {
    icon: ClipboardCheck,
    title: "Réceptions",
    description: "Pointer les pièces attendues",
    href: "/dashboard/commandes",
  },
  {
    icon: RotateCcw,
    title: "Retour pièce",
    description: "Créer ou suivre un retour",
    href: "/dashboard/retours",
  },
];

/* ------------------------------------------------------------------ */
/*  Mini sparkline SVG                                                */
/* ------------------------------------------------------------------ */

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const safe = data.length ? data : [0, 0];
  const max = Math.max(...safe);
  const min = Math.min(...safe);
  const range = max - min || 1;
  const width = 60;
  const height = 24;
  const points = safe
    .map((v, i) => {
      const x = (i / (safe.length - 1)) * width;
      const y = height - ((v - min) / range) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="sparkline">
      <polyline fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} />
    </svg>
  );
}

function StatusBadge({ label, type }: { label: string; type: "success" | "info" | "warning" }) {
  return <span className={`status-badge status-badge--${type}`}>{label}</span>;
}

function frDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
}

/* ------------------------------------------------------------------ */
/*  Main Dashboard Page (Supabase-wired)                              */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const { profile } = useAuth();
  const [data, setData] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.organization_id) return;
    let cancelled = false;
    setLoading(true);
    const sb = createClient();
    loadDashboardOverview(sb, profile.organization_id)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.organization_id]);

  const k = data?.kpis;
  const spark = data?.ordersSpark ?? [];
  const deltaText =
    k === undefined
      ? ""
      : `${k.commandesDuJourDelta >= 0 ? "+" : ""}${k.commandesDuJourDelta} vs hier`;

  const stats: {
    label: string;
    value: number;
    change: string;
    changeColor: string;
    iconBg: string;
    iconColor: string;
    icon: LucideIcon;
  }[] = [
    { label: "Commandes du jour", value: k?.commandesDuJour ?? 0, change: deltaText, changeColor: (k?.commandesDuJourDelta ?? 0) >= 0 ? "var(--clr-success)" : "var(--clr-warning)", iconBg: "#FEF3C7", iconColor: "#D97706", icon: ShoppingCart },
    { label: "Réceptions attendues", value: k?.receptionsAttendues ?? 0, change: "Lignes à recevoir", changeColor: "var(--clr-info)", iconBg: "#DBEAFE", iconColor: "#2563EB", icon: Package },
    { label: "Commandes en attente", value: k?.commandesEnAttente ?? 0, change: "En cours fournisseur", changeColor: "var(--clr-warning)", iconBg: "#FEE2E2", iconColor: "#DC2626", icon: Clock },
    { label: "Retours à traiter", value: k?.retoursATraiter ?? 0, change: "Demandes enregistrées", changeColor: "var(--clr-warning)", iconBg: "#F3E8FF", iconColor: "#7C3AED", icon: RotateCcw },
  ];

  const filledStars = Math.round(data?.avgRating ?? 0);
  const todayLabel = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div className="dashboard-content">
      {/* Header */}
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <h1 className="dashboard-greeting">
            Bonjour {profile?.display_name || "👋"} <span>👋</span>
          </h1>
          <p className="dashboard-subtitle">
            {loading
              ? "Chargement des données…"
              : error
                ? `Erreur: ${error}`
                : "Voici ce qui se passe dans votre magasin aujourd'hui."}
          </p>
        </div>
        <div className="dashboard-header-right">
          <GlobalSearch />
        </div>
      </header>

      {/* Counter workbench: one unmistakable primary action, then two shortcuts. */}
      <section className="dashboard-workbench" aria-label="Actions du comptoir">
        <Link href="/dashboard/nouvelle-commande" className="dashboard-primary-action">
          <span className="dashboard-primary-action-icon"><CirclePlus className="h-6 w-6" /></span>
          <span className="dashboard-primary-action-copy">
            <span className="dashboard-eyebrow"><Wrench className="h-3.5 w-3.5" /> Comptoir</span>
            <strong>Nouvelle commande</strong>
            <span>Créer une commande client ou fournisseur</span>
          </span>
          <span className="dashboard-primary-action-cta">Commencer <ArrowRight className="h-4 w-4" /></span>
        </Link>

        <div className="dashboard-secondary-actions">
          {secondaryActions.map((action) => {
            const Icon = action.icon;
            return (
              <Link key={action.title} href={action.href} className="dashboard-secondary-action">
                <span className="dashboard-secondary-action-icon"><Icon className="h-4 w-4" /></span>
                <span>
                  <strong>{action.title}</strong>
                  <small>{action.description}</small>
                </span>
                <ArrowRight className="dashboard-secondary-action-arrow h-4 w-4" />
              </Link>
            );
          })}
        </div>

        <div className="dashboard-date-row">
          <span className="dashboard-date-label">Vue du jour</span>
          <button type="button" className="date-picker-btn" aria-label="Choisir la date affichée">
            <Calendar className="h-4 w-4" />
            <span style={{ textTransform: "capitalize" }}>{todayLabel}</span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </button>
        </div>
      </section>

      {/* Stat cards */}
      <section aria-labelledby="dashboard-kpis-title">
        <div className="dashboard-section-heading">
          <div>
            <p className="dashboard-eyebrow">À surveiller</p>
            <h2 id="dashboard-kpis-title">L’activité du comptoir</h2>
          </div>
          <p>Les priorités opérationnelles de la journée.</p>
        </div>
        <div className="stats-grid">
          {stats.map((s) => {
            const Icon = s.icon;
            return (
              <div key={s.label} className="stat-card" style={{ "--accent": s.iconColor } as React.CSSProperties}>
                <div className="stat-card-top">
                  <div className="stat-icon-wrap" style={{ backgroundColor: s.iconBg }}>
                    <Icon style={{ color: s.iconColor }} className="h-5 w-5" />
                  </div>
                  <span className="stat-label">{s.label}</span>
                </div>
                <div className="stat-card-bottom">
                  <div>
                    <p className="stat-value">{s.value}</p>
                    <p className="stat-change" style={{ color: s.changeColor }}>{s.change}</p>
                  </div>
                  <Sparkline data={spark} color={s.changeColor} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Tables row */}
      <div className="tables-grid">
        {/* Réceptions en attente par fournisseur */}
        <div className="table-card">
          <h2 className="table-card-title">Réceptions en attente (par fournisseur)</h2>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Fournisseur</th>
                  <th>Pièces à recevoir</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {(data?.pendingReceptions ?? []).map((r) => (
                  <tr key={r.supplier}>
                    <td>{r.supplier}</td>
                    <td>{r.pieces}</td>
                    <td><StatusBadge label="En attente" type="warning" /></td>
                  </tr>
                ))}
                {!loading && (data?.pendingReceptions.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={3}>
                      <div className="dashboard-empty-state">
                        <Package className="h-5 w-5" />
                        <div><strong>Rien à réceptionner</strong><span>Les prochaines pièces attendues apparaîtront ici.</span></div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Link href="/dashboard/commandes" className="table-card-link">
            Voir toutes les réceptions <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        {/* Commandes récentes */}
        <div className="table-card">
          <div className="table-card-header">
            <h2 className="table-card-title">Commandes récentes</h2>
            <Link href="/dashboard/commandes" className="table-see-all">
              Voir toutes <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>N° Commande</th>
                  <th>Client</th>
                  <th>Statut</th>
                  <th>Livraison prévue</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recentOrders ?? []).map((o) => {
                  const wf = workflowLabel(o.workflow);
                  return (
                    <tr key={o.id}>
                      <td className="order-id">
                        <Link href={`/dashboard/commandes/${o.id}`} className="rc-cmd">
                          {o.ref}
                        </Link>
                      </td>
                      <td>{o.client}</td>
                      <td><StatusBadge label={wf.label} type={wf.type} /></td>
                      <td className="text-muted">{frDate(o.livraison)}</td>
                    </tr>
                  );
                })}
                {!loading && (data?.recentOrders.length ?? 0) === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <div className="dashboard-empty-state">
                        <ShoppingCart className="h-5 w-5" />
                        <div><strong>Le comptoir est prêt</strong><span>La première commande de la journée apparaîtra ici.</span></div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Bottom stats row */}
      <div className="bottom-stats">
        <div className="bottom-stat-card bottom-stat--loyalty">
          <div className="loyalty-trophy">
            <Trophy className="h-8 w-8" style={{ color: "#D97706" }} />
          </div>
          <div className="loyalty-content">
            <p className="loyalty-title">Score fidélité moyen</p>
            <div className="loyalty-stars">
              {[1, 2, 3, 4, 5].map((i) => (
                <Star key={i} className="h-5 w-5" fill={i <= filledStars ? "#F59E0B" : "none"} stroke="#F59E0B" />
              ))}
              <span className="loyalty-score">
                {data?.avgRating != null ? `${data.avgRating.toFixed(1).replace(".", ",")} /5` : "—"}
              </span>
            </div>
            <p className="loyalty-sub">Basé sur {data?.activeClients ?? 0} clients actifs</p>
          </div>
        </div>

        <div className="bottom-stat-card">
          <div className="bottom-stat-inner">
            <p className="bottom-stat-label">
              <Trophy className="h-4 w-4 inline-block mr-1 opacity-60" />
              Top client du mois
            </p>
            <p className="bottom-stat-value-name">
              <span className="bottom-stat-fire">🏆</span> {data?.topClient?.name ?? "—"}
            </p>
            <span className="bottom-stat-tag">{data?.topClient?.count ?? 0} commandes</span>
          </div>
        </div>

        <div className="bottom-stat-card">
          <div className="bottom-stat-inner">
            <p className="bottom-stat-label">
              <TrendingDown className="h-4 w-4 inline-block mr-1 opacity-60" />
              Taux de retour
            </p>
            <p className="bottom-stat-value-big">
              {data?.returnRate != null ? `${data.returnRate.toFixed(1).replace(".", ",")} %` : "—"}
            </p>
            <p className="bottom-stat-negative">retours / commandes</p>
          </div>
        </div>
      </div>
    </div>
  );
}
