"use client";

import {
  Building2,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Phone,
  Plus,
  Power,
  RefreshCw,
  Settings,
  ShieldCheck,
  Store,
  Trash2,
  Truck,
  UserRound,
  Users,
  Warehouse,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminGate } from "@/components/auth/AdminGate";
import { useAuth } from "@/components/providers/AuthProvider";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { Toast } from "@/components/ui/Toast";
import { MagasinSwitcher } from "@/components/MagasinSwitcher";
import { createClient } from "@/lib/supabase/client";
import {
  changeStaffRole,
  createGarageAccess,
  createLivreurAccess,
  createMagasin,
  createStaffMember,
  deleteAccess,
  generatePassword,
  loadMagasins,
  loadTeam,
  switchMagasin,
  type GarageAccount,
  type LivreurAccount,
  type MagasinRow,
  type StaffMember,
  setStaffPassword,
} from "@/lib/data/admin";
import { fmtDateTime, loadGarages, type GarageSummary } from "@/lib/data/saas";
import {
  createLivreur,
  loadLivreurs,
  deactivateLivreurConfirm,
  updateLivreur,
  type Livreur,
} from "@/lib/data/livreurs";

const ROLE_LABEL: Record<string, { label: string; cls: string }> = {
  ADMIN: { label: "Administrateur", cls: "violet" },
  CAISSIER: { label: "Caissier", cls: "blue" },
  LIVREUR: { label: "Livreur", cls: "amber" },
};

function frDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

type Tab = "equipe" | "garagistes" | "livreurs" | "magasins";

const BLOCKED_STATUSES = new Set(["past_due", "unpaid", "canceled", "cancelled", "incomplete_expired", "expired"]);

function magasinStatus(m: MagasinRow): { label: string; cls: string } {
  const st = m.status.toLowerCase();
  if (BLOCKED_STATUSES.has(st)) return { label: "Suspendu", cls: "red" };
  if (st === "trialing" || st === "trial") {
    const over = m.trialEndsAt && new Date(m.trialEndsAt).getTime() < Date.now();
    return over ? { label: "Essai expiré", cls: "red" } : { label: "Essai", cls: "amber" };
  }
  return { label: "Actif", cls: "green" };
}

export default function AdminPage() {
  return (
    <AdminGate>
      <AdminContent />
    </AdminGate>
  );
}

