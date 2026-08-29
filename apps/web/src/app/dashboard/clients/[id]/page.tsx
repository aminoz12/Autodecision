"use client";

import {
  Award,
  Car,
  Check,
  ChevronRight,
  FileText,
  Gift,
  History,
  Loader2,
  Mail,
  MapPin,
  Package,
  Pencil,
  Phone,
  Receipt,
  RotateCcw,
  ShoppingCart,
  Star,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney } from "@/lib/data/saas";
import { workflowLabel } from "@/lib/data/dashboard";
import {
  adjustLoyaltyPoints,
  loadClientProfile,
  LOYALTY,
  pointsValue,
  updateParticulierClient,
  type ClientProfile,
} from "@/lib/data/clients";

function frDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}
function frDateTime(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const PAY_LABEL: Record<string, { label: string; cls: string }> = {
  "PAYÉ": { label: "Payé", cls: "green" },
  PARTIEL: { label: "Acompte", cls: "amber" },
  "NON_PAYÉ": { label: "Non payé", cls: "red" },
};
const LINE_STATUS: Record<string, string> = {
  PENDING: "En attente",
  RECEIVED: "Reçue",
  BACKORDER: "Reliquat",
  NOT_RECEIVED: "Non reçue",
};
const RETURN_LABEL: Record<string, string> = {
  A_TRAITER: "À traiter",
  DEMANDE_ENVOYEE: "Demande envoyée",
  A_RECUPERER: "À récupérer",
  ACCEPTE: "Accepté",
  REFUSE: "Refusé",
  REMBOURSE: "Remboursé",
  AVOIR: "Avoir émis",
};
const KIND_LABEL: Record<string, { label: string; cls: string }> = {
  EARN: { label: "Points gagnés", cls: "green" },
  REDEEM: { label: "Points utilisés", cls: "violet" },
  BONUS: { label: "Bonus offert", cls: "blue" },
  ADJUST: { label: "Ajustement", cls: "amber" },
};

type Tab = "commandes" | "pieces" | "fidelite" | "retours" | "avoirs";

export default function ClientProfilePage() {
  const params = useParams<{ id: string }>();
  const clientId = params?.id ?? "";
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const supabase = useMemo(() => createClient(), []);

  const [client, setClient] = useState<ClientProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("commandes");
  const [openOrder, setOpenOrder] = useState<string | null>(null);

  // Edit profile
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", city: "", plate: "", vehicle: "", notes: "" });

  // Loyalty action
  const [loyaltyMode, setLoyaltyMode] = useState<"REDEEM" | "BONUS" | null>(null);
  const [loyaltyPoints, setLoyaltyPoints] = useState("");
  const [loyaltyReason, setLoyaltyReason] = useState("");
  const [loyaltyBusy, setLoyaltyBusy] = useState(false);
  const [loyaltyError, setLoyaltyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId || !clientId) return;
    setLoading(true);
    setError(null);
    try {
      const c = await loadClientProfile(supabase, orgId, clientId);
      setClient(c);
      if (c) {
        setForm({
          name: c.name,
          phone: c.phone ?? "",
          email: c.email ?? "",
          city: c.city ?? "",
          plate: c.plate ?? "",
          vehicle: c.vehicle ?? "",
          notes: c.notes ?? "",
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId, clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !client) return;
    setSaving(true);
    setError(null);
    try {
      await updateParticulierClient(supabase, orgId, client.id, form);
      setEditing(false);
      setNotice("Profil mis à jour.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    if (!orgId || !client) return;
    try {
      await updateParticulierClient(supabase, orgId, client.id, { active: !client.active });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitLoyalty() {
    if (!client || !loyaltyMode) return;
    const pts = Number(loyaltyPoints);
    if (!Number.isFinite(pts) || pts <= 0) {
      setLoyaltyError("Indiquez un nombre de points.");
      return;
    }
    setLoyaltyBusy(true);
    setLoyaltyError(null);
    try {
      const balance = await adjustLoyaltyPoints(supabase, client.id, {
        points: pts,
        kind: loyaltyMode,
        reason: loyaltyReason,
      });
      setNotice(
        loyaltyMode === "REDEEM"
          ? `${pts} points utilisés (≈ ${fmtMoney(pointsValue(pts))} de remise) — nouveau solde ${balance} pts.`
          : `${pts} points offerts — nouveau solde ${balance} pts.`,
      );
      setLoyaltyMode(null);
      setLoyaltyPoints("");
      setLoyaltyReason("");
      await load();
    } catch (err) {
      setLoyaltyError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoyaltyBusy(false);
    }
  }

  if (loading && !client) {
    return (
      <div className="od-page">
        <div className="od-card rc-empty"><p>Chargement du client…</p></div>
      </div>
    );
  }
  if (!client) {
    return (
      <div className="od-page">
        <nav className="od-breadcrumb">
          <Link href="/dashboard/clients">Clients particuliers</Link>
        </nav>
        <div className="od-card rc-empty"><p>{error ?? "Client introuvable."}</p></div>
      </div>
    );
  }

  const nextTier = [...LOYALTY.tiers].reverse().find((t) => t.min > client.earned) ?? null;
  const progress = nextTier
    ? Math.min(100, Math.round((client.earned / nextTier.min) * 100))
    : 100;

  const TABS: { id: Tab; label: string; icon: typeof History; count: number }[] = [
    { id: "commandes", label: "Commandes", icon: ShoppingCart, count: client.ordersList.length },
    { id: "pieces", label: "Pièces achetées", icon: Package, count: client.topParts.length },
    { id: "fidelite", label: "Fidélité", icon: Award, count: client.loyalty.length },
    { id: "retours", label: "Retours", icon: RotateCcw, count: client.returns.length },
    { id: "avoirs", label: "Avoirs", icon: Receipt, count: client.credits.length },
  ];

  return (
    <div className="od-page">
      <nav className="od-breadcrumb">
        <Link href="/dashboard">Tableau de bord</Link>
        <span className="od-breadcrumb-sep"><ChevronRight className="h-3.5 w-3.5" /></span>
        <Link href="/dashboard/clients">Clients particuliers</Link>
        <span className="od-breadcrumb-sep"><ChevronRight className="h-3.5 w-3.5" /></span>
        <span className="od-breadcrumb-current">{client.name}</span>
      </nav>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      {/* ---- Profile header ---- */}
      <section className="od-card cl-profile">
        <div className="cl-profile-main">
          <span className={`cl-profile-avatar cl-tier-bg--${client.tier.cls}`}>
            {client.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?"}
          </span>
          {editing ? (
            <form className="cl-edit" onSubmit={saveProfile}>
              <div className="ga-modal-row">
                <div className="od-field"><span className="od-label">Nom <span className="od-req">*</span></span><input className="od-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
                <div className="od-field"><span className="od-label">Téléphone</span><input className="od-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field"><span className="od-label">Email</span><input className="od-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                <div className="od-field"><span className="od-label">Ville</span><input className="od-input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field"><span className="od-label">Immatriculation</span><input className="od-input" value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} /></div>
                <div className="od-field"><span className="od-label">Véhicule</span><input className="od-input" value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} /></div>
              </div>
              <div className="od-field"><span className="od-label">Notes internes</span><textarea className="od-input cl-notes" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Préférences, remarques, véhicule secondaire…" /></div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setEditing(false)} disabled={saving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={saving || !form.name.trim()}>
                  {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  Enregistrer
                </button>
              </div>
            </form>
          ) : (
            <div className="cl-profile-id">
              <h1 className="cl-profile-name">
                {client.name}
                <span className={`cl-tier cl-tier--${client.tier.cls}`}><Award className="h-3.5 w-3.5" />{client.tier.label}</span>
                {!client.active && <span className="rt-badge rt-badge--red">Inactif</span>}
              </h1>
              <div className="cl-profile-lines">
                <span><Phone className="h-4 w-4" />{client.phone ?? "—"}</span>
                <span><Mail className="h-4 w-4" />{client.email ?? "—"}</span>
                <span><MapPin className="h-4 w-4" />{client.city ?? "—"}</span>
                <span><Car className="h-4 w-4" />{client.vehicle ?? "—"}{client.plate ? ` · ${client.plate}` : ""}</span>
                <span><Star className="h-4 w-4" />Client depuis {frDate(client.createdAt)}</span>
              </div>
              {client.notes && <p className="cl-profile-notes"><FileText className="h-4 w-4" />{client.notes}</p>}
              <div className="cl-profile-actions">
                <button type="button" className="od-btn od-btn--outline" onClick={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" /> Modifier le profil
                </button>
                <Link href="/dashboard/nouvelle-commande" className="od-btn od-btn--primary">
                  <ShoppingCart className="h-4 w-4" /> Nouvelle commande
                </Link>
                <button type="button" className="od-btn od-btn--ghost" onClick={() => void toggleActive()}>
                  {client.active ? "Désactiver" : "Réactiver"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="cl-kpis">
          <div className="cl-kpi"><span className="cl-kpi-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}><ShoppingCart className="h-4 w-4" /></span><span><strong>{client.orders}</strong><em>Commandes</em></span></div>
          <div className="cl-kpi"><span className="cl-kpi-icon" style={{ background: "#DCFCE7", color: "#059669" }}><Wallet className="h-4 w-4" /></span><span><strong>{fmtMoney(client.revenue)}</strong><em>Total acheté</em></span></div>
          <div className="cl-kpi"><span className="cl-kpi-icon" style={{ background: client.outstanding > 0 ? "#FEE2E2" : "#F1F5F9", color: client.outstanding > 0 ? "#DC2626" : "#64748B" }}><Receipt className="h-4 w-4" /></span><span><strong>{fmtMoney(client.outstanding)}</strong><em>Reste à payer</em></span></div>
          <div className="cl-kpi"><span className="cl-kpi-icon" style={{ background: "#FEF9C3", color: "#A16207" }}><History className="h-4 w-4" /></span><span><strong>{frDate(client.lastOrderAt)}</strong><em>Dernière commande</em></span></div>
        </div>
      </section>

      {/* ---- Fidelity card ---- */}
      <section className={`od-card cl-loyalty cl-loyalty--${client.tier.cls}`}>
        <div className="cl-loyalty-main">
          <span className="cl-loyalty-icon"><Award className="h-6 w-6" /></span>
          <div>
            <p className="cl-loyalty-points">{client.points.toLocaleString("fr-FR")} <span>points</span></p>
            <p className="cl-loyalty-sub">
              ≈ {fmtMoney(pointsValue(client.points))} de remise disponible · niveau <strong>{client.tier.label}</strong> ·{" "}
              {client.earned.toLocaleString("fr-FR")} points cumulés
            </p>
            <div className="cl-loyalty-track"><span style={{ width: `${progress}%` }} /></div>
            <p className="cl-loyalty-next">
              {nextTier
                ? `Encore ${(nextTier.min - client.earned).toLocaleString("fr-FR")} points pour passer ${nextTier.label}`
                : "Niveau maximum atteint 🎉"}
              {" · "}{LOYALTY.pointsPerEuro} point par € acheté, 100 points = {LOYALTY.euroPer100Points} €
            </p>
          </div>
        </div>
        <div className="cl-loyalty-actions">
          <button type="button" className="od-btn od-btn--primary" onClick={() => { setLoyaltyMode("REDEEM"); setLoyaltyError(null); }} disabled={client.points <= 0}>
            <Gift className="h-4 w-4" /> Utiliser des points
          </button>
          <button type="button" className="od-btn od-btn--outline" onClick={() => { setLoyaltyMode("BONUS"); setLoyaltyError(null); }}>
            <Star className="h-4 w-4" /> Offrir des points
          </button>
        </div>
      </section>

      {/* ---- Tabs ---- */}
      <div className="rc-tabs cl-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`rc-tab${tab === t.id ? " rc-tab--active" : ""}`}>
              <span className="rc-tab-icon"><Icon className="h-5 w-5" /></span>
              <span className="rc-tab-text">
                <span className="rc-tab-label">{t.label}<span className="rc-tab-count">{t.count}</span></span>
              </span>
            </button>
          );
        })}
      </div>

      {tab === "commandes" && (
        <section className="od-card rc-table-card">
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead>
                <tr>
                  <th>N° CMD / Date</th>
                  <th>Véhicule</th>
                  <th>Pièces</th>
                  <th>Statut</th>
                  <th>Paiement</th>
                  <th className="rc-th-center">Total</th>
                  <th className="rc-th-center">Reste dû</th>
                </tr>
              </thead>
              <tbody>
                {client.ordersList.map((o) => {
                  const wf = workflowLabel(o.workflow);
                  const pay = PAY_LABEL[o.statutPaiement] ?? { label: o.statutPaiement, cls: "blue" };
                  const expanded = openOrder === o.id;
                  return (
                    <Fragment key={o.id}>
                      <tr className="rc-row cl-row" onClick={() => setOpenOrder(expanded ? null : o.id)}>
                        <td>
                          <Link href={`/dashboard/commandes/${o.id}`} className="rc-cmd" onClick={(e) => e.stopPropagation()}>{o.ref}</Link>
                          <p className="rl-muted">{frDate(o.date)}</p>
                        </td>
                        <td>
                          <p className="rc-vehicle">{o.vehicle ?? client.vehicle ?? "—"}</p>
                          <p className="rl-muted">{o.plate ?? ""}{o.kilometrage != null ? ` · ${o.kilometrage.toLocaleString("fr-FR")} km` : ""}</p>
                        </td>
                        <td>
                          <p className="rl-client">{o.lines.length} pièce{o.lines.length > 1 ? "s" : ""}</p>
                          <p className="rl-muted">{o.lines.slice(0, 2).map((l) => l.designation).join(", ")}{o.lines.length > 2 ? "…" : ""}</p>
                        </td>
                        <td><span className={`status-badge status-badge--${wf.type}`}>{wf.label}</span></td>
                        <td><span className={`rt-badge rt-badge--${pay.cls}`}>{pay.label}</span></td>
                        <td className="rc-th-center rl-qte">{fmtMoney(o.total)}</td>
                        <td className="rc-th-center">{o.balance > 0 ? <span className="rt-badge rt-badge--red">{fmtMoney(o.balance)}</span> : <span className="rl-muted">—</span>}</td>
                      </tr>
                      {expanded && (
                        <tr className="cl-lines-row">
                          <td colSpan={7}>
                            <table className="cl-lines">
                              <thead>
                                <tr><th>Référence</th><th>Désignation</th><th>Origine</th><th>Statut</th><th className="rc-th-center">Qté</th><th className="rc-th-center">PU</th><th className="rc-th-center">Remis</th></tr>
                              </thead>
                              <tbody>
                                {o.lines.map((l) => (
                                  <tr key={l.id}>
                                    <td className="rl-ref">{l.reference}</td>
                                    <td>{l.designation}</td>
                                    <td>{l.fromStock ? "Stock magasin" : l.supplierName ?? "Fournisseur"}</td>
                                    <td>{LINE_STATUS[l.status] ?? l.status}</td>
                                    <td className="rc-th-center">{l.quantity}</td>
                                    <td className="rc-th-center">{fmtMoney(l.unitPrice)}</td>
                                    <td className="rc-th-center">{l.handedOver}/{l.quantity}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {client.ordersList.length === 0 && (
                  <tr><td colSpan={7} className="rc-empty-cell">Aucune commande.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "pieces" && (
        <section className="od-card rc-table-card">
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead>
                <tr><th>Référence</th><th>Désignation</th><th className="rc-th-center">Quantité totale</th><th className="rc-th-center">Fois commandée</th></tr>
              </thead>
              <tbody>
                {client.topParts.map((p) => (
                  <tr key={p.reference} className="rc-row">
                    <td className="rl-ref">{p.reference}</td>
                    <td>{p.designation}</td>
                    <td className="rc-th-center rl-qte">{p.quantity}</td>
                    <td className="rc-th-center rl-qte">{p.times}</td>
                  </tr>
                ))}
                {client.topParts.length === 0 && <tr><td colSpan={4} className="rc-empty-cell">Aucune pièce achetée.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "fidelite" && (
        <section className="od-card rc-table-card">
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead>
                <tr><th>Date</th><th>Mouvement</th><th>Motif</th><th className="rc-th-center">Points</th></tr>
              </thead>
              <tbody>
                {client.loyalty.map((t) => {
                  const k = KIND_LABEL[t.kind] ?? { label: t.kind, cls: "blue" };
                  return (
                    <tr key={t.id} className="rc-row">
                      <td className="rl-muted-strong">{frDateTime(t.date)}</td>
                      <td><span className={`rt-badge rt-badge--${k.cls}`}>{k.label}</span></td>
                      <td>
                        {t.orderId ? <Link href={`/dashboard/commandes/${t.orderId}`} className="rc-cmd">{t.reason}</Link> : t.reason ?? "—"}
                      </td>
                      <td className={`rc-th-center rl-qte ${t.points < 0 ? "cl-pts-neg" : "cl-pts-pos"}`}>
                        {t.points > 0 ? "+" : ""}{t.points.toLocaleString("fr-FR")}
                      </td>
                    </tr>
                  );
                })}
                {client.loyalty.length === 0 && <tr><td colSpan={4} className="rc-empty-cell">Aucun mouvement de points — ils arrivent automatiquement à chaque commande.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "retours" && (
        <section className="od-card rc-table-card">
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead>
                <tr><th>Réf.</th><th>Date</th><th>Pièce</th><th>Motif</th><th>Traitement</th><th className="rc-th-center">Montant</th></tr>
              </thead>
              <tbody>
                {client.returns.map((r) => (
                  <tr key={r.id} className="rc-row">
                    <td className="rl-ref">{r.ref ?? "—"}</td>
                    <td className="rl-muted-strong">{frDate(r.date)}</td>
                    <td>{r.designation ?? "—"}</td>
                    <td>{r.reason}</td>
                    <td><span className="rt-badge rt-badge--blue">{RETURN_LABEL[r.treatment ?? ""] ?? r.treatment ?? "—"}</span></td>
                    <td className="rc-th-center rl-qte">{fmtMoney(r.amount)}</td>
                  </tr>
                ))}
                {client.returns.length === 0 && <tr><td colSpan={6} className="rc-empty-cell">Aucun retour.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === "avoirs" && (
        <section className="od-card rc-table-card">
          <div className="rc-table-wrap">
            <table className="rc-table">
              <thead>
                <tr><th>N° avoir</th><th>Date</th><th className="rc-th-center">Montant</th><th className="rc-th-center">Utilisé</th><th className="rc-th-center">Reste</th><th>Statut</th><th>Échéance</th></tr>
              </thead>
              <tbody>
                {client.credits.map((a) => (
                  <tr key={a.id} className="rc-row">
                    <td className="rl-ref">{a.num ?? "—"}</td>
                    <td className="rl-muted-strong">{frDate(a.date)}</td>
                    <td className="rc-th-center rl-qte">{fmtMoney(a.amount)}</td>
                    <td className="rc-th-center rl-qte">{fmtMoney(a.used)}</td>
                    <td className="rc-th-center rl-qte">{fmtMoney(Math.max(0, a.amount - a.used))}</td>
                    <td><span className={`rt-badge rt-badge--${a.statut === "UTILISE" ? "green" : a.statut === "PARTIEL" ? "amber" : "blue"}`}>{a.statut}</span></td>
                    <td className="rl-muted-strong">{frDate(a.echeance)}</td>
                  </tr>
                ))}
                {client.credits.length === 0 && <tr><td colSpan={7} className="rc-empty-cell">Aucun avoir.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {loyaltyMode && (
        <div className="ga-modal-overlay" onClick={() => !loyaltyBusy && setLoyaltyMode(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title">
                {loyaltyMode === "REDEEM" ? <Gift className="h-4 w-4" /> : <Star className="h-4 w-4" />}
                {loyaltyMode === "REDEEM" ? "Utiliser des points" : "Offrir des points"}
              </span>
              <button type="button" className="ga-modal-close" onClick={() => setLoyaltyMode(null)} aria-label="Fermer" disabled={loyaltyBusy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {loyaltyError && <div className="nc-error">{loyaltyError}</div>}
              <div className="rt-picked">
                <div>
                  <p className="rt-order-ref">{client.name}</p>
                  <p className="rt-order-client">Solde actuel : <strong>{client.points.toLocaleString("fr-FR")} pts</strong> (≈ {fmtMoney(pointsValue(client.points))})</p>
                </div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Points <span className="od-req">*</span></span>
                  <input className="od-input" type="number" min={1} step={1} max={loyaltyMode === "REDEEM" ? client.points : undefined} value={loyaltyPoints} onChange={(e) => setLoyaltyPoints(e.target.value)} autoFocus />
                  {loyaltyMode === "REDEEM" && Number(loyaltyPoints) > 0 && (
                    <span className="st-cmd-hint">≈ {fmtMoney(pointsValue(Number(loyaltyPoints)))} de remise à appliquer sur la commande.</span>
                  )}
                </div>
                <div className="od-field">
                  <span className="od-label">Motif</span>
                  <input className="od-input" value={loyaltyReason} onChange={(e) => setLoyaltyReason(e.target.value)} placeholder={loyaltyMode === "REDEEM" ? "Remise sur REQ-…" : "Geste commercial, parrainage…"} />
                </div>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setLoyaltyMode(null)} disabled={loyaltyBusy}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitLoyalty()} disabled={loyaltyBusy}>
                  {loyaltyBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  {loyaltyMode === "REDEEM" ? "Valider l'utilisation" : "Offrir les points"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
