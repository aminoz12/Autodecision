"use client";

import { Save, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  loadOrganizationSettings,
  updateOrganizationSettings,
  type OrganizationSettings,
} from "@/lib/data/saas";

export default function ParametresPage() {
  const { profile } = useAuth();
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setSettings(await loadOrganizationSettings(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.organization_id || !settings) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const sb = createClient();
      await updateOrganizationSettings(sb, profile.organization_id, settings);
      setMessage("Parametres enregistres.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">
            Parametres magasin
            <span className="rl-title-icon"><Settings className="h-5 w-5" /></span>
          </h1>
          <p className="rl-subtitle">
            Donnees organisation Supabase protegees par RLS admin.
          </p>
        </div>
      </header>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}
      {message && <p className="stat-change" style={{ color: "var(--clr-success)" }}>{message}</p>}

      <section className="od-card st-rajout">
        <header className="st-rajout-head">
          <h2 className="st-rajout-title">Identite du magasin</h2>
        </header>
        <form onSubmit={submit} className="st-rajout-grid">
          <div className="od-field st-f-desig">
            <label className="od-label" htmlFor="org-name">Nom</label>
            <input
              id="org-name"
              className="od-input"
              value={settings?.name ?? ""}
              onChange={(e) => setSettings((s) => s ? { ...s, name: e.target.value } : s)}
              disabled={loading}
              required
            />
          </div>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="org-phone">Telephone</label>
            <input
              id="org-phone"
              className="od-input"
              value={settings?.phone ?? ""}
              onChange={(e) => setSettings((s) => s ? { ...s, phone: e.target.value } : s)}
              disabled={loading}
            />
          </div>
          <div className="od-field st-f-desig">
            <label className="od-label" htmlFor="org-address">Adresse</label>
            <input
              id="org-address"
              className="od-input"
              value={settings?.address ?? ""}
              onChange={(e) => setSettings((s) => s ? { ...s, address: e.target.value } : s)}
              disabled={loading}
            />
          </div>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="org-city">Ville</label>
            <input
              id="org-city"
              className="od-input"
              value={settings?.city ?? ""}
              onChange={(e) => setSettings((s) => s ? { ...s, city: e.target.value } : s)}
              disabled={loading}
            />
          </div>
          <div className="st-rajout-submit">
            <button type="submit" className="od-btn od-btn--primary" disabled={saving || loading}>
              <Save className="h-4 w-4" />
              {saving ? "Enregistrement..." : "Enregistrer"}
            </button>
          </div>
        </form>
      </section>

      <div className="ga-stats">
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}>
            <Settings className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{settings?.plan ?? "-"}</p>
            <p className="ga-stat-label">Plan</p>
          </div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#DCFCE7", color: "#059669" }}>
            <Settings className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{settings?.subscriptionStatus ?? "-"}</p>
            <p className="ga-stat-label">Abonnement</p>
          </div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#D97706" }}>
            <Settings className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{settings?.seatLimit ?? "-"}</p>
            <p className="ga-stat-label">Limite utilisateurs</p>
          </div>
        </div>
      </div>
    </div>
  );
}
