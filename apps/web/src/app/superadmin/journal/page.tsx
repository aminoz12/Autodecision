"use client";

import { ArrowLeft, Bug, Check, ChevronDown, ChevronRight, Copy, Download, History, Loader2, RefreshCw, ScrollText, Search, ShieldCheck, Trash2, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { Toast } from "@/components/ui/Toast";
import { homeSpace } from "@/lib/spaces";
import { ACTION, ENTITY_LABEL, LEVEL, SOURCE_LABEL, activitySummary, browserOf, type Activity, type AppEvent } from "@/lib/superadmin-journal";

/**
 * Journal du propriétaire du SaaS : les erreurs vues par les utilisateurs
 * (app_events, alimenté par lib/telemetry.ts) et l'activité des magasins
 * (audit_log : qui a créé, modifié ou supprimé quoi).
 */

type OrgOption = { id: string; name: string };
type Tab = "errors" | "activity";

type Payload = {
  orgs: OrgOption[];
  events?: AppEvent[];
  activity?: Activity[];
  actors?: Record<string, string>;
  missing: string | null;
};

type Group = {
  fingerprint: string;
  level: AppEvent["level"];
  source: string;
  message: string;
  count: number;
  last: string;
  users: Set<string>;
  orgs: Set<string>;
  events: AppEvent[];
};

const PERIODS: { days: number; label: string }[] = [
  { days: 1, label: "24 heures" },
  { days: 7, label: "7 jours" },
  { days: 30, label: "30 jours" },
];

function frDateTime(v: string): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ago(v: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(v).getTime()) / 1000));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

async function call<T>(url: string, method: "GET" | "DELETE" = "GET"): Promise<T> {
  const res = await fetch(url, { method });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
  return json;
}

