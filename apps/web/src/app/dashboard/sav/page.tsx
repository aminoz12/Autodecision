"use client";

import {
  AlarmClock,
  Ban,
  CarFront,
  ChartColumn,
  ClipboardList,
  Hourglass,
  LifeBuoy,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  TimerReset,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OpenCaseDialog, type OpenCasePreset } from "@/components/sav/OpenCaseDialog";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtDateTime, fmtMoney } from "@/lib/data/saas";
import {
  SavUnavailableError,
  cancelQueuedMessage,
  loadClientMessages,
  loadSavCases,
  loadSavDashboard,
  type ClientMessage,
  type SavCaseRow,
  type SavDashboard,
} from "@/lib/data/sav";
import {
  CASE_TYPE_LABEL,
  CLIENT_STATUS_LABEL,
  SUPPLIER_STATUS_LABEL,
  clientStatusTone,
  familyLabel,
  motifLabel,
  slaHoursLeft,
  supplierStatusTone,
} from "@/lib/sav";
import { QUEUED_SMS_LABEL, type QueuedSmsKind } from "@/lib/sms";

type TabId = "dossiers" | "analyses" | "messages";
type CaseFilter = "OUVERTS" | "GARANTIE" | "LITIGE" | "RETARD" | "A_DECLARER" | "ATTENTE_AVOIR" | "CLOS";

const FILTERS: { id: CaseFilter; label: string }[] = [
  { id: "OUVERTS", label: "Ouverts" },
  { id: "GARANTIE", label: "Garanties" },
  { id: "LITIGE", label: "Litiges" },
  { id: "RETARD", label: "En retard" },
  { id: "A_DECLARER", label: "À déclarer au fournisseur" },
  { id: "ATTENTE_AVOIR", label: "En attente d'avoir fournisseur" },
  { id: "CLOS", label: "Clos" },
];

const SUPPLIER_SILENCE_DAYS = 15;

/** Why a case is late: silent supplier, or a garage still waiting for a first answer. */
function lateReason(c: SavCaseRow, now: number): string | null {
  if (c.closedAt) return null;
  const sla = slaHoursLeft(c.slaDueAt, c.firstResponseAt, new Date(now));
  if (sla != null && sla < 0) return `Sans réponse depuis ${Math.abs(sla)} h`;
  if (c.supplierStatus === "DECLARE" || c.supplierStatus === "EN_ATTENTE") {
    const since = new Date(c.supplierDeclaredAt ?? c.openedAt).getTime();
    const days = Math.floor((now - since) / 86_400_000);
    if (days >= SUPPLIER_SILENCE_DAYS) return `${c.supplierName ?? "Fournisseur"} muet depuis ${days} j`;
  }
  return null;
}

