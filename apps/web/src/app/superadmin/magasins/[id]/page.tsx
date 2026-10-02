"use client";

import { ArrowLeft, Ban, Bug, Building2, Check, ChevronDown, ChevronRight, Copy, Download, KeyRound, Loader2, RefreshCw, ScrollText, ShieldCheck, Unlock, Users, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { Toast } from "@/components/ui/Toast";
import { generatePassword } from "@/lib/data/admin";
import { homeSpace } from "@/lib/spaces";
import { ACTION, ENTITY_LABEL, activitySummary, type Activity } from "@/lib/superadmin-journal";

/**
 * One magasin as the SaaS owner manages it: subscription and seats, every
 * login (password, block), the volumes, and what the magasin did — the trail of
 * who created, changed or deleted what, its last orders, payments and returns.
 */

type Account = {
  userId: string;
  name: string;
  kind: string;
  linkedTo: string | null;
  email: string | null;
  lastSignIn: string | null;
  createdAt: string | null;
  blocked: boolean;
};

type Detail = {
  org: {
    id: string;
    name: string;
    plan: string;
    status: string;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    seatLimit: number;
    createdAt: string;
    phone: string | null;
    address: string | null;
    city: string | null;
    stripe: boolean;
  };
  accounts: Account[];
  stats: {
    orders: number;
    devis: number;
    clients: number;
    invoices: number;
    returns: number;
    savCases: number;
    stockItems: number;
    suppliers: number;
    orders30: number;
    ca30: number;
    collected30: number;
    refunded30: number;
    openBalance: number;
    errors7: number | null;
  };
  recentOrders: { id: string; ref: string; at: string; total: number; balance: number; payment: string; workflow: string; kind: string; client: string | null; by: string | null }[];
  recentPayments: { id: string; at: string; kind: string; mode: string; amount: number; note: string | null; by: string | null }[];
  recentReturns: { id: string; ref: string; at: string; designation: string | null; treatment: string; amount: number }[];
};

type View = "activity" | "orders" | "payments" | "returns";

const BLOCKED = new Set(["past_due", "unpaid", "canceled", "cancelled", "incomplete_expired", "expired"]);
const PLANS: { code: string; label: string }[] = [
  { code: "TRIAL", label: "Essai" },
  { code: "STARTER", label: "Starter" },
  { code: "PRO", label: "Pro" },
  { code: "ENTERPRISE", label: "Enterprise" },
];
const KIND: Record<string, { label: string; cls: string }> = {
  ADMIN: { label: "Admin", cls: "violet" },
  CAISSIER: { label: "Caissier", cls: "blue" },
  GARAGE: { label: "Garage", cls: "amber" },
  LIVREUR: { label: "Livreur", cls: "green" },
};
const PAYMENT_KIND: Record<string, string> = { ENCAISSEMENT: "Encaissement", REGLEMENT_COMPTE: "Règlement de compte", REMBOURSEMENT: "Remboursement" };
const PAYMENT_MODE: Record<string, string> = { ESPECES: "Espèces", CARTE: "Carte", VIREMENT: "Virement", CHEQUE: "Chèque" };
const TREATMENT: Record<string, string> = { A_TRAITER: "À traiter", DEMANDE_ENVOYEE: "Demande envoyée", A_RECUPERER: "À récupérer", ACCEPTE: "Accepté", REFUSE: "Refusé", REMBOURSE: "Remboursé", AVOIR: "Avoir émis" };

function statusCode(status: string): "active" | "trialing" | "canceled" {
  const s = status.toLowerCase();
  if (BLOCKED.has(s)) return "canceled";
  return s === "trialing" || s === "trial" ? "trialing" : "active";
}

function eur(v: number): string {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function frDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

function frDateTime(v: string | null): string {
  if (!v) return "jamais";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

async function call<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
  return json;
}

export default function MagasinPage() {
  const { id } = useParams<{ id: string }>();
  const { user, profile, ready } = useAuth();
  const router = useRouter();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [actors, setActors] = useState<Record<string, string>>({});
  const [days, setDays] = useState(7);
  const [actor, setActor] = useState("");
  const [view, setView] = useState<View>("activity");
  const [open, setOpen] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Subscription form
  const [form, setForm] = useState({ name: "", plan: "TRIAL", status: "active", trialEndsAt: "", seatLimit: "3" });
  // Password modal
  const [reset, setReset] = useState<Account | null>(null);
  const [resetPwd, setResetPwd] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, a] = await Promise.all([
        call<Detail>(`/api/superadmin/magasins/${id}`),
        call<{ activity: Activity[]; actors: Record<string, string> }>(`/api/superadmin/journal?tab=activity&org=${id}&days=${days}`),
      ]);
      setDetail(d);
      setActivity(a.activity ?? []);
      setActors(a.actors ?? {});
      setForm({
        name: d.org.name,
        plan: d.org.plan,
        status: statusCode(d.org.status),
        trialEndsAt: d.org.trialEndsAt ? d.org.trialEndsAt.slice(0, 10) : "",
        seatLimit: String(d.org.seatLimit),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [id, days]);

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/superadmin/login");
      return;
    }
    // A magasin account doesn't belong here — go home.
    if (profile) {
      router.replace(homeSpace(profile, user.email));
      return;
    }
    void load();
  }, [ready, user, profile, router, load]);

  const run = async (key: string, body: Record<string, unknown>, ok: string) => {
    setBusy(key);
    setError(null);
    try {
      await call("/api/superadmin", body);
      setNotice(ok);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const staffSeats = useMemo(() => (detail?.accounts ?? []).filter((a) => a.kind === "ADMIN" || a.kind === "CAISSIER").length, [detail]);
  const shownActivity = useMemo(() => (actor ? activity.filter((a) => a.actor_id === actor) : activity), [activity, actor]);

  if (!ready) return null;

  const org = detail?.org ?? null;
  const st = org ? statusCode(org.status) : "active";
  const trialOver = st === "trialing" && org?.trialEndsAt ? new Date(org.trialEndsAt).getTime() < Date.now() : false;
  const badge = st === "canceled" ? { label: "Suspendu", cls: "red" } : st === "trialing" ? (trialOver ? { label: "Essai expiré", cls: "red" } : { label: "Essai", cls: "amber" }) : { label: "Actif", cls: "green" };
  const exportUrl = (format: "csv" | "json") => `/api/superadmin/journal?tab=activity&org=${id}&days=${days}${actor ? `&actor=${actor}` : ""}&format=${format}`;

  const saveSubscription = () =>
    run(
      "save",
      {
        action: "update_org",
        orgId: id,
        name: form.name,
        plan: form.plan,
        status: form.status,
        seatLimit: Number(form.seatLimit),
        trialEndsAt: form.status === "trialing" ? form.trialEndsAt || null : undefined,
      },
      "Abonnement enregistré.",
    );

  return (
    <div className="sa-page">
      <header className="sa-header">
        <span className="sa-brand"><Building2 className="h-5 w-5" /></span>
        <div className="sa-header-text">
          <p className="sa-title">{org?.name ?? "Magasin"}</p>
          <p className="sa-sub">
            {org ? `Créé le ${frDate(org.createdAt)}${org.city ? ` · ${org.city}` : ""}${org.phone ? ` · ${org.phone}` : ""}${org.stripe ? " · abonné via Stripe" : ""}` : "Chargement…"}
          </p>
        </div>
        {org && <span className={`rt-badge rt-badge--${badge.cls}`}>{badge.label}</span>}
        <Link href="/superadmin" className="od-btn od-btn--ghost">
          <ArrowLeft className="h-4 w-4" /> Console
        </Link>
        <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading} title="Actualiser">
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} duration={10000} />

      {!detail ? (
        loading ? <TableSkeleton rows={6} cols={5} /> : null
      ) : (
        <>
          <div className="ga-stats sm-stats">
            <div className="ga-stat"><div><p className="ga-stat-value">{detail.stats.orders}</p><p className="ga-stat-label">Commandes · {detail.stats.orders30} sur 30 j</p></div></div>
            <div className="ga-stat"><div><p className="ga-stat-value">{eur(detail.stats.ca30)}</p><p className="ga-stat-label">CA · 30 jours</p></div></div>
            <div className="ga-stat"><div><p className="ga-stat-value">{eur(detail.stats.collected30)}</p><p className="ga-stat-label">Encaissé · 30 jours{detail.stats.refunded30 > 0 ? ` (− ${eur(detail.stats.refunded30)} remboursés)` : ""}</p></div></div>
            <div className="ga-stat"><div><p className="ga-stat-value">{eur(detail.stats.openBalance)}</p><p className="ga-stat-label">Reste dû par les clients</p></div></div>
            <div className="ga-stat"><div><p className="ga-stat-value">{detail.stats.clients}</p><p className="ga-stat-label">Clients · {detail.stats.suppliers} fournisseurs</p></div></div>
            <div className="ga-stat"><div><p className="ga-stat-value">{detail.stats.invoices}</p><p className="ga-stat-label">Factures · {detail.stats.devis} devis</p></div></div>
            <div className="ga-stat"><div><p className="ga-stat-value">{detail.stats.returns}</p><p className="ga-stat-label">Retours · {detail.stats.savCases} dossiers SAV</p></div></div>
            <Link href={`/superadmin/journal?org=${id}&days=7`} className="ga-stat sm-stat-link" title="Ouvrir le journal des erreurs de ce magasin">
              <span className="ga-stat-icon" style={{ background: "#FFE7F2", color: "#B3093C" }}><Bug className="h-5 w-5" /></span>
              <div><p className="ga-stat-value">{detail.stats.errors7 ?? "—"}</p><p className="ga-stat-label">Erreurs · 7 jours — ouvrir le journal</p></div>
            </Link>
          </div>

          <div className="sm-cols">
            <section className="od-card sm-card">
              <h2 className="od-card-title"><ShieldCheck className="h-4 w-4" /> Abonnement et accès</h2>
              <div className="sm-form">
                <label className="od-field sm-wide">
                  <span className="od-label">Nom du magasin</span>
                  <input className="od-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                </label>
                <label className="od-field">
                  <span className="od-label">Plan</span>
                  <select className="od-input" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                    {PLANS.map((p) => (
                      <option key={p.code} value={p.code}>{p.label}</option>
                    ))}
                    {!PLANS.some((p) => p.code === form.plan) && <option value={form.plan}>{form.plan}</option>}
                  </select>
                </label>
                <label className="od-field">
                  <span className="od-label">Statut</span>
                  <select className="od-input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option value="active">Actif — accès sans limite de date</option>
                    <option value="trialing">Essai — accès jusqu&apos;à la date de fin</option>
                    <option value="canceled">Suspendu — toute l&apos;équipe est bloquée</option>
                  </select>
                </label>
                <label className="od-field">
                  <span className="od-label">Fin de l&apos;essai</span>
                  <input className="od-input" type="date" value={form.trialEndsAt} disabled={form.status !== "trialing"} onChange={(e) => setForm({ ...form, trialEndsAt: e.target.value })} />
                </label>
                <label className="od-field">
                  <span className="od-label">Accès comptoir autorisés</span>
                  <input className="od-input" type="number" min={1} max={1000} value={form.seatLimit} onChange={(e) => setForm({ ...form, seatLimit: e.target.value })} />
                  <span className="st-cmd-hint">{staffSeats} utilisés (admins et caissiers ; garages et livreurs ne comptent pas)</span>
                </label>
              </div>
              <div className="sm-form-foot">
                {form.status === "canceled" && st !== "canceled" && <span className="sm-warn">Suspendre bloque immédiatement tout le magasin.</span>}
                <button type="button" className="od-btn od-btn--primary" disabled={busy !== null || !form.name.trim() || (form.status === "trialing" && !form.trialEndsAt)} onClick={() => void saveSubscription()}>
                  {busy === "save" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Enregistrer
                </button>
              </div>
            </section>

            <section className="od-card sm-card">
              <h2 className="od-card-title"><Users className="h-4 w-4" /> Comptes ({detail.accounts.length})</h2>
              <div className="rl-table-wrap">
                <table className="stk-table sj-table">
                  <thead>
                    <tr><th>Compte</th><th>Type</th><th>Dernière connexion</th><th /></tr>
                  </thead>
                  <tbody>
                    {detail.accounts.map((a) => (
                      <tr key={a.userId}>
                        <td>
                          <strong>{a.name}</strong>
                          <span className="sj-sub">{a.email ?? "—"}{a.linkedTo && a.linkedTo !== a.name ? ` · ${a.linkedTo}` : ""}</span>
                        </td>
                        <td>
                          <span className={`rt-badge rt-badge--${KIND[a.kind]?.cls ?? "blue"}`}>{KIND[a.kind]?.label ?? a.kind}</span>
                          {a.blocked && <span className="rt-badge rt-badge--red sm-gap">Bloqué</span>}
                        </td>
                        <td className="rl-muted-strong">{frDateTime(a.lastSignIn)}</td>
                        <td>
                          <div className="rt-acts">
                            <button type="button" className="rc-act rc-act--quiet" onClick={() => { setReset(a); setResetPwd(generatePassword()); }}>
                              <KeyRound className="h-3.5 w-3.5" /> Mot de passe
                            </button>
                            <button
                              type="button"
                              className={`rc-act ${a.blocked ? "rc-act--recu" : "rc-act--nonrecu"}`}
                              disabled={busy !== null}
                              onClick={() => {
                                if (!a.blocked && !window.confirm(`Bloquer ${a.name} ? Ce compte ne pourra plus se connecter (une session ouverte s'arrête sous une heure).`)) return;
                                void run(`blk-${a.userId}`, { action: "set_account_blocked", userId: a.userId, blocked: !a.blocked }, a.blocked ? `${a.name} débloqué.` : `${a.name} bloqué.`);
                              }}
                            >
                              {busy === `blk-${a.userId}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : a.blocked ? <Unlock className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                              {a.blocked ? "Débloquer" : "Bloquer"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {detail.accounts.length === 0 && <tr><td colSpan={4} className="stk-empty">Aucun compte.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="od-card sj-card">
            <div className="sm-head">
              <h2 className="od-card-title"><ScrollText className="h-4 w-4" /> Ce que le magasin a fait</h2>
              <div className="sj-tabs sm-tabs" role="tablist">
                {([
                  ["activity", "Toutes les actions"],
                  ["orders", "Dernières commandes"],
                  ["payments", "Règlements"],
                  ["returns", "Retours"],
                ] as [View, string][]).map(([key, label]) => (
                  <button key={key} type="button" role="tab" aria-selected={view === key} className={`sj-tab${view === key ? " sj-tab--on" : ""}`} onClick={() => { setView(key); setOpen(null); }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {view === "activity" && (
              <>
                <div className="sj-filters sm-filters">
                  <select className="od-input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Période">
                    <option value={1}>24 heures</option>
                    <option value={7}>7 jours</option>
                    <option value={30}>30 jours</option>
                    <option value={90}>90 jours</option>
                  </select>
                  <select className="od-input" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Utilisateur">
                    <option value="">Tous les utilisateurs</option>
                    {Object.entries(actors).map(([uid, label]) => (
                      <option key={uid} value={uid}>{label}</option>
                    ))}
                  </select>
                  <span className="sm-spacer" />
                  <a className="od-btn od-btn--ghost" href={exportUrl("csv")} download>
                    <Download className="h-4 w-4" /> Excel (CSV)
                  </a>
                  <a className="od-btn od-btn--ghost" href={exportUrl("json")} download>
                    <Download className="h-4 w-4" /> JSON
                  </a>
                </div>
                <div className="rl-table-wrap">
                  <table className="stk-table sj-table">
                    <thead>
                      <tr><th>Quand</th><th>Qui</th><th>Action</th><th>Objet</th><th>Détail</th></tr>
                    </thead>
                    <tbody>
                      {shownActivity.map((a) => {
                        const expanded = open === a.id;
                        const act = ACTION[a.action] ?? { label: a.action, cls: "blue" };
                        return (
                          <Fragment key={a.id}>
                            <tr className={`sj-row${expanded ? " sj-row--open" : ""}`} onClick={() => setOpen(expanded ? null : a.id)} aria-expanded={expanded}>
                              <td className="rl-muted-strong">
                                <span className="sj-chev">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
                                {frDateTime(a.created_at)}
                              </td>
                              <td className="rl-muted-strong">{a.actor_id ? actors[a.actor_id] ?? "Compte supprimé" : "Système"}</td>
                              <td><span className={`rt-badge rt-badge--${act.cls}`}>{act.label}</span></td>
                              <td>{ENTITY_LABEL[a.entity] ?? a.entity}</td>
                              <td className="sj-summary">{activitySummary(a)}</td>
                            </tr>
                            {expanded && (
                              <tr className="sj-detail-row">
                                <td colSpan={5}>
                                  <div className="sj-detail sj-detail--split">
                                    {a.before && (
                                      <div>
                                        <p className="sj-label">Avant</p>
                                        <pre className="sj-pre">{JSON.stringify(a.before, null, 2)}</pre>
                                      </div>
                                    )}
                                    {a.after && (
                                      <div>
                                        <p className="sj-label">{a.action === "UPDATE" ? "Après (champs modifiés)" : "Valeurs"}</p>
                                        <pre className="sj-pre">{JSON.stringify(a.after, null, 2)}</pre>
                                      </div>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                      {!loading && shownActivity.length === 0 && <tr><td colSpan={5} className="stk-empty">Aucune action sur la période.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {activity.length >= 300 && <p className="sj-sub sj-foot">Les 300 dernières actions sont affichées : l&apos;export contient jusqu&apos;à 5 000 lignes.</p>}
              </>
            )}

            {view === "orders" && (
              <div className="rl-table-wrap">
                <table className="stk-table sj-table">
                  <thead>
                    <tr><th>Quand</th><th>Référence</th><th>Type</th><th>Client</th><th>Saisie par</th><th className="stk-th-center">Total</th><th className="stk-th-center">Reste dû</th><th>Étape</th></tr>
                  </thead>
                  <tbody>
                    {detail.recentOrders.map((o) => (
                      <tr key={o.id}>
                        <td className="rl-muted-strong">{frDateTime(o.at)}</td>
                        <td><strong>{o.ref}</strong></td>
                        <td><span className={`rt-badge rt-badge--${o.kind === "COMMANDE" ? "blue" : o.kind === "ANNULÉE" ? "red" : "amber"}`}>{o.kind}</span></td>
                        <td>{o.client ?? "Client comptoir"}</td>
                        <td className="rl-muted-strong">{o.by ?? "—"}</td>
                        <td className="stk-td-center">{eur(o.total)}</td>
                        <td className="stk-td-center">{o.balance > 0 ? eur(o.balance) : "—"}</td>
                        <td className="rl-muted-strong">{o.workflow}</td>
                      </tr>
                    ))}
                    {detail.recentOrders.length === 0 && <tr><td colSpan={8} className="stk-empty">Aucune commande.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {view === "payments" && (
              <div className="rl-table-wrap">
                <table className="stk-table sj-table">
                  <thead>
                    <tr><th>Quand</th><th>Type</th><th>Mode</th><th>Reçu par</th><th>Note</th><th className="stk-th-center">Montant</th></tr>
                  </thead>
                  <tbody>
                    {detail.recentPayments.map((p) => (
                      <tr key={p.id}>
                        <td className="rl-muted-strong">{frDateTime(p.at)}</td>
                        <td>{PAYMENT_KIND[p.kind] ?? p.kind}</td>
                        <td><span className="rt-badge rt-badge--blue">{PAYMENT_MODE[p.mode] ?? p.mode}</span></td>
                        <td className="rl-muted-strong">{p.by ?? "—"}</td>
                        <td className="sj-summary">{p.note ?? "—"}</td>
                        <td className="stk-td-center"><strong>{p.kind === "REMBOURSEMENT" ? "− " : ""}{eur(p.amount)}</strong></td>
                      </tr>
                    ))}
                    {detail.recentPayments.length === 0 && <tr><td colSpan={6} className="stk-empty">Aucun règlement.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}

            {view === "returns" && (
              <div className="rl-table-wrap">
                <table className="stk-table sj-table">
                  <thead>
                    <tr><th>Quand</th><th>Référence</th><th>Pièce</th><th>État</th><th className="stk-th-center">Montant</th></tr>
                  </thead>
                  <tbody>
                    {detail.recentReturns.map((r) => (
                      <tr key={r.id}>
                        <td className="rl-muted-strong">{frDateTime(r.at)}</td>
                        <td><strong>{r.ref}</strong></td>
                        <td>{r.designation ?? "—"}</td>
                        <td><span className="rt-badge rt-badge--blue">{TREATMENT[r.treatment] ?? r.treatment}</span></td>
                        <td className="stk-td-center">{r.amount > 0 ? eur(r.amount) : "—"}</td>
                      </tr>
                    ))}
                    {detail.recentReturns.length === 0 && <tr><td colSpan={5} className="stk-empty">Aucun retour.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {reset && (
        <div className="ga-modal-overlay" onClick={() => setReset(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><KeyRound className="h-4 w-4" />Mot de passe — {reset.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setReset(null)} aria-label="Fermer"><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              <p className="rl-muted">{KIND[reset.kind]?.label ?? reset.kind} · {reset.email ?? "—"}</p>
              <div className="od-field">
                <span className="od-label">Nouveau mot de passe</span>
                <div className="admin-pwd">
                  <input className="od-input" value={resetPwd} onChange={(e) => setResetPwd(e.target.value)} />
                  <button type="button" className="rc-act rc-act--quiet" title="Générer" onClick={() => setResetPwd(generatePassword())}><RefreshCw className="h-3.5 w-3.5" /></button>
                  <button type="button" className="rc-act rc-act--quiet" title="Copier" onClick={() => { void navigator.clipboard?.writeText(resetPwd); setNotice("Mot de passe copié."); }}><Copy className="h-3.5 w-3.5" /></button>
                </div>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setReset(null)}>Annuler</button>
                <button
                  type="button"
                  className="od-btn od-btn--primary"
                  disabled={busy !== null || resetPwd.length < 8}
                  onClick={() => {
                    const r = reset;
                    setReset(null);
                    void run(`pwd-${r.userId}`, { action: "reset_password", userId: r.userId, password: resetPwd }, `Mot de passe de ${r.name} réinitialisé : ${resetPwd}`);
                  }}
                >
                  <Check className="h-4 w-4" /> Réinitialiser
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
