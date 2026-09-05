"use client";

import {
  AlarmClock,
  Building2,
  Check,
  ClipboardList,
  Copy,
  Crown,
  KeyRound,
  Loader2,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { Toast } from "@/components/ui/Toast";
import { generatePassword } from "@/lib/data/admin";
import { homeSpace } from "@/lib/spaces";

type OrgAdmin = { userId: string; name: string; email: string | null; lastSignIn: string | null };
type Org = {
  id: string;
  name: string;
  slug: string | null;
  plan: string;
  status: string;
  trialEndsAt: string | null;
  createdAt: string;
  city: string | null;
  orders: number;
  clients: number;
  staff: number;
  garages: number;
  livreurs: number;
  admins: OrgAdmin[];
};

const BLOCKED = new Set(["past_due", "unpaid", "canceled", "cancelled", "incomplete_expired", "expired"]);

function statusInfo(o: Org): { label: string; cls: string } {
  const s = o.status.toLowerCase();
  if (BLOCKED.has(s)) return { label: "Suspendu", cls: "red" };
  if (s === "trialing" || s === "trial") {
    const over = o.trialEndsAt && new Date(o.trialEndsAt).getTime() < Date.now();
    return over ? { label: "Essai expiré", cls: "red" } : { label: "Essai", cls: "amber" };
  }
  return { label: "Actif", cls: "green" };
}

function frDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

async function api<T>(body?: unknown): Promise<T> {
  const res = await fetch("/api/superadmin", {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
  return json;
}

export default function SuperAdminPage() {
  const { user, profile, ready, logout } = useAuth();
  const router = useRouter();

  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ orgs: Org[] }>();
      setOrgs(data.orgs);
      setDenied(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("réservé") || msg.includes("authentifié") || msg.includes("401") || msg.includes("403")) {
        setDenied(msg);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    // A magasin account (has a profile) doesn't belong here — go home.
    // Owner accounts have no profile; env-var superadmins are validated
    // by the API call below (denied card as fallback).
    if (profile) {
      router.replace(homeSpace(profile, user.email));
      return;
    }
    void load();
  }, [ready, user, profile, router, load]);

  async function run(key: string, body: Record<string, unknown>, ok: string) {
    setBusy(key);
    setError(null);
    try {
      await api(body);
      await load();
      setNotice(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /* ---- Reset admin password modal ---- */
  const [reset, setReset] = useState<{ admin: OrgAdmin; org: Org } | null>(null);
  const [resetPwd, setResetPwd] = useState("");

  /* ---- Create org modal ---- */
  const [createOpen, setCreateOpen] = useState(false);
  const [cForm, setCForm] = useState({ name: "", adminName: "", email: "", password: "" });
  const [cSaving, setCSaving] = useState(false);
  const [cError, setCError] = useState<string | null>(null);

  const stats = useMemo(
    () => ({
      total: orgs.length,
      active: orgs.filter((o) => statusInfo(o).cls === "green").length,
      trial: orgs.filter((o) => statusInfo(o).label === "Essai").length,
      blocked: orgs.filter((o) => statusInfo(o).cls === "red").length,
      orders: orgs.reduce((s, o) => s + o.orders, 0),
    }),
    [orgs],
  );

  if (!ready) return null;

  if (denied) {
    return (
      <div className="sa-page">
        <div className="od-card admin-locked">
          <span className="admin-locked-icon"><ShieldCheck className="h-7 w-7" /></span>
          <h1>Console propriétaire</h1>
          <p>{denied}</p>
          <Link href="/login" className="od-btn od-btn--primary">Se connecter</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="sa-page">
      <header className="sa-header">
        <span className="sa-brand"><Crown className="h-5 w-5" /></span>
        <div className="sa-header-text">
          <p className="sa-title">Console <span className="nc-title-accent">SaaS</span></p>
          <p className="sa-sub">Tous les magasins, leurs administrateurs et leur abonnement.</p>
        </div>
        <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
        </button>
        <button type="button" className="od-btn od-btn--primary" onClick={() => { setCError(null); setCForm((f) => ({ ...f, password: generatePassword() })); setCreateOpen(true); }}>
          <Plus className="h-4 w-4" />
          Nouveau magasin
        </button>
        <button
          type="button"
          className="od-btn od-btn--ghost"
          onClick={() => { void logout().then(() => router.replace("/login")); }}
          title="Se déconnecter"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} duration={10000} />

      <div className="ga-stats sa-stats">
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#635BFF" }}><Building2 className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.total}</p><p className="ga-stat-label">Magasins</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#D7F7C2", color: "#0E6245" }}><Check className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.active}</p><p className="ga-stat-label">Actifs</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FCEDB9", color: "#983705" }}><AlarmClock className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.trial}</p><p className="ga-stat-label">En essai</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FFE7F2", color: "#B3093C" }}><Pause className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.blocked}</p><p className="ga-stat-label">Suspendus / expirés</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#D6ECFF", color: "#0055BC" }}><ClipboardList className="h-5 w-5" /></span><div><p className="ga-stat-value">{stats.orders}</p><p className="ga-stat-label">Commandes (total)</p></div></div>
      </div>

      {loading && orgs.length === 0 ? (
        <TableSkeleton rows={5} cols={6} />
      ) : (
        <div className="sa-grid">
          {orgs.map((o) => {
            const st = statusInfo(o);
            const suspended = st.cls === "red" && BLOCKED.has(o.status.toLowerCase());
            return (
              <section key={o.id} className="od-card sa-card">
                <div className="sa-card-head">
                  <span className="sa-avatar">{o.name.slice(0, 2).toUpperCase()}</span>
                  <div className="sa-card-id">
                    <p className="sa-name">{o.name}</p>
                    <p className="sa-meta">
                      Créé le {frDate(o.createdAt)}{o.city ? ` · ${o.city}` : ""}
                      {st.label === "Essai" && o.trialEndsAt ? ` · essai jusqu'au ${frDate(o.trialEndsAt)}` : ""}
                    </p>
                  </div>
                  <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                </div>

                <div className="sa-kpis">
                  <span><strong>{o.orders}</strong> commandes</span>
                  <span><strong>{o.clients}</strong> clients</span>
                  <span><strong>{o.staff}</strong> staff</span>
                  <span><strong>{o.garages}</strong> garagistes</span>
                  <span><strong>{o.livreurs}</strong> livreurs</span>
                </div>

                <div className="sa-admins">
                  <p className="sa-admins-title"><Users className="h-3.5 w-3.5" /> Administrateurs</p>
                  {o.admins.length === 0 && <p className="rl-muted">Aucun administrateur.</p>}
                  {o.admins.map((a) => (
                    <div key={a.userId} className="sa-admin-row">
                      <div className="sa-admin-info">
                        <p className="sa-admin-name">{a.name}</p>
                        <p className="sa-admin-mail">{a.email ?? "—"} · dernière connexion {a.lastSignIn ? frDate(a.lastSignIn) : "jamais"}</p>
                      </div>
                      <button
                        type="button"
                        className="rc-act rc-act--quiet"
                        onClick={() => { setReset({ admin: a, org: o }); setResetPwd(generatePassword()); }}
                      >
                        <KeyRound className="h-3.5 w-3.5" /> Mot de passe
                      </button>
                    </div>
                  ))}
                </div>

                <div className="sa-actions">
                  {suspended ? (
                    <button
                      type="button"
                      className="rc-act rc-act--recu"
                      disabled={busy !== null}
                      onClick={() => run(`act-${o.id}`, { action: "activate", orgId: o.id }, `${o.name} réactivé.`)}
                    >
                      {busy === `act-${o.id}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Réactiver
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rc-act rc-act--nonrecu"
                      disabled={busy !== null}
                      onClick={() => {
                        if (window.confirm(`Suspendre ${o.name} ? Toute l'équipe perdra l'accès aux données.`)) {
                          void run(`susp-${o.id}`, { action: "suspend", orgId: o.id }, `${o.name} suspendu.`);
                        }
                      }}
                    >
                      {busy === `susp-${o.id}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Pause className="h-3.5 w-3.5" />}
                      Suspendre
                    </button>
                  )}
                  <button
                    type="button"
                    className="rc-act rc-act--quiet"
                    disabled={busy !== null}
                    onClick={() => run(`trial-${o.id}`, { action: "extend_trial", orgId: o.id, days: 14 }, `Essai de ${o.name} prolongé de 14 jours.`)}
                  >
                    {busy === `trial-${o.id}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <AlarmClock className="h-3.5 w-3.5" />}
                    +14 j d&apos;essai
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ---- Reset admin password ---- */}
      {reset && (
        <div className="ga-modal-overlay" onClick={() => setReset(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><KeyRound className="h-4 w-4" />Mot de passe — {reset.admin.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setReset(null)} aria-label="Fermer"><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              <p className="rl-muted">
                Magasin <strong>{reset.org.name}</strong> · {reset.admin.email ?? "—"}
              </p>
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
                  disabled={busy !== null || resetPwd.length < 6}
                  onClick={() => {
                    const r = reset;
                    setReset(null);
                    void run(`pwd-${r.admin.userId}`, { action: "reset_admin_password", userId: r.admin.userId, password: resetPwd }, `Mot de passe de ${r.admin.name} réinitialisé : ${resetPwd}`);
                  }}
                >
                  <Check className="h-4 w-4" />
                  Réinitialiser
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---- Create org ---- */}
      {createOpen && (
        <div className="ga-modal-overlay" onClick={() => !cSaving && setCreateOpen(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><Building2 className="h-4 w-4" />Nouveau magasin</span>
              <button type="button" className="ga-modal-close" onClick={() => setCreateOpen(false)} aria-label="Fermer" disabled={cSaving}><X className="h-4 w-4" /></button>
            </div>
            <form
              className="ga-modal-form"
              onSubmit={(e) => {
                e.preventDefault();
                setCSaving(true);
                setCError(null);
                api({ action: "create_org", ...cForm })
                  .then(() => {
                    setCreateOpen(false);
                    setNotice(`Magasin « ${cForm.name} » créé — admin ${cForm.email} / ${cForm.password} (essai 14 jours).`);
                    setCForm({ name: "", adminName: "", email: "", password: "" });
                    return load();
                  })
                  .catch((err: unknown) => setCError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setCSaving(false));
              }}
            >
              {cError && <div className="nc-error">{cError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Nom du magasin <span className="od-req">*</span></span>
                  <input className="od-input" value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} placeholder="Auto Pièces 93" autoFocus />
                </div>
                <div className="od-field">
                  <span className="od-label">Nom de l&apos;admin <span className="od-req">*</span></span>
                  <input className="od-input" value={cForm.adminName} onChange={(e) => setCForm({ ...cForm, adminName: e.target.value })} placeholder="Karim Benali" />
                </div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Email de l&apos;admin <span className="od-req">*</span></span>
                  <input className="od-input" type="email" value={cForm.email} onChange={(e) => setCForm({ ...cForm, email: e.target.value })} placeholder="patron@magasin.fr" />
                </div>
                <div className="od-field">
                  <span className="od-label">Mot de passe <span className="od-req">*</span></span>
                  <div className="admin-pwd">
                    <input className="od-input" value={cForm.password} onChange={(e) => setCForm({ ...cForm, password: e.target.value })} />
                    <button type="button" className="rc-act rc-act--quiet" title="Générer" onClick={() => setCForm({ ...cForm, password: generatePassword() })}><RefreshCw className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
              </div>
              <div className="od-note">
                <ShieldCheck className="h-4 w-4" />
                <p>Le magasin démarre en essai 14 jours avec 3 livreurs par défaut ; son admin gère ensuite toute son équipe.</p>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setCreateOpen(false)} disabled={cSaving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={cSaving || !cForm.name.trim() || !cForm.adminName.trim() || !cForm.email.trim() || cForm.password.length < 6}>
                  {cSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  Créer le magasin
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