function AdminContent() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const supabase = useMemo(() => createClient(), []);

  const [tab, setTab] = useState<Tab>("equipe");
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [garageAccounts, setGarageAccounts] = useState<GarageAccount[]>([]);
  const [livreurAccounts, setLivreurAccounts] = useState<LivreurAccount[]>([]);
  const [garages, setGarages] = useState<GarageSummary[]>([]);
  const [livreurs, setLivreurs] = useState<Livreur[]>([]);
  const [magasins, setMagasins] = useState<MagasinRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [team, gars, livs, mag] = await Promise.all([
        loadTeam(),
        loadGarages(supabase, orgId),
        loadLivreurs(supabase, orgId),
        loadMagasins().catch(() => ({ magasins: [] as MagasinRow[] })),
      ]);
      setMagasins(mag.magasins);
      setStaff(team.staff);
      setGarageAccounts(team.garageAccounts);
      setLivreurAccounts(team.livreurAccounts ?? []);
      setGarages(gars);
      setLivreurs(livs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(key: string, fn: () => Promise<void>, ok?: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      if (ok) setNotice(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /* ---- Create staff modal ---- */
  const [staffModal, setStaffModal] = useState(false);
  const [sForm, setSForm] = useState({ name: "", email: "", password: "", role: "CAISSIER" as "CAISSIER" | "ADMIN" });
  const [sInvite, setSInvite] = useState(false);
  const [sSaving, setSSaving] = useState(false);
  const [sError, setSError] = useState<string | null>(null);

  /** Open the account modal for a caissier (espace magasin) or an admin. */
  function openStaffModal(role: "CAISSIER" | "ADMIN") {
    setSError(null);
    setSForm((f) => ({ ...f, role, password: "" }));
    setTab("equipe");
    setStaffModal(true);
  }

  async function submitStaff(e: React.FormEvent) {
    e.preventDefault();
    setSSaving(true);
    setSError(null);
    try {
      await createStaffMember({ ...sForm, invite: sInvite });
      setStaffModal(false);
      setNotice(
        sInvite
          ? `Invitation envoyée à ${sForm.email} : la personne choisit son mot de passe depuis le lien reçu.`
          : `Compte ${sForm.role === "ADMIN" ? "administrateur" : "caissier"} créé pour ${sForm.email}. Transmettez-lui l'email et le mot de passe.`,
      );
      setSForm({ name: "", email: "", password: "", role: "CAISSIER" });
      await load();
    } catch (err) {
      setSError(err instanceof Error ? err.message : String(err));
    } finally {
      setSSaving(false);
    }
  }

  /* ---- Staff password modal: a caissier / admin who forgot theirs ---- */
  const [pwdTarget, setPwdTarget] = useState<{ userId: string; name: string; email: string | null } | null>(null);
  const [pwdValue, setPwdValue] = useState("");
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState<string | null>(null);

  function openStaffPassword(m: { userId: string; name: string; email: string | null }) {
    setPwdTarget(m);
    setPwdValue("");
    setPwdError(null);
  }

  async function submitStaffPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!pwdTarget) return;
    setPwdSaving(true);
    setPwdError(null);
    try {
      await setStaffPassword(pwdTarget.userId, pwdValue);
      setNotice(
        `Nouveau mot de passe enregistré pour ${pwdTarget.name}${pwdTarget.email ? ` (${pwdTarget.email})` : ""} : ${pwdValue}`,
      );
      setPwdTarget(null);
    } catch (err) {
      setPwdError(err instanceof Error ? err.message : String(err));
    } finally {
      setPwdSaving(false);
    }
  }

  /* ---- Create magasin modal (a whole new organization + its admin) ---- */
  const [magModal, setMagModal] = useState(false);
  const [mForm, setMForm] = useState({ name: "", city: "", phone: "", copySettings: true });
  const [mSaving, setMSaving] = useState(false);
  const [mError, setMError] = useState<string | null>(null);
  /** The magasin just created, offered to open right away. */
  const [mCreated, setMCreated] = useState<{ name: string; orgId: string; warning?: string } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  function openMagModal() {
    setMError(null);
    setMCreated(null);
    setMForm({ name: "", city: "", phone: "", copySettings: true });
    setMagModal(true);
  }

  async function submitMagasin(e: React.FormEvent) {
    e.preventDefault();
    setMSaving(true);
    setMError(null);
    try {
      const res = await createMagasin({
        name: mForm.name.trim(),
        city: mForm.city.trim() || undefined,
        phone: mForm.phone.trim() || undefined,
        copySettings: mForm.copySettings,
      });
      setMCreated({ name: mForm.name.trim(), orgId: res.orgId, warning: res.warning });
      setTab("magasins");
      await load();
    } catch (err) {
      setMError(err instanceof Error ? err.message : String(err));
    } finally {
      setMSaving(false);
    }
  }

  /** Open another magasin with the same login: the session switches, the app reloads. */
  async function openMagasin(id: string) {
    setSwitching(id);
    setError(null);
    try {
      await switchMagasin(id);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSwitching(null);
    }
  }

  /* ---- Garage access modal ---- */
  const [accessModal, setAccessModal] = useState<GarageSummary | null>(null);
  const [gEmail, setGEmail] = useState("");
  const [gPwd, setGPwd] = useState("");
  const [gSaving, setGSaving] = useState(false);
  const [gError, setGError] = useState<string | null>(null);

  const accountByGarage = useMemo(
    () => new Map(garageAccounts.map((a) => [a.clientId, a])),
    [garageAccounts],
  );

  function openAccess(g: GarageSummary) {
    const existing = accountByGarage.get(g.id);
    setAccessModal(g);
    setGEmail(existing?.email ?? g.email ?? "");
    setGPwd("");
    setGError(null);
  }

  async function submitAccess(e: React.FormEvent) {
    e.preventDefault();
    if (!accessModal) return;
    setGSaving(true);
    setGError(null);
    try {
      const res = await createGarageAccess({ garageId: accessModal.id, email: gEmail, password: gPwd || undefined });
      setNotice(
        res.reset
          ? gPwd
            ? `Accès de ${accessModal.name} mis à jour — nouveaux identifiants : ${gEmail} / ${gPwd}`
            : `Accès de ${accessModal.name} mis à jour : ${gEmail}, mot de passe inchangé.`
          : `Accès créé pour ${accessModal.name} — identifiants : ${gEmail} / ${gPwd}`,
      );
      setAccessModal(null);
      await load();
    } catch (err) {
      setGError(err instanceof Error ? err.message : String(err));
    } finally {
      setGSaving(false);
    }
  }

  /* ---- Livreur access modal ---- */
  const accountByLivreur = useMemo(
    () => new Map(livreurAccounts.map((a) => [a.livreurId, a])),
    [livreurAccounts],
  );
  const [lvAccess, setLvAccess] = useState<Livreur | null>(null);
  const [lvEmail, setLvEmail] = useState("");
  const [lvPwd, setLvPwd] = useState("");
  const [lvAccSaving, setLvAccSaving] = useState(false);
  const [lvAccError, setLvAccError] = useState<string | null>(null);

  function openLivreurAccess(l: Livreur) {
    const existing = accountByLivreur.get(l.id);
    setLvAccess(l);
    setLvEmail(existing?.email ?? "");
    setLvPwd("");
    setLvAccError(null);
  }

  async function submitLivreurAccess(e: React.FormEvent) {
    e.preventDefault();
    if (!lvAccess) return;
    setLvAccSaving(true);
    setLvAccError(null);
    try {
      const res = await createLivreurAccess({ livreurId: lvAccess.id, email: lvEmail, password: lvPwd || undefined });
      const link = `${window.location.origin}/livreur/login`;
      setNotice(
        res.reset
          ? lvPwd
            ? `Accès de ${lvAccess.name} mis à jour — nouveaux identifiants : ${lvEmail} / ${lvPwd}. Lien de connexion : ${link}`
            : `Accès de ${lvAccess.name} mis à jour : ${lvEmail}, mot de passe inchangé.`
          : `Accès créé pour ${lvAccess.name} — identifiants : ${lvEmail} / ${lvPwd}. Lien de connexion du livreur : ${link}`,
      );
      setLvAccess(null);
      await load();
    } catch (err) {
      setLvAccError(err instanceof Error ? err.message : String(err));
    } finally {
      setLvAccSaving(false);
    }
  }

  /* ---- Livreurs ---- */
  const [lvAdding, setLvAdding] = useState(false);
  const [lvName, setLvName] = useState("");
  const [lvPhone, setLvPhone] = useState("");
  const [lvEditing, setLvEditing] = useState<{ id: string; name: string; phone: string } | null>(null);

  const stats = useMemo(
    () => ({
      staff: staff.length,
      admins: staff.filter((s) => s.role === "ADMIN").length,
      garageAccess: garageAccounts.length,
      garages: garages.length,
      livreurs: livreurs.filter((l) => l.active).length,
    }),
    [staff, garageAccounts, garages, livreurs],
  );

  const TABS: { id: Tab; label: string; sub: string; icon: LucideIcon; count: number }[] = [
    { id: "equipe", label: "Équipe du magasin", sub: "Caissiers & administrateurs", icon: Users, count: staff.length },
    { id: "garagistes", label: "Accès garagistes", sub: "Comptes du portail garage", icon: Building2, count: garageAccounts.length },
    { id: "livreurs", label: "Livreurs", sub: "Équipe de livraison", icon: Truck, count: livreurs.length },
    { id: "magasins", label: "Mes magasins", sub: "Autres points de vente", icon: Store, count: magasins.length },
  ];

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            <span className="admin-title-icon"><ShieldCheck className="h-5 w-5" /></span>
            Administration <span className="nc-title-accent">du magasin</span>
          </h1>
          <p className="rl-subtitle">
            Comptes et accès de toute l&apos;équipe : caissiers, garagistes, livreurs — et réglages réservés à l&apos;administrateur.
          </p>
        </div>
        <div className="rl-header-actions">
          <MagasinSwitcher />
          <button type="button" className="od-btn od-btn--primary" onClick={openMagModal}>
            <Store className="h-4 w-4" />
            Créer un nouveau magasin
          </button>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => openStaffModal("CAISSIER")}>
            <Plus className="h-4 w-4" />
            Ajouter un caissier
          </button>
          <Link href="/dashboard/fournisseurs" className="od-btn od-btn--ghost">
            <Warehouse className="h-4 w-4" />
            Fournisseurs
          </Link>
          <Link href="/dashboard/parametres" className="od-btn od-btn--ghost">
            <Settings className="h-4 w-4" />
            Paramètres
          </Link>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} duration={12000} />

      <div className="ga-stats admin-stats">
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#635BFF" }}><Users className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{stats.staff}</p><p className="ga-stat-label">Membres ({stats.admins} admin{stats.admins > 1 ? "s" : ""})</p></div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#533AFD" }}><Building2 className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{stats.garageAccess} / {stats.garages}</p><p className="ga-stat-label">Garages avec accès</p></div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#D6ECFF", color: "#0055BC" }}><Truck className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{stats.livreurs}</p><p className="ga-stat-label">Livreurs actifs</p></div>
        </div>
      </div>

      <div className="rc-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`rc-tab${tab === t.id ? " rc-tab--active" : ""}`}>
              <span className="rc-tab-icon"><Icon className="h-5 w-5" /></span>
              <span className="rc-tab-text">
                <span className="rc-tab-label">{t.label}<span className="rc-tab-count">{t.count}</span></span>
                <span className="rc-tab-sub">{t.sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      {loading && staff.length === 0 ? (
        <TableSkeleton rows={5} cols={6} />
      ) : (
        <>
          {/* ================= Équipe ================= */}
          {tab === "equipe" && (
            <section className="od-card rl-table-card">
              <div className="admin-card-head">
                <div>
                  <p className="admin-card-title">Caissiers &amp; administrateurs</p>
                  <p className="admin-card-sub">Ils se connectent sur cet espace magasin avec leur email.</p>
                </div>
                <button type="button" className="od-btn od-btn--ghost" onClick={() => openStaffModal("CAISSIER")}>
                  <Plus className="h-4 w-4" />
                  Ajouter un membre
                </button>
              </div>
              <div className="rl-table-wrap">
                <table className="rl-table">
                  <thead>
                    <tr>
                      <th>Membre</th>
                      <th>Email</th>
                      <th>Rôle</th>
                      <th>Dernière connexion</th>
                      <th>Créé le</th>
                      <th className="rl-th-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staff.map((m) => {
                      const role = ROLE_LABEL[m.role] ?? { label: m.role, cls: "blue" };
                      return (
                        <tr key={m.userId}>
                          <td>
                            <span className="fo-name">
                              <span className="fo-avatar">{m.name.slice(0, 2).toUpperCase()}</span>
                              <span className="rl-client">{m.name}{m.isSelf && <span className="rl-muted"> (vous)</span>}</span>
                            </span>
                          </td>
                          <td className="rl-muted-strong">{m.email ?? "—"}</td>
                          <td><span className={`rt-badge rt-badge--${role.cls}`}>{role.label}</span></td>
                          <td className="rl-muted-strong">{m.lastSignIn ? fmtDateTime(m.lastSignIn) : "Jamais"}</td>
                          <td className="rl-muted-strong">{frDate(m.createdAt)}</td>
                          <td className="rl-th-center">
                            <div className="rc-actions" style={{ justifyContent: "center" }}>
                              {!m.isSelf && (
                                <>
                                  <button
                                    type="button"
                                    className="rc-act rc-act--quiet"
                                    disabled={busy !== null}
                                    onClick={() => openStaffPassword(m)}
                                  >
                                    <KeyRound className="h-3.5 w-3.5" />
                                    Mot de passe
                                  </button>
                                  <button
                                    type="button"
                                    className="rc-act rc-act--quiet"
                                    disabled={busy !== null}
                                    onClick={() =>
                                      run(
                                        `role-${m.userId}`,
                                        () => changeStaffRole(m.userId, m.role === "ADMIN" ? "CAISSIER" : "ADMIN").then(() => undefined),
                                        "Rôle mis à jour.",
                                      )
                                    }
                                  >
                                    {busy === `role-${m.userId}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                                    {m.role === "ADMIN" ? "Passer caissier" : "Passer admin"}
                                  </button>
                                  <button
                                    type="button"
                                    className="rc-act rc-act--nonrecu"
                                    disabled={busy !== null}
                                    onClick={() => {
                                      if (window.confirm(`Supprimer l'accès de ${m.name} ? Cette action est définitive.`)) {
                                        void run(`del-${m.userId}`, () => deleteAccess(m.userId).then(() => undefined), "Accès supprimé.");
                                      }
                                    }}
                                  >
                                    {busy === `del-${m.userId}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                    Supprimer
                                  </button>
                                </>
                              )}
                              {m.isSelf && <span className="rt-dash">—</span>}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {staff.length === 0 && (
                      <tr><td colSpan={6} className="rc-empty-cell">Aucun membre.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= Garagistes ================= */}
          {tab === "garagistes" && (
            <section className="od-card rl-table-card">
              <div className="admin-card-head">
                <div>
                  <p className="admin-card-title">Accès au portail garagiste</p>
                  <p className="admin-card-sub">
                    Chaque garage partenaire peut recevoir un login pour commander en ligne — géré ici, plus depuis la page Garages.
                  </p>
                </div>
              </div>
              <div className="rl-table-wrap">
                <table className="rl-table">
                  <thead>
                    <tr>
                      <th>Garage</th>
                      <th>Téléphone</th>
                      <th>Accès</th>
                      <th>Dernière connexion</th>
                      <th className="rl-th-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {garages.map((g) => {
                      const account = accountByGarage.get(g.id);
                      return (
                        <tr key={g.id}>
                          <td>
                            <span className="fo-name">
                              <span className="fo-avatar" style={{ background: "#EEEDFF", color: "#533AFD" }}>{g.name.slice(0, 2).toUpperCase()}</span>
                              <span className="rl-client">{g.name}</span>
                            </span>
                          </td>
                          <td className="rl-muted-strong">{g.phone ?? "—"}</td>
                          <td>
                            {account ? (
                              <>
                                <span className="rt-badge rt-badge--green">Actif</span>
                                <p className="rl-muted">{account.email}</p>
                              </>
                            ) : (
                              <span className="rt-badge rt-badge--amber">Aucun accès</span>
                            )}
                          </td>
                          <td className="rl-muted-strong">{account?.lastSignIn ? fmtDateTime(account.lastSignIn) : "—"}</td>
                          <td className="rl-th-center">
                            <div className="rc-actions" style={{ justifyContent: "center" }}>
                              <button type="button" className={`rc-act ${account ? "rc-act--quiet" : "rc-act--retour"}`} onClick={() => openAccess(g)}>
                                <KeyRound className="h-3.5 w-3.5" />
                                {account ? "Réinitialiser" : "Créer l'accès"}
                              </button>
                              {account && (
                                <button
                                  type="button"
                                  className="rc-act rc-act--nonrecu"
                                  disabled={busy !== null}
                                  onClick={() => {
                                    if (window.confirm(`Supprimer l'accès de ${g.name} ? Le garage ne pourra plus se connecter.`)) {
                                      void run(`gdel-${account.userId}`, () => deleteAccess(account.userId).then(() => undefined), "Accès garagiste supprimé.");
                                    }
                                  }}
                                >
                                  {busy === `gdel-${account.userId}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                  Supprimer
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {garages.length === 0 && (
                      <tr><td colSpan={5} className="rc-empty-cell">Aucun garage — créez-les dans la page Garages.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= Livreurs ================= */}
          {tab === "livreurs" && (
            <section className="od-card rl-table-card">
              <div className="admin-card-head">
                <div>
                  <p className="admin-card-title">Équipe de livraison</p>
                  <p className="admin-card-sub">
                    Les livreurs reçoivent les commandes garages depuis Suivi des commandes → Commande à livrer.
                  </p>
                </div>
                <button type="button" className="od-btn od-btn--primary" onClick={() => setLvAdding((v) => !v)}>
                  <Plus className="h-4 w-4" />
                  Ajouter un livreur
                </button>
              </div>
              {lvAdding && (
                <form
                  className="admin-inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!orgId || !lvName.trim()) return;
                    void run(
                      "lv-add",
                      async () => {
                        await createLivreur(supabase, orgId, { name: lvName, phone: lvPhone, sortOrder: livreurs.length + 1 });
                        setLvName("");
                        setLvPhone("");
                        setLvAdding(false);
                      },
                      "Livreur ajouté.",
                    );
                  }}
                >
                  <input className="od-input" placeholder={`Livreur ${livreurs.length + 1}`} value={lvName} onChange={(e) => setLvName(e.target.value)} autoFocus />
                  <input className="od-input" placeholder="Téléphone" value={lvPhone} onChange={(e) => setLvPhone(e.target.value)} />
                  <button type="submit" className="od-btn od-btn--primary" disabled={busy === "lv-add" || !lvName.trim()}>
                    {busy === "lv-add" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                    Enregistrer
                  </button>
                </form>
              )}
              <div className="rl-table-wrap">
                <table className="rl-table">
                  <thead>
                    <tr>
                      <th>Livreur</th>
                      <th>Téléphone</th>
                      <th>Statut</th>
                      <th>Accès application</th>
                      <th className="rl-th-center">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {livreurs.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {lvEditing?.id === l.id ? (
                            <input className="od-input" style={{ height: 36, maxWidth: 220 }} value={lvEditing.name} onChange={(e) => setLvEditing({ ...lvEditing, name: e.target.value })} autoFocus />
                          ) : (
                            <span className="fo-name">
                              <span className="fo-avatar" style={{ background: "#D6ECFF", color: "#0055BC" }}><UserRound className="h-4 w-4" /></span>
                              <span className="rl-client">{l.name}</span>
                            </span>
                          )}
                        </td>
                        <td className="rl-muted-strong">
                          {lvEditing?.id === l.id ? (
                            <input className="od-input" style={{ height: 36, maxWidth: 170 }} value={lvEditing.phone} placeholder="Téléphone" onChange={(e) => setLvEditing({ ...lvEditing, phone: e.target.value })} />
                          ) : (
                            <><Phone className="h-3.5 w-3.5 cl-inline-icon" />{l.phone ?? "—"}</>
                          )}
                        </td>
                        <td><span className={`rt-badge rt-badge--${l.active ? "green" : "red"}`}>{l.active ? "Actif" : "Inactif"}</span></td>
                        <td>
                          {(() => {
                            const account = accountByLivreur.get(l.id);
                            return account ? (
                              <>
                                <span className="rt-badge rt-badge--green">Actif</span>
                                <p className="rl-muted">{account.email}</p>
                              </>
                            ) : (
                              <span className="rt-badge rt-badge--amber">Aucun accès</span>
                            );
                          })()}
                        </td>
                        <td className="rl-th-center">
                          <div className="rc-actions" style={{ justifyContent: "center" }}>
                            {lvEditing?.id === l.id ? (
                              <>
                                <button
                                  type="button"
                                  className="rc-act rc-act--recu"
                                  disabled={busy !== null}
                                  onClick={() => {
                                    if (!orgId || !lvEditing) return;
                                    const cur = lvEditing;
                                    void run(`lv-edit-${l.id}`, async () => {
                                      await updateLivreur(supabase, orgId, cur.id, { name: cur.name, phone: cur.phone });
                                      setLvEditing(null);
                                    }, "Livreur mis à jour.");
                                  }}
                                >
                                  <Check className="h-3.5 w-3.5" /> OK
                                </button>
                                <button type="button" className="rc-act rc-act--quiet" onClick={() => setLvEditing(null)}>
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="rc-act rc-act--quiet" onClick={() => setLvEditing({ id: l.id, name: l.name, phone: l.phone ?? "" })}>
                                  <Pencil className="h-3.5 w-3.5" /> Modifier
                                </button>
                                <button
                                  type="button"
                                  className={`rc-act ${accountByLivreur.get(l.id) ? "rc-act--quiet" : "rc-act--retour"}`}
                                  onClick={() => openLivreurAccess(l)}
                                >
                                  <KeyRound className="h-3.5 w-3.5" />
                                  {accountByLivreur.get(l.id) ? "Réinitialiser l'accès" : "Créer l'accès"}
                                </button>
                                {(() => {
                                  const account = accountByLivreur.get(l.id);
                                  return account ? (
                                    <button
                                      type="button"
                                      className="rc-act rc-act--nonrecu"
                                      disabled={busy !== null}
                                      onClick={() => {
                                        if (window.confirm(`Supprimer l'accès de ${l.name} ?`)) {
                                          void run(`lvdel-${account.userId}`, () => deleteAccess(account.userId).then(() => undefined), "Accès livreur supprimé.");
                                        }
                                      }}
                                    >
                                      {busy === `lvdel-${account.userId}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                    </button>
                                  ) : null;
                                })()}
                                <button
                                  type="button"
                                  className={`rc-act rc-act--quiet${l.active ? " rc-act--nonrecu" : " rc-act--recu"}`}
                                  disabled={busy !== null}
                                  onClick={() => {
                                    if (!orgId) return;
                                    if (l.active && !window.confirm(deactivateLivreurConfirm(l.name))) return;
                                    void run(
                                      `lv-toggle-${l.id}`,
                                      () => updateLivreur(supabase, orgId, l.id, { active: !l.active }),
                                      l.active ? "Livreur désactivé : son accès à la tournée est coupé." : "Livreur réactivé.",
                                    );
                                  }}
                                >
                                  <Power className="h-3.5 w-3.5" />
                                  {l.active ? "Désactiver" : "Réactiver"}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {livreurs.length === 0 && (
                      <tr><td colSpan={5} className="rc-empty-cell">Aucun livreur.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ================= Mes magasins ================= */}
          {tab === "magasins" && (
            <section className="od-card rl-table-card">
              <div className="admin-card-head">
                <div>
                  <p className="admin-card-title">Mes magasins</p>
                  <p className="admin-card-sub">
                    Un seul compte pour tous vos magasins. Chacun a sa propre équipe (caissiers, livreurs, garages), ses données et son abonnement.
                  </p>
                </div>
                <button type="button" className="od-btn od-btn--primary" onClick={openMagModal}>
                  <Store className="h-4 w-4" />
                  Créer un nouveau magasin
                </button>
              </div>
              <div className="rl-table-wrap">
                <table className="rl-table">
                  <thead>
                    <tr>
                      <th>Magasin</th>
                      <th>Abonnement</th>
                      <th>Créé le</th>
                      <th className="rl-th-center">Ouvrir</th>
                    </tr>
                  </thead>
                  <tbody>
                    {magasins.map((m) => {
                      const st = magasinStatus(m);
                      return (
                        <tr key={m.id}>
                          <td>
                            <p className="rl-client">
                              {m.name}
                              {m.isCurrent && <span className="rc-type rc-type--garage rc-type--inline">Vous êtes ici</span>}
                            </p>
                            <p className="rl-muted">{[m.city, m.phone].filter(Boolean).join(" · ") || "—"}</p>
                          </td>
                          <td>
                            <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                            {st.label === "Essai" && m.trialEndsAt && (
                              <p className="rl-muted">jusqu&apos;au {frDate(m.trialEndsAt)}</p>
                            )}
                          </td>
                          <td className="rl-muted">{frDate(m.createdAt)}</td>
                          <td className="rl-th-center">
                            {m.isCurrent ? (
                              <span className="rl-muted">Magasin ouvert</span>
                            ) : (
                              <button type="button" className="rc-act rc-act--recu" disabled={switching !== null} onClick={() => void openMagasin(m.id)}>
                                {switching === m.id ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Store className="h-3.5 w-3.5" />} Ouvrir
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {magasins.length === 0 && (
                      <tr><td colSpan={4} className="rc-empty-cell">Aucun autre magasin. Créez-en un pour ouvrir un second point de vente.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {/* ================= Create magasin modal ================= */}
      {magModal && (
        <div className="ga-modal-overlay" onClick={() => !mSaving && setMagModal(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><Store className="h-4 w-4" />{mCreated ? "Magasin créé" : "Créer un nouveau magasin"}</span>
              <button type="button" className="ga-modal-close" onClick={() => setMagModal(false)} aria-label="Fermer" disabled={mSaving}>
                <X className="h-4 w-4" />
              </button>
            </div>
            {mCreated ? (
              <div className="ga-modal-form">
                <div className="od-note">
                  <Check className="h-4 w-4" />
                  <p>
                    <strong>{mCreated.name}</strong> est prêt : son propre espace, son équipe à créer et un essai de 14 jours. Vous l&apos;ouvrez avec votre compte actuel.
                  </p>
                </div>
                {mCreated.warning && <div className="nc-error">{mCreated.warning}</div>}
                <div className="ga-modal-actions">
                  <button type="button" className="od-btn od-btn--ghost" onClick={() => setMagModal(false)}>Rester ici</button>
                  <button type="button" className="od-btn od-btn--primary" disabled={switching !== null} onClick={() => void openMagasin(mCreated.orgId)}>
                    {switching ? <Loader2 className="h-4 w-4 nc-spin" /> : <Store className="h-4 w-4" />}
                    Ouvrir ce magasin
                  </button>
                </div>
              </div>
            ) : (
              <form className="ga-modal-form" onSubmit={submitMagasin}>
                {mError && <div className="nc-error">{mError}</div>}
                <div className="od-field">
                  <span className="od-label">Nom du magasin <span className="od-req">*</span></span>
                  <input className="od-input" value={mForm.name} onChange={(e) => setMForm({ ...mForm, name: e.target.value })} placeholder="ESPACE AUTO 92 — Colombes" autoFocus />
                </div>
                <div className="ga-modal-row">
                  <div className="od-field">
                    <span className="od-label">Ville</span>
                    <input className="od-input" value={mForm.city} onChange={(e) => setMForm({ ...mForm, city: e.target.value })} placeholder="Colombes" />
                  </div>
                  <div className="od-field">
                    <span className="od-label">Téléphone</span>
                    <input className="od-input" value={mForm.phone} onChange={(e) => setMForm({ ...mForm, phone: e.target.value })} placeholder="01 23 45 67 89" />
                  </div>
                </div>
                <label className="admin-toggle">
                  <input type="checkbox" checked={mForm.copySettings} onChange={(e) => setMForm({ ...mForm, copySettings: e.target.checked })} />
                  <span>Reprendre mes réglages (TVA, mentions légales, pied de facture) et ma liste de fournisseurs</span>
                </label>
                <div className="od-note">
                  <ShieldCheck className="h-4 w-4" />
                  <p>
                    Vous restez l&apos;administrateur du nouveau magasin avec ce même compte. Vous y créerez ensuite ses caissiers, livreurs et accès garages. Il démarre avec un essai de 14 jours et son propre abonnement.
                  </p>
                </div>
                <div className="ga-modal-actions">
                  <button type="button" className="od-btn od-btn--ghost" onClick={() => setMagModal(false)} disabled={mSaving}>Annuler</button>
                  <button type="submit" className="od-btn od-btn--primary" disabled={mSaving || !mForm.name.trim()}>
                    {mSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Store className="h-4 w-4" />}
                    Créer le magasin
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}

      {/* ================= Create staff modal ================= */}
      {staffModal && (
        <div className="ga-modal-overlay" onClick={() => !sSaving && setStaffModal(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title">
                {sForm.role === "ADMIN" ? <Users className="h-4 w-4" /> : <Store className="h-4 w-4" />}
                {sForm.role === "ADMIN" ? "Ajouter un administrateur" : "Ajouter un caissier"}
              </span>
              <button type="button" className="ga-modal-close" onClick={() => setStaffModal(false)} aria-label="Fermer" disabled={sSaving}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitStaff}>
              {sError && <div className="nc-error">{sError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Nom <span className="od-req">*</span></span>
                  <input className="od-input" value={sForm.name} onChange={(e) => setSForm({ ...sForm, name: e.target.value })} placeholder="Karim Benali" autoFocus />
                </div>
                <div className="od-field">
                  <span className="od-label">Rôle</span>
                  <div className="od-select">
                    <select value={sForm.role} onChange={(e) => setSForm({ ...sForm, role: e.target.value as "CAISSIER" | "ADMIN" })}>
                      <option value="CAISSIER">Caissier</option>
                      <option value="ADMIN">Administrateur</option>
                    </select>
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Email de connexion <span className="od-req">*</span></span>
                  <input className="od-input" type="email" value={sForm.email} onChange={(e) => setSForm({ ...sForm, email: e.target.value })} placeholder="caissier@monmagasin.fr" />
                </div>
                <div className="od-field">
                  <span className="od-label">Accès</span>
                  <label className="admin-toggle">
                    <input type="checkbox" checked={sInvite} onChange={(e) => setSInvite(e.target.checked)} />
                    <span>Plutôt envoyer une invitation par email (la personne choisit son mot de passe)</span>
                  </label>
                </div>
              </div>
              <div className="ga-modal-row" hidden={sInvite}>
                <div className="od-field">
                  <span className="od-label">Mot de passe <span className="od-req">*</span></span>
                  <div className="admin-pwd">
                    <input className="od-input" value={sForm.password} onChange={(e) => setSForm({ ...sForm, password: e.target.value })} placeholder="Au moins 8 caractères, à transmettre" autoComplete="off" />
                    <button type="button" className="rc-act rc-act--quiet" title="Générer" onClick={() => setSForm({ ...sForm, password: generatePassword() })}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rc-act rc-act--quiet"
                      title="Copier"
                      onClick={() => { void navigator.clipboard?.writeText(sForm.password); setNotice("Mot de passe copié."); }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="od-note">
                <ShieldCheck className="h-4 w-4" />
                <p>
                  {sForm.role === "ADMIN"
                    ? "Un administrateur voit tout et gère l'équipe, les fournisseurs et les accès."
                    : "Un caissier travaille au comptoir : commandes, réception, retours, clients — sans l'administration ni les fournisseurs."}
                </p>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setStaffModal(false)} disabled={sSaving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={sSaving || !sForm.name.trim() || !sForm.email.trim() || (!sInvite && sForm.password.length < 8)}>
                  {sSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  Créer le compte
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Staff password modal ================= */}
      {pwdTarget && (
        <div className="ga-modal-overlay" onClick={() => !pwdSaving && setPwdTarget(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><KeyRound className="h-4 w-4" />Nouveau mot de passe — {pwdTarget.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setPwdTarget(null)} aria-label="Fermer" disabled={pwdSaving}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitStaffPassword}>
              {pwdError && <div className="nc-error">{pwdError}</div>}
              <div className="od-field">
                <span className="od-label">Mot de passe <span className="od-req">*</span></span>
                <div className="admin-pwd">
                  <input
                    className="od-input"
                    value={pwdValue}
                    onChange={(e) => setPwdValue(e.target.value)}
                    placeholder="Au moins 8 caractères"
                    autoComplete="off"
                    autoFocus
                  />
                  <button type="button" className="rc-act rc-act--quiet" title="Proposer un mot de passe" onClick={() => setPwdValue(generatePassword())}>
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    className="rc-act rc-act--quiet"
                    title="Copier"
                    onClick={() => { void navigator.clipboard?.writeText(pwdValue); setNotice("Mot de passe copié."); }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="od-note">
                <ShieldCheck className="h-4 w-4" />
                <p>
                  L&apos;ancien mot de passe de {pwdTarget.name} cesse de fonctionner immédiatement. Transmettez-lui le nouveau :
                  il pourra ensuite le changer lui-même depuis son espace (bouton clé, en bas du menu).
                </p>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setPwdTarget(null)} disabled={pwdSaving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={pwdSaving || pwdValue.length < 8}>
                  {pwdSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <KeyRound className="h-4 w-4" />}
                  Enregistrer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Livreur access modal ================= */}
      {lvAccess && (
        <div className="ga-modal-overlay" onClick={() => !lvAccSaving && setLvAccess(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><KeyRound className="h-4 w-4" />Accès livreur — {lvAccess.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setLvAccess(null)} aria-label="Fermer" disabled={lvAccSaving}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitLivreurAccess}>
              {lvAccError && <div className="nc-error">{lvAccError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Email de connexion <span className="od-req">*</span></span>
                  <input className="od-input" type="email" value={lvEmail} onChange={(e) => setLvEmail(e.target.value)} placeholder="livreur1@monmagasin.fr" autoFocus />
                  {accountByLivreur.get(lvAccess.id) && (
                    <span className="st-cmd-hint">Un seul accès par livreur : changer l&apos;email remplace l&apos;identifiant actuel. Le mot de passe reste le sien tant que vous n&apos;en saisissez pas un nouveau.</span>
                  )}
                </div>
                <div className="od-field">
                  <span className="od-label">
                    {accountByLivreur.get(lvAccess.id) ? "Nouveau mot de passe (facultatif)" : <>Mot de passe <span className="od-req">*</span></>}
                  </span>
                  <div className="admin-pwd">
                    <input
                      className="od-input"
                      value={lvPwd}
                      onChange={(e) => setLvPwd(e.target.value)}
                      placeholder={accountByLivreur.get(lvAccess.id) ? "Vide = mot de passe conservé" : "Au moins 8 caractères"}
                      autoComplete="off"
                    />
                    <button type="button" className="rc-act rc-act--quiet" title="Générer" onClick={() => setLvPwd(generatePassword())}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rc-act rc-act--quiet"
                      title="Copier"
                      onClick={() => { void navigator.clipboard?.writeText(lvPwd); setNotice("Mot de passe copié."); }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="od-note">
                <Truck className="h-4 w-4" />
                <p>
                  Le livreur se connecte avec ces identifiants sur <strong>{window.location.origin}/livreur/login</strong> (les
                  autres pages de connexion refusent les comptes livreur) et arrive sur <strong>sa tournée mobile</strong> :
                  uniquement ses livraisons, rien d&apos;autre. Depuis son téléphone, il peut l&apos;ajouter à l&apos;écran d&apos;accueil.
                </p>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setLvAccess(null)} disabled={lvAccSaving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={lvAccSaving || !lvEmail.trim() || (accountByLivreur.get(lvAccess.id) ? lvPwd.length > 0 && lvPwd.length < 8 : lvPwd.length < 8)}>
                  {lvAccSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <KeyRound className="h-4 w-4" />}
                  {accountByLivreur.get(lvAccess.id) ? "Enregistrer" : "Créer l'accès"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ================= Garage access modal ================= */}
      {accessModal && (
        <div className="ga-modal-overlay" onClick={() => !gSaving && setAccessModal(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><KeyRound className="h-4 w-4" />Accès garagiste — {accessModal.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setAccessModal(null)} aria-label="Fermer" disabled={gSaving}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitAccess}>
              {gError && <div className="nc-error">{gError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Email de connexion <span className="od-req">*</span></span>
                  <input className="od-input" type="email" value={gEmail} onChange={(e) => setGEmail(e.target.value)} placeholder="contact@garage.fr" autoFocus />
                </div>
                <div className="od-field">
                  <span className="od-label">
                    {accountByGarage.get(accessModal.id) ? "Nouveau mot de passe (facultatif)" : <>Mot de passe <span className="od-req">*</span></>}
                  </span>
                  <div className="admin-pwd">
                    <input
                      className="od-input"
                      value={gPwd}
                      onChange={(e) => setGPwd(e.target.value)}
                      placeholder={accountByGarage.get(accessModal.id) ? "Vide = mot de passe conservé" : "Au moins 8 caractères"}
                      autoComplete="off"
                    />
                    <button type="button" className="rc-act rc-act--quiet" title="Générer" onClick={() => setGPwd(generatePassword())}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rc-act rc-act--quiet"
                      title="Copier"
                      onClick={() => { void navigator.clipboard?.writeText(gPwd); setNotice("Mot de passe copié."); }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
              <div className="od-note">
                <Building2 className="h-4 w-4" />
                <p>Le garage se connecte sur la page d&apos;accueil garagiste avec ces identifiants, puis peut changer son mot de passe lui-même. Si un accès existe déjà, seul ce que vous modifiez change : l&apos;email, ou le mot de passe si vous en saisissez un nouveau.</p>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setAccessModal(null)} disabled={gSaving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={gSaving || !gEmail.trim() || (accountByGarage.get(accessModal.id) ? gPwd.length > 0 && gPwd.length < 8 : gPwd.length < 8)}>
                  {gSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <KeyRound className="h-4 w-4" />}
                  {accountByGarage.get(accessModal.id) ? "Enregistrer" : "Créer l'accès"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
