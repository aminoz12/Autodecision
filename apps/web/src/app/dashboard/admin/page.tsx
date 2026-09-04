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
import { createClient } from "@/lib/supabase/client";
import {
  changeStaffRole,
  createGarageAccess,
  createLivreurAccess,
  createStaffMember,
  deleteAccess,
  generatePassword,
  loadTeam,
  type GarageAccount,
  type LivreurAccount,
  type StaffMember,
} from "@/lib/data/admin";
import { fmtDateTime, loadGarages, type GarageSummary } from "@/lib/data/saas";
import {
  createLivreur,
  loadLivreurs,
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

type Tab = "equipe" | "garagistes" | "livreurs";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [team, gars, livs] = await Promise.all([
        loadTeam(),
        loadGarages(supabase, orgId),
        loadLivreurs(supabase, orgId),
      ]);
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
  const [sSaving, setSSaving] = useState(false);
  const [sError, setSError] = useState<string | null>(null);

  async function submitStaff(e: React.FormEvent) {
    e.preventDefault();
    setSSaving(true);
    setSError(null);
    try {
      await createStaffMember(sForm);
      setStaffModal(false);
      setNotice(`Compte ${sForm.role === "ADMIN" ? "administrateur" : "caissier"} créé pour ${sForm.email}. Transmettez-lui l'email et le mot de passe.`);
      setSForm({ name: "", email: "", password: "", role: "CAISSIER" });
      await load();
    } catch (err) {
      setSError(err instanceof Error ? err.message : String(err));
    } finally {
      setSSaving(false);
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
    setGPwd(generatePassword());
    setGError(null);
  }

  async function submitAccess(e: React.FormEvent) {
    e.preventDefault();
    if (!accessModal) return;
    setGSaving(true);
    setGError(null);
    try {
      const res = await createGarageAccess({ garageId: accessModal.id, email: gEmail, password: gPwd });
      setNotice(
        `${res.reset ? "Accès réinitialisé" : "Accès créé"} pour ${accessModal.name} — identifiants : ${gEmail} / ${gPwd}`,
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
    setLvPwd(generatePassword());
    setLvAccError(null);
  }

  async function submitLivreurAccess(e: React.FormEvent) {
    e.preventDefault();
    if (!lvAccess) return;
    setLvAccSaving(true);
    setLvAccError(null);
    try {
      const res = await createLivreurAccess({ livreurId: lvAccess.id, email: lvEmail, password: lvPwd });
      setNotice(
        `${res.reset ? "Accès réinitialisé" : "Accès créé"} pour ${lvAccess.name} — identifiants : ${lvEmail} / ${lvPwd}. Le livreur se connecte sur la page de connexion habituelle.`,
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
                <button type="button" className="od-btn od-btn--primary" onClick={() => { setSError(null); setSForm((f) => ({ ...f, password: generatePassword() })); setStaffModal(true); }}>
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
                                  onClick={() =>
                                    orgId &&
                                    run(`lv-toggle-${l.id}`, () => updateLivreur(supabase, orgId, l.id, { active: !l.active }), l.active ? "Livreur désactivé." : "Livreur réactivé.")
                                  }
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
        </>
      )}

      {/* ================= Create staff modal ================= */}
      {staffModal && (
        <div className="ga-modal-overlay" onClick={() => !sSaving && setStaffModal(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><Users className="h-4 w-4" />Ajouter un membre de l&apos;équipe</span>
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
                  <span className="od-label">Mot de passe <span className="od-req">*</span></span>
                  <div className="admin-pwd">
                    <input className="od-input" value={sForm.password} onChange={(e) => setSForm({ ...sForm, password: e.target.value })} />
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
                <button type="submit" className="od-btn od-btn--primary" disabled={sSaving || !sForm.name.trim() || !sForm.email.trim() || sForm.password.length < 6}>
                  {sSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  Créer le compte
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
                </div>
                <div className="od-field">
                  <span className="od-label">Mot de passe <span className="od-req">*</span></span>
                  <div className="admin-pwd">
                    <input className="od-input" value={lvPwd} onChange={(e) => setLvPwd(e.target.value)} />
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
                  Le livreur se connecte avec ces identifiants sur la page de connexion habituelle et arrive
                  directement sur <strong>sa tournée mobile</strong> : uniquement ses livraisons, bouton « Livrée » — rien d&apos;autre.
                </p>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setLvAccess(null)} disabled={lvAccSaving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={lvAccSaving || !lvEmail.trim() || lvPwd.length < 6}>
                  {lvAccSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <KeyRound className="h-4 w-4" />}
                  {accountByLivreur.get(lvAccess.id) ? "Réinitialiser l'accès" : "Créer l'accès"}
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
                  <span className="od-label">Mot de passe <span className="od-req">*</span></span>
                  <div className="admin-pwd">
                    <input className="od-input" value={gPwd} onChange={(e) => setGPwd(e.target.value)} />
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
                <p>Le garage se connecte sur la page d&apos;accueil garagiste avec ces identifiants. Si un accès existe déjà, le mot de passe est réinitialisé.</p>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setAccessModal(null)} disabled={gSaving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={gSaving || !gEmail.trim() || gPwd.length < 6}>
                  {gSaving ? <Loader2 className="h-4 w-4 nc-spin" /> : <KeyRound className="h-4 w-4" />}
                  {accountByGarage.get(accessModal.id) ? "Réinitialiser l'accès" : "Créer l'accès"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