function Bar({ value, max, tone = "primary" }: { value: number; max: number; tone?: "primary" | "danger" | "warning" }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <span className="sav-bar">
      <span className={`sav-bar-fill sav-bar-fill--${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

export default function SavPage() {
  const { profile } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("dossiers");
  const [filter, setFilter] = useState<CaseFilter>("OUVERTS");
  const [search, setSearch] = useState("");
  const [dash, setDash] = useState<SavDashboard | null>(null);
  const [cases, setCases] = useState<SavCaseRow[]>([]);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [preset, setPreset] = useState<OpenCasePreset | null>(null);
  const [now] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      const [d, c, m] = await Promise.all([
        loadSavDashboard(sb),
        loadSavCases(sb, profile.organization_id),
        loadClientMessages(sb, profile.organization_id, { limit: 150 }),
      ]);
      setDash(d);
      setCases(c);
      setMessages(m);
    } catch (e) {
      if (e instanceof SavUnavailableError) setUnavailable(true);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const late = useMemo(() => new Map(cases.map((c) => [c.id, lateReason(c, now)] as const)), [cases, now]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cases.filter((c) => {
      const pass =
        filter === "OUVERTS"
          ? !c.closedAt
          : filter === "GARANTIE"
            ? c.type === "GARANTIE" && !c.closedAt
            : filter === "LITIGE"
              ? c.type === "LITIGE" && !c.closedAt
              : filter === "RETARD"
                ? late.get(c.id) != null
                : filter === "A_DECLARER"
                  ? c.supplierStatus === "A_DECLARER"
                  : filter === "ATTENTE_AVOIR"
                    ? ["DECLARE", "EN_ATTENTE", "ACCORDE"].includes(c.supplierStatus ?? "")
                    : Boolean(c.closedAt);
      if (!pass) return false;
      if (!q) return true;
      return [c.ref, c.clientName, c.designation, c.reference, c.immatriculation, c.supplierName, c.supplierCaseNumber, c.serialNumber]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [cases, filter, search, late]);

  const counts = useMemo(() => {
    const open = cases.filter((c) => !c.closedAt);
    return {
      OUVERTS: open.length,
      GARANTIE: open.filter((c) => c.type === "GARANTIE").length,
      LITIGE: open.filter((c) => c.type === "LITIGE").length,
      RETARD: cases.filter((c) => late.get(c.id) != null).length,
      A_DECLARER: cases.filter((c) => c.supplierStatus === "A_DECLARER").length,
      ATTENTE_AVOIR: cases.filter((c) => ["DECLARE", "EN_ATTENTE", "ACCORDE"].includes(c.supplierStatus ?? "")).length,
      CLOS: cases.length - open.length,
    } as Record<CaseFilter, number>;
  }, [cases, late]);

  const immobilise = dash
    ? dash.immobilise.consignesClient.amount + dash.immobilise.consignesFournisseur.amount + dash.garanties.amount
    : 0;
  const lateTotal = dash ? dash.late.supplierNoAnswer + dash.late.sla + dash.late.returnsDeadline + dash.late.coresDeadline : 0;
  const queued = messages.filter((m) => m.status === "A_ENVOYER" && m.kind);

  const cancelMessage = async (id: string) => {
    try {
      await cancelQueuedMessage(createClient(), id);
      setNotice("Message retiré de la file.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            Après-<span className="nc-title-accent">vente</span>
          </h1>
          <p className="rl-subtitle">Tout ce qui arrive à une pièce après qu&apos;elle a été vendue : garanties, litiges, argent qui dort, retards.</p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" /> Actualiser
          </button>
          <Link href="/dashboard/vehicules" className="od-btn od-btn--outline">
            <CarFront className="h-4 w-4" /> Retrouver une vente
          </Link>
          <button type="button" className="od-btn od-btn--primary" onClick={() => setPreset({ type: "LITIGE" })} disabled={unavailable}>
            <Plus className="h-4 w-4" /> Dossier sans vente
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      {unavailable && (
        <p className="sav-hint">
          Le module après-vente attend ses deux migrations (20260920010000 et 20260920020000). Lancez « npx supabase db push » puis actualisez.
        </p>
      )}
      <Toast message={notice} onClose={() => setNotice(null)} />

      {/* Les quatre chiffres du haut d'écran — chacun mène à la liste concernée. */}
      <div className="sav-kpis">
        <button type="button" className="sav-kpi sav-kpi--orange" onClick={() => { setTab("dossiers"); setFilter("ATTENTE_AVOIR"); }}>
          <span className="sav-kpi-icon"><Wallet className="h-5 w-5" /></span>
          <span className="sav-kpi-label">Argent immobilisé en SAV</span>
          <span className="sav-kpi-value">{fmtMoney(immobilise)}</span>
          <span className="sav-kpi-sub">
            {dash
              ? `${fmtMoney(dash.immobilise.consignesClient.amount)} de consignes · ${fmtMoney(dash.garanties.amount)} de garanties en attente d'avoir`
              : "—"}
          </span>
          {dash && dash.immobilise.atRisk.count > 0 && (
            <span className="sav-kpi-alert">
              dont {fmtMoney(dash.immobilise.atRisk.amount)} dont le délai fournisseur expire sous 15 jours
            </span>
          )}
        </button>

        <button type="button" className="sav-kpi sav-kpi--red" onClick={() => { setTab("dossiers"); setFilter("RETARD"); }}>
          <span className="sav-kpi-icon"><AlarmClock className="h-5 w-5" /></span>
          <span className="sav-kpi-label">Dossiers en retard</span>
          <span className="sav-kpi-value">{lateTotal}</span>
          <span className="sav-kpi-sub">
            {dash
              ? `${dash.late.supplierNoAnswer} garantie(s) sans réponse · ${dash.late.returnsDeadline + dash.late.coresDeadline} retour(s) hors délai fournisseur · ${dash.late.sla} litige(s) hors délai`
              : "—"}
          </span>
        </button>

        <Link className="sav-kpi sav-kpi--amber" href="/dashboard/commandes?tab=apreparer">
          <span className="sav-kpi-icon"><Hourglass className="h-5 w-5" /></span>
          <span className="sav-kpi-label">Pièces en attente de retrait</span>
          <span className="sav-kpi-value">{dash ? fmtMoney(dash.pickup.value) : "—"}</span>
          <span className="sav-kpi-sub">
            {dash ? `${dash.pickup.count} commande(s) sur l'étagère · la plus ancienne depuis ${dash.pickup.oldestDays} j` : "—"}
          </span>
          {dash && dash.pickup.over15 > 0 && <span className="sav-kpi-alert">{dash.pickup.over15} depuis plus de 15 jours : stock mort déguisé</span>}
        </Link>

        <button type="button" className="sav-kpi sav-kpi--blue" onClick={() => { setTab("dossiers"); setFilter("CLOS"); }}>
          <span className="sav-kpi-icon"><TimerReset className="h-5 w-5" /></span>
          <span className="sav-kpi-label">Délai moyen de traitement</span>
          <span className="sav-kpi-value">{dash?.delay.avgDays != null ? `${dash.delay.avgDays.toLocaleString("fr-FR")} j` : "—"}</span>
          <span className="sav-kpi-sub">
            {dash
              ? `${dash.delay.closed} dossier(s) clos sur 6 mois${dash.delay.firstResponseHours != null ? ` · 1ʳᵉ réponse aux garages en ${dash.delay.firstResponseHours.toLocaleString("fr-FR")} h` : ""}`
              : "du signalement à la résolution"}
          </span>
        </button>
      </div>

      {dash && (
        <div className="sav-strip">
          <Link href="/dashboard/consignes" className="sav-strip-item">
            <strong>{dash.immobilise.consignesClient.count}</strong> consigne(s) à récupérer
            {dash.immobilise.clientLate.count > 0 && <em> · {dash.immobilise.clientLate.count} hors délai</em>}
          </Link>
          <Link href="/dashboard/consignes" className="sav-strip-item">
            <strong>{dash.immobilise.consignesFournisseur.count}</strong> cœur(s) à renvoyer au fournisseur
          </Link>
          <Link href="/dashboard/avoirs" className="sav-strip-item">
            <strong>{fmtMoney(dash.credits.dormantAmount)}</strong> d&apos;avoirs dormants ({dash.credits.dormantCount})
          </Link>
          <span className="sav-strip-item">
            Satisfaction 6 mois : <strong>{dash.satisfaction.yes}</strong> oui · <strong>{dash.satisfaction.no}</strong> non sur {dash.satisfaction.sent} envoi(s)
          </span>
        </div>
      )}

      <div className="rc-tabs">
        {(
          [
            { id: "dossiers", label: "Dossiers", sub: "Garanties et litiges", icon: ClipboardList, count: counts.OUVERTS },
            { id: "analyses", label: "Analyses", sub: "Ce qui sert à négocier", icon: ChartColumn, count: undefined },
            { id: "messages", label: "Messages clients", sub: "Ce qui a été envoyé", icon: MessageSquareText, count: queued.length },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`rc-tab${t.id === tab ? " rc-tab--active" : ""}`}>
              <span className="rc-tab-icon"><Icon className="h-5 w-5" /></span>
              <span className="rc-tab-text">
                <span className="rc-tab-label">
                  {t.label}
                  {t.count !== undefined && <span className={`rc-tab-count${t.count > 0 ? " rc-tab-count--violet" : ""}`}>{t.count}</span>}
                </span>
                <span className="rc-tab-sub">{t.sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      {tab === "dossiers" && (
        <section className="od-card rl-table-card">
          <div className="sav-toolbar">
            <div className="lp-reasons" role="radiogroup" aria-label="Filtrer les dossiers">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={filter === f.id}
                  className={`nc-chip${filter === f.id ? " nc-chip--on" : ""}`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label} · {counts[f.id]}
                </button>
              ))}
            </div>
            <label className="sav-filter-search">
              <Search className="h-4 w-4" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Réf, client, pièce, plaque, n° dossier fournisseur…" />
            </label>
          </div>
          <div className="rl-table-wrap">
            <table className="rl-table sav-table">
              <thead>
                <tr>
                  <th>Dossier</th>
                  <th>Ouvert le</th>
                  <th>Client</th>
                  <th>Pièce</th>
                  <th>Côté client</th>
                  <th>Côté fournisseur</th>
                  <th className="av-th-right">Valeur</th>
                  <th>Alerte</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const alert = late.get(c.id);
                  return (
                    <tr key={c.id} className="sav-row" onClick={() => router.push(`/dashboard/sav/${c.id}`)}>
                      <td>
                        <Link className="sav-link" href={`/dashboard/sav/${c.id}`} onClick={(e) => e.stopPropagation()}>
                          {c.ref}
                        </Link>
                        <p className="sav-sub">
                          <span className={`rt-badge rt-badge--${c.type === "GARANTIE" ? "violet" : "amber"}`}>{CASE_TYPE_LABEL[c.type] ?? c.type}</span>
                        </p>
                      </td>
                      <td className="rl-muted-strong">{fmtDate(c.openedAt)}</td>
                      <td>
                        <p className="rl-client">{c.clientName}</p>
                        <p className="sav-sub">{c.origin === "GARAGE" ? "Ouvert par le garage" : c.immatriculation ?? ""}</p>
                      </td>
                      <td>
                        <p className="rl-client">{c.designation}</p>
                        <p className="sav-sub">
                          {[c.reference, c.marque, familyLabel(c.famille)].filter(Boolean).join(" · ")}
                        </p>
                      </td>
                      <td>
                        <span className={`rt-badge rt-badge--${clientStatusTone(c.clientStatus)}`}>{CLIENT_STATUS_LABEL[c.clientStatus] ?? c.clientStatus}</span>
                        {c.replacementGiven && <p className="sav-sub">Dépanné</p>}
                      </td>
                      <td>
                        {c.supplierStatus ? (
                          <>
                            <span className={`rt-badge rt-badge--${supplierStatusTone(c.supplierStatus)}`}>
                              {SUPPLIER_STATUS_LABEL[c.supplierStatus] ?? c.supplierStatus}
                            </span>
                            <p className="sav-sub">
                              {c.supplierName ?? "Fournisseur à préciser"}
                              {c.supplierCaseNumber ? ` · n° ${c.supplierCaseNumber}` : ""}
                            </p>
                          </>
                        ) : (
                          <span className="sav-sub">—</span>
                        )}
                      </td>
                      <td className="av-th-right">
                        {c.type === "LITIGE" && c.laborAmount > 0 ? fmtMoney(c.laborAmount) : c.partValue != null ? fmtMoney(c.partValue) : "—"}
                      </td>
                      <td>{alert ? <span className="rt-badge rt-badge--red">{alert}</span> : <span className="sav-sub">—</span>}</td>
                    </tr>
                  );
                })}
                {!loading && visible.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-muted">
                      {cases.length === 0
                        ? "Aucun dossier. Ouvrez-en un depuis « Retrouver une vente », une fiche commande ou un retour."
                        : "Aucun dossier dans ce filtre."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "analyses" && !dash && <p className="text-muted">Chargement des analyses…</p>}
      {tab === "analyses" && dash && (
        <div className="sav-analyses">
          <section className="od-card sav-panel sav-panel--cost">
            <h2 className="sav-panel-title"><LifeBuoy className="h-4 w-4" /> Coût du SAV rapporté au chiffre d&apos;affaires (12 mois)</h2>
            <p className="sav-cost">
              <strong>{dash.cost.pct != null ? `${dash.cost.pct.toLocaleString("fr-FR")} %` : "—"}</strong>
              <span>
                {fmtMoney(dash.cost.total)} sur {fmtMoney(dash.cost.ca)} de ventes
              </span>
            </p>
            <ul className="sav-cost-list">
              <li><span>Gestes commerciaux (enveloppe magasin)</span><strong>{fmtMoney(dash.cost.gestures)}</strong></li>
              <li><span>Garanties honorées sans avoir fournisseur</span><strong>{fmtMoney(dash.cost.uncoveredWarranty)}</strong></li>
              <li><span>Consignes perdues (cœur refusé)</span><strong>{fmtMoney(dash.cost.lostCores)}</strong></li>
            </ul>
          </section>

          <section className="od-card sav-panel">
            <h2 className="sav-panel-title">Taux de retour par fournisseur (6 mois)</h2>
            <p className="sav-sub">Retours + garanties rapportés aux lignes vendues — l&apos;argument de la négociation annuelle.</p>
            <table className="sav-mini">
              <tbody>
                {dash.returnRateBySupplier.slice(0, 10).map((r) => (
                  <tr key={r.supplier}>
                    <td>{r.supplier}</td>
                    <td><Bar value={r.rate ?? 0} max={Math.max(...dash.returnRateBySupplier.map((x) => x.rate ?? 0), 1)} tone="danger" /></td>
                    <td className="av-th-right"><strong>{(r.rate ?? 0).toLocaleString("fr-FR")} %</strong></td>
                    <td className="sav-sub av-th-right">{r.returns} ret. · {r.warranties} gar. / {r.lines}</td>
                  </tr>
                ))}
                {dash.returnRateBySupplier.length === 0 && <tr><td className="text-muted">Pas encore de ventes avec fournisseur sur la période.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="od-card sav-panel">
            <h2 className="sav-panel-title">Taux de garantie par famille (12 mois)</h2>
            <p className="sav-sub">Identifie les références à arrêter de vendre.</p>
            <table className="sav-mini">
              <tbody>
                {dash.warrantyByFamille.map((r) => (
                  <tr key={r.famille}>
                    <td>{familyLabel(r.famille)}</td>
                    <td><Bar value={r.rate ?? 0} max={Math.max(...dash.warrantyByFamille.map((x) => x.rate ?? 0), 1)} tone="warning" /></td>
                    <td className="av-th-right"><strong>{(r.rate ?? 0).toLocaleString("fr-FR")} %</strong></td>
                    <td className="sav-sub av-th-right">{r.cases} / {r.lines}</td>
                  </tr>
                ))}
                {dash.warrantyByFamille.length === 0 && <tr><td className="text-muted">Aucun dossier garantie sur la période.</td></tr>}
              </tbody>
            </table>
            {dash.warrantyByMarque.length > 0 && (
              <>
                <h3 className="sav-panel-subtitle">Par marque</h3>
                <table className="sav-mini">
                  <tbody>
                    {dash.warrantyByMarque.slice(0, 8).map((r) => (
                      <tr key={r.marque}>
                        <td>{r.marque}</td>
                        <td className="av-th-right"><strong>{r.cases}</strong> dossier(s)</td>
                        <td className="sav-sub av-th-right">{fmtMoney(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>

          <section className="od-card sav-panel">
            <h2 className="sav-panel-title">Délai de réponse des fournisseurs</h2>
            <p className="sav-sub">De la déclaration à la décision, sur les dossiers garantie.</p>
            <table className="sav-mini">
              <tbody>
                {dash.supplierResponse.map((r) => (
                  <tr key={r.supplier}>
                    <td>{r.supplier}</td>
                    <td><Bar value={r.avgDays ?? 0} max={Math.max(...dash.supplierResponse.map((x) => x.avgDays ?? 0), 1)} /></td>
                    <td className="av-th-right"><strong>{r.avgDays != null ? `${r.avgDays.toLocaleString("fr-FR")} j` : "—"}</strong></td>
                    <td className="sav-sub av-th-right">{r.answered} réponse(s) · {r.pending} en attente</td>
                  </tr>
                ))}
                {dash.supplierResponse.length === 0 && <tr><td className="text-muted">Aucun dossier déclaré à un fournisseur pour l&apos;instant.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="od-card sav-panel">
            <h2 className="sav-panel-title">Motifs de retour (6 mois)</h2>
            <table className="sav-mini">
              <tbody>
                {dash.motifs.map((r) => (
                  <tr key={r.motifCode}>
                    <td>{motifLabel(r.motifCode)}</td>
                    <td><Bar value={r.count} max={Math.max(...dash.motifs.map((x) => x.count), 1)} /></td>
                    <td className="av-th-right"><strong>{r.count}</strong></td>
                    <td className="sav-sub av-th-right">{fmtMoney(r.amount)}</td>
                  </tr>
                ))}
                {dash.motifs.length === 0 && <tr><td className="text-muted">Aucun retour sur la période.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="od-card sav-panel">
            <h2 className="sav-panel-title">Erreurs de référence par vendeur (6 mois)</h2>
            <p className="sav-sub">Pour repérer un besoin de formation — pas pour sanctionner.</p>
            <table className="sav-mini">
              <tbody>
                {dash.motifsByVendeur.map((r) => (
                  <tr key={r.vendeur}>
                    <td>{r.vendeur}</td>
                    <td className="av-th-right"><strong>{r.erreursReference}</strong> erreur(s) de référence</td>
                    <td className="sav-sub av-th-right">{r.returns} retour(s) · {r.sales} vente(s)</td>
                  </tr>
                ))}
                {dash.motifsByVendeur.length === 0 && <tr><td className="text-muted">Aucun retour sur la période.</td></tr>}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {tab === "messages" && (
        <section className="od-card rl-table-card">
          <div className="rl-table-wrap">
            <table className="rl-table sav-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Message</th>
                  <th>Client</th>
                  <th>Canal</th>
                  <th>État</th>
                  <th aria-label="Action" />
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id}>
                    <td className="rl-muted-strong">{fmtDateTime(m.sentAt ?? m.scheduledFor ?? m.createdAt)}</td>
                    <td>
                      <p className="rl-client">{m.kind ? QUEUED_SMS_LABEL[m.kind as QueuedSmsKind] ?? m.kind : "Commande prête"}</p>
                      <p className="sav-sub sav-message">{m.message ?? "Texte construit à l'envoi, d'après vos modèles."}</p>
                    </td>
                    <td>
                      <p className="rl-client">{m.clientName ?? "Client comptoir"}</p>
                      <p className="sav-sub">
                        {m.phone}
                        {m.orderId && m.orderRef ? (
                          <>
                            {" · "}
                            <Link className="sav-link" href={`/dashboard/commandes/${m.orderId}`}>{m.orderRef}</Link>
                          </>
                        ) : null}
                      </p>
                    </td>
                    <td>{m.channel === "WHATSAPP" ? "WhatsApp" : "SMS"}</td>
                    <td>
                      {m.status === "ENVOYE" ? (
                        <span className={`rt-badge rt-badge--${m.simulated ? "gray" : "green"}`}>{m.simulated ? "Simulé" : "Envoyé"}</span>
                      ) : m.status === "A_ENVOYER" ? (
                        <span className="rt-badge rt-badge--amber">En file · {fmtDateTime(m.scheduledFor)}</span>
                      ) : (
                        <span className="rt-badge rt-badge--red" title={m.error ?? ""}>
                          {m.error?.startsWith("OBSOLETE") ? "Devenu inutile" : m.error === "CANCELLED" ? "Annulé" : m.error === "OPT_OUT" ? "Client désinscrit" : "Échec"}
                        </span>
                      )}
                    </td>
                    <td className="od-td-right">
                      {m.status === "A_ENVOYER" && m.kind && (
                        <button type="button" className="od-btn od-btn--ghost" onClick={() => void cancelMessage(m.id)}>
                          <Ban className="h-4 w-4" /> Annuler
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!loading && messages.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-muted">
                      Aucun message. Activez les automatismes dans Paramètres → Après-vente.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <OpenCaseDialog preset={preset} onClose={() => setPreset(null)} onCreated={(id) => router.push(`/dashboard/sav/${id}`)} />
    </div>
  );
}
