"use client";

import {
  Building2,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Plus,
  Search,
  Star,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  createGarage,
  fmtMoney,
  loadGarages,
  type GarageSummary,
} from "@/lib/data/saas";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "CL";
}

export default function GaragesPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<GarageSummary[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-garage modal
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", city: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadGarages(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitGarage(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.organization_id || !form.name.trim()) {
      setFormError("Le nom du garage est obligatoire.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const sb = createClient();
      await createGarage(sb, profile.organization_id, form);
      setModalOpen(false);
      setForm({ name: "", phone: "", email: "", city: "" });
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      [row.name, row.phone, row.email, row.city].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [rows, query]);

  const totals = useMemo(
    () => ({
      total: rows.length,
      active: rows.filter((row) => row.active).length,
      outstanding: rows.reduce((sum, row) => sum + row.outstanding, 0),
      revenue: rows.reduce((sum, row) => sum + row.revenue, 0),
    }),
    [rows],
  );

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">Garages</h1>
          <p className="rl-subtitle">Garages partenaires et activité calculée depuis les commandes.</p>
        </div>
        <div className="rl-header-actions">
          <div className="ga-search">
            <Search className="ga-search-icon h-4 w-4" />
            <input className="ga-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un garage..." />
          </div>
          <button type="button" className="od-btn od-btn--primary" onClick={() => { setFormError(null); setModalOpen(true); }}>
            <Plus className="h-4 w-4" />
            Nouveau garage
          </button>
        </div>
      </header>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <div className="ga-stats">
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#EEF2FF", color: "#4F46E5" }}><Building2 className="h-5 w-5" /></span><div><p className="ga-stat-value">{totals.total}</p><p className="ga-stat-label">Total garages</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DCFCE7", color: "#059669" }}><Building2 className="h-5 w-5" /></span><div><p className="ga-stat-value">{totals.active}</p><p className="ga-stat-label">Actifs</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#EA580C" }}><Wallet className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.outstanding)}</p><p className="ga-stat-label">Encours</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}><Wallet className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.revenue)}</p><p className="ga-stat-label">CA total</p></div></div>
      </div>

      <div className="ga-grid">
        {filtered.map((row, index) => (
          <article key={row.id} className="ga-card">
            <div className="ga-card-head">
              <span className="ga-avatar" style={{ background: ["#4F46E5", "#0EA5E9", "#16A34A", "#DB2777"][index % 4] }}>{initials(row.name)}</span>
              <div className="ga-card-id">
                <p className="ga-name">{row.name}</p>
                <p className="ga-meta">
                  <MapPin className="h-3.5 w-3.5" />
                  {row.city ?? "-"}
                  <span className="ga-rating"><Star className="h-3.5 w-3.5" />{(row.rating ?? 0).toFixed(1).replace(".", ",")}</span>
                </p>
              </div>
              <span className={`ga-status ga-status--${row.active ? "actif" : "inactif"}`}>{row.active ? "Actif" : "Inactif"}</span>
            </div>
            <div className="ga-contact">
              <span className="ga-contact-row"><Phone className="h-3.5 w-3.5" />{row.phone ?? "-"}</span>
              <span className="ga-contact-row"><Mail className="h-3.5 w-3.5" />{row.email ?? "-"}</span>
            </div>
            <div className="ga-stats-row">
              <div className="ga-mini"><p className="ga-mini-val">{row.orders}</p><p className="ga-mini-lbl">Commandes</p></div>
              <div className="ga-mini"><p className="ga-mini-val">{fmtMoney(row.revenue)}</p><p className="ga-mini-lbl">CA</p></div>
              <div className="ga-mini"><p className={`ga-mini-val${row.outstanding > 0 ? " ga-mini-val--encours" : ""}`}>{fmtMoney(row.outstanding)}</p><p className="ga-mini-lbl">Encours</p></div>
            </div>
          </article>
        ))}
        {!loading && filtered.length === 0 && (
          <p className="text-muted">
            {rows.length === 0
              ? "Aucun garage enregistré. Cliquez sur « Nouveau garage » pour en ajouter un."
              : "Aucun garage ne correspond à votre recherche."}
          </p>
        )}
      </div>

      {modalOpen && (
        <div className="ga-modal-overlay" onClick={() => !saving && setModalOpen(false)}>
          <div className="ga-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <h2 className="ga-modal-title">Nouveau garage</h2>
              <button type="button" className="ga-modal-close" onClick={() => setModalOpen(false)} aria-label="Fermer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitGarage}>
              {formError && <div className="nc-error">{formError}</div>}
              <div className="od-field">
                <span className="od-label">Nom du garage *</span>
                <input className="od-input" placeholder="Garage Martin" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus />
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Téléphone</span>
                  <input className="od-input" placeholder="01 23 45 67 89" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className="od-field">
                  <span className="od-label">Ville</span>
                  <input className="od-input" placeholder="Nanterre" value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
                </div>
              </div>
              <div className="od-field">
                <span className="od-label">Email</span>
                <input className="od-input" type="email" placeholder="contact@garage.fr" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setModalOpen(false)} disabled={saving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Plus className="h-4 w-4" />}
                  {saving ? "Enregistrement…" : "Créer le garage"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