export default function JournalPage() {
  const { user, profile, ready } = useAuth();
  const router = useRouter();

  // The page renders nothing before the session is known, so reading the address here is safe.
  const initial = () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
  const [tab, setTab] = useState<Tab>(() => (initial().get("tab") === "activity" ? "activity" : "errors"));
  const [days, setDays] = useState(() => ([1, 7, 30].includes(Number(initial().get("days"))) ? Number(initial().get("days")) : 1));
  const [org, setOrg] = useState(() => initial().get("org") ?? "");
  const [actor, setActor] = useState("");
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  const [orgs, setOrgs] = useState<OrgOption[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [actors, setActors] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  // The search box filters after a short pause, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ tab, days: String(days) });
      if (org) params.set("org", org);
      if (level && tab === "errors") params.set("level", level);
      if (q) params.set("q", q);
      const data = await call<Payload>(`/api/superadmin/journal?${params.toString()}`);
      setOrgs(data.orgs);
      setEvents(data.events ?? []);
      setActivity(data.activity ?? []);
      setActors(data.actors ?? {});
      setMissing(data.missing);
      setDenied(null);
      setNow(Date.now());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("réservé") || msg.includes("authentifié")) setDenied(msg);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, [tab, days, org, level, q]);

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
    // The journal follows the tests: refreshed every minute.
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [ready, user, profile, router, load]);

  const orgName = useMemo(() => new Map(orgs.map((o) => [o.id, o.name])), [orgs]);
  const shownActivity = useMemo(() => (actor ? activity.filter((a) => a.actor_id === actor) : activity), [activity, actor]);

  /** The file holds the whole selection (up to 5 000 lines), not only what the screen shows. */
  const exportUrl = (format: "csv" | "json") => {
    const params = new URLSearchParams({ tab, days: String(days), format });
    if (org) params.set("org", org);
    if (level && tab === "errors") params.set("level", level);
    if (actor && tab === "activity") params.set("actor", actor);
    if (q) params.set("q", q);
    return `/api/superadmin/journal?${params.toString()}`;
  };

  /** The same error raised twenty times is one line with a counter. */
  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const e of events) {
      let g = map.get(e.fingerprint);
      if (!g) {
        g = { fingerprint: e.fingerprint, level: e.level, source: e.source, message: e.message, count: 0, last: e.created_at, users: new Set(), orgs: new Set(), events: [] };
        map.set(e.fingerprint, g);
      }
      g.count += 1;
      if (e.level === "error") g.level = "error";
      if (e.user_email) g.users.add(e.user_email);
      if (e.organization_id) g.orgs.add(e.organization_id);
      g.events.push(e);
    }
    return [...map.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  }, [events]);

  const stats = useMemo(
    () => ({
      errors: events.filter((e) => e.level === "error").length,
      warnings: events.filter((e) => e.level === "warn").length,
      users: new Set(events.map((e) => e.user_email).filter(Boolean)).size,
      distinct: groups.length,
    }),
    [events, groups],
  );

  const resolve = async (g: Group) => {
    setBusy(g.fingerprint);
    try {
      await call(`/api/superadmin/journal?fingerprint=${encodeURIComponent(g.fingerprint)}`, "DELETE");
      setNotice("Problème marqué résolu : il réapparaîtra s'il se reproduit.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const clearAll = async () => {
    if (!window.confirm("Vider tout le journal des erreurs ?")) return;
    setBusy("all");
    try {
      await call("/api/superadmin/journal?all=1", "DELETE");
      setNotice("Journal des erreurs vidé.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Everything needed to hand the problem to a developer, in the clipboard. */
  const copy = async (g: Group) => {
    const e = g.events[0];
    const text = [
      `${LEVEL[g.level].label} — ${SOURCE_LABEL[g.source] ?? g.source} — ${g.count} fois, dernière ${frDateTime(g.last)}`,
      e.message,
      `Page : ${e.url ?? "—"} · Version : ${e.app_version ?? "—"} · ${browserOf(e.user_agent)}`,
      `Utilisateur : ${e.user_email ?? "non connecté"} (${e.user_role ?? "—"}) · Magasin : ${e.organization_id ? orgName.get(e.organization_id) ?? e.organization_id : "—"}`,
      e.context ? `Contexte : ${JSON.stringify(e.context, null, 2)}` : "",
      e.stack ? `Pile :\n${e.stack}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Détail copié.");
    } catch {
      setNotice("Copie impossible dans ce navigateur.");
    }
  };

  if (!ready) return null;

  if (denied) {
    return (
      <div className="sa-page">
        <div className="od-card admin-locked">
          <span className="admin-locked-icon"><ShieldCheck className="h-7 w-7" /></span>
          <h1>Console propriétaire</h1>
          <p>{denied}</p>
          <Link href="/superadmin/login" className="od-btn od-btn--primary">Se connecter</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="sa-page">
      <header className="sa-header">
        <span className="sa-brand"><ScrollText className="h-5 w-5" /></span>
        <div className="sa-header-text">
          <p className="sa-title">Journal</p>
          <p className="sa-sub">Les erreurs vues par les utilisateurs et l&apos;activité des magasins. Actualisé chaque minute.</p>
        </div>
        <Link href="/superadmin" className="od-btn od-btn--ghost">
          <ArrowLeft className="h-4 w-4" /> Console
        </Link>
        <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading} title="Actualiser">
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
      </header>

      {error && <div className="nc-error">{error}</div>}
      {missing && tab === "errors" && <div className="nc-error">{missing}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} duration={5000} />

      <div className="sj-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "errors"} className={`sj-tab${tab === "errors" ? " sj-tab--on" : ""}`} onClick={() => { setTab("errors"); setOpen(null); }}>
          <Bug className="h-4 w-4" /> Erreurs
        </button>
        <button type="button" role="tab" aria-selected={tab === "activity"} className={`sj-tab${tab === "activity" ? " sj-tab--on" : ""}`} onClick={() => { setTab("activity"); setOpen(null); setActor(""); }}>
          <History className="h-4 w-4" /> Activité
        </button>
      </div>

      <div className="sj-filters">
        <select className="od-input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Période">
          {PERIODS.map((p) => (
            <option key={p.days} value={p.days}>{p.label}</option>
          ))}
        </select>
        <select className="od-input" value={org} onChange={(e) => setOrg(e.target.value)} aria-label="Magasin">
          <option value="">Tous les magasins</option>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        {tab === "errors" && (
          <select className="od-input" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Niveau">
            <option value="">Erreurs et avertissements</option>
            <option value="error">Erreurs seulement</option>
            <option value="warn">Avertissements seulement</option>
          </select>
        )}
        <label className="sj-search">
          <Search className="h-4 w-4" />
          <input
            className="od-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tab === "errors" ? "Message, page, e-mail…" : "Objet (orders, payments…) ou identifiant"}
          />
        </label>
        {tab === "activity" && Object.keys(actors).length > 0 && (
          <select className="od-input" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Utilisateur">
            <option value="">Tous les utilisateurs</option>
            {Object.entries(actors).map(([uid, label]) => (
              <option key={uid} value={uid}>{label}</option>
            ))}
          </select>
        )}
        {(tab === "errors" ? events.length > 0 : activity.length > 0) && (
          <>
            <a className="od-btn od-btn--outline" href={exportUrl("csv")} download title="Toute la sélection, une ligne par événement, à ouvrir dans Excel">
              <Download className="h-4 w-4" /> Excel (CSV)
            </a>
            <a className="od-btn od-btn--outline" href={exportUrl("json")} download title="Le détail complet (contexte, pile d'appels), problèmes regroupés : le fichier à transmettre pour analyse">
              <Download className="h-4 w-4" /> JSON détaillé
            </a>
          </>
        )}
        {tab === "errors" && events.length > 0 && (
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void clearAll()} disabled={busy !== null}>
            <Trash2 className="h-4 w-4" /> Vider
          </button>
        )}
      </div>

      {tab === "errors" && (
        <>
          <div className="ga-stats sj-stats">
            <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FFE7F2", color: "#B3093C" }}><Bug className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.errors}</p><p className="ga-stat-label">Erreurs</p></div></div>
            <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FCEDB9", color: "#983705" }}><TriangleAlert className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.warnings}</p><p className="ga-stat-label">Avertissements</p></div></div>
            <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#635BFF" }}><ScrollText className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.distinct}</p><p className="ga-stat-label">Problèmes distincts</p></div></div>
            <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#D6ECFF", color: "#0055BC" }}><Users className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.users}</p><p className="ga-stat-label">Utilisateurs touchés</p></div></div>
          </div>

          {loading && events.length === 0 ? (
            <TableSkeleton rows={5} cols={5} />
          ) : (
            <section className="od-card sj-card">
              <div className="rl-table-wrap">
                <table className="stk-table sj-table">
                  <thead>
                    <tr><th>Problème</th><th>Type</th><th className="stk-th-center">Fois</th><th>Qui</th><th>Dernière fois</th></tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const expanded = open === g.fingerprint;
                      const latest = g.events[0];
                      return (
                        <Fragment key={g.fingerprint}>
                          <tr className={`sj-row${expanded ? " sj-row--open" : ""}`} onClick={() => setOpen(expanded ? null : g.fingerprint)} aria-expanded={expanded}>
                            <td>
                              <span className="sj-chev">{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
                              <span className={`rt-badge rt-badge--${LEVEL[g.level].cls}`}>{LEVEL[g.level].label}</span>
                              <span className="sj-message">{g.message}</span>
                            </td>
                            <td className="rl-muted-strong">{SOURCE_LABEL[g.source] ?? g.source}</td>
                            <td className="stk-td-center"><strong>{g.count}</strong></td>
                            <td className="rl-muted-strong">
                              {g.users.size === 0 ? "Non connecté" : g.users.size === 1 ? [...g.users][0] : `${g.users.size} utilisateurs`}
                              {g.orgs.size > 0 && <span className="sj-sub">{[...g.orgs].map((id) => orgName.get(id) ?? "—").join(", ")}</span>}
                            </td>
                            <td className="rl-muted-strong">{ago(g.last, now)}<span className="sj-sub">{frDateTime(g.last)}</span></td>
                          </tr>
                          {expanded && (
                            <tr className="sj-detail-row">
                              <td colSpan={5}>
                                <div className="sj-detail">
                                  <div className="sj-detail-acts">
                                    <button type="button" className="od-btn od-btn--outline" onClick={() => void copy(g)}>
                                      <Copy className="h-4 w-4" /> Copier le détail
                                    </button>
                                    <button type="button" className="od-btn od-btn--ghost" onClick={() => void resolve(g)} disabled={busy !== null}>
                                      {busy === g.fingerprint ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Résolu
                                    </button>
                                  </div>
                                  <p className="sj-full">{latest.message}</p>
                                  <table className="sj-occ">
                                    <thead>
                                      <tr><th>Quand</th><th>Utilisateur</th><th>Magasin</th><th>Page</th><th>Version</th><th>Navigateur</th></tr>
                                    </thead>
                                    <tbody>
                                      {g.events.slice(0, 8).map((e) => (
                                        <tr key={e.id}>
                                          <td>{frDateTime(e.created_at)}</td>
                                          <td>{e.user_email ?? "Non connecté"}{e.user_role ? ` · ${e.user_role}` : ""}</td>
                                          <td>{e.organization_id ? orgName.get(e.organization_id) ?? "—" : "—"}</td>
                                          <td className="sj-mono">{e.url ?? "—"}</td>
                                          <td className="sj-mono">{e.app_version ?? "—"}</td>
                                          <td>{browserOf(e.user_agent)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                  {g.events.length > 8 && <p className="sj-sub">… et {g.events.length - 8} autre(s) sur la période.</p>}
                                  {latest.context && (
                                    <>
                                      <p className="sj-label">Contexte</p>
                                      <pre className="sj-pre">{JSON.stringify(latest.context, null, 2)}</pre>
                                    </>
                                  )}
                                  {latest.stack && (
                                    <>
                                      <p className="sj-label">Pile d&apos;appels</p>
                                      <pre className="sj-pre">{latest.stack}</pre>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {!loading && groups.length === 0 && (
                      <tr><td colSpan={5} className="stk-empty">Aucune erreur sur la période.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {tab === "activity" &&
        (loading && activity.length === 0 ? (
          <TableSkeleton rows={8} cols={6} />
        ) : (
          <section className="od-card sj-card">
            <div className="rl-table-wrap">
              <table className="stk-table sj-table">
                <thead>
                  <tr><th>Quand</th><th>Magasin</th><th>Qui</th><th>Action</th><th>Objet</th><th>Détail</th></tr>
                </thead>
                <tbody>
                  {shownActivity.map((a) => {
                    const key = `a${a.id}`;
                    const expanded = open === key;
                    const act = ACTION[a.action] ?? { label: a.action, cls: "blue" };
                    return (
                      <Fragment key={a.id}>
                        <tr className={`sj-row${expanded ? " sj-row--open" : ""}`} onClick={() => setOpen(expanded ? null : key)} aria-expanded={expanded}>
                          <td className="rl-muted-strong">{frDateTime(a.created_at)}</td>
                          <td className="rl-muted-strong">{a.organization_id ? orgName.get(a.organization_id) ?? "—" : "—"}</td>
                          <td className="rl-muted-strong">{a.actor_id ? actors[a.actor_id] ?? "Compte supprimé" : "Système"}</td>
                          <td><span className={`rt-badge rt-badge--${act.cls}`}>{act.label}</span></td>
                          <td>{ENTITY_LABEL[a.entity] ?? a.entity}</td>
                          <td className="sj-summary">{activitySummary(a)}</td>
                        </tr>
                        {expanded && (
                          <tr className="sj-detail-row">
                            <td colSpan={6}>
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
                  {!loading && shownActivity.length === 0 && (
                    <tr><td colSpan={6} className="stk-empty">Aucune activité sur la période.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {activity.length >= 300 && <p className="sj-sub sj-foot">Les 300 dernières actions sont affichées : l&apos;export contient jusqu&apos;à 5 000 lignes.</p>}
          </section>
        ))}
    </div>
  );
}
