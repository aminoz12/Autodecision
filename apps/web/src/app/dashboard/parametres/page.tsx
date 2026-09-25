"use client";

import { SubscribeButton } from "@/components/billing/SubscribeButton";

import Link from "next/link";

import { Building2, FileText, MessageSquare, Save, Settings } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { SavSettingsCard } from "@/components/sav/SavSettingsCard";
import { createClient } from "@/lib/supabase/client";
import {
  loadOrganizationSettings,
  updateOrganizationProfile,
  type OrganizationSettings,
} from "@/lib/data/saas";
import {
  SMS_DEFAULT_HORAIRES,
  SMS_DEFAULT_PARTIAL_TEMPLATE,
  SMS_DEFAULT_READY_TEMPLATE,
  buildClientSms,
  type SmsKind,
} from "@/lib/sms";

type Field = {
  key: keyof Omit<OrganizationSettings, "id" | "plan" | "subscriptionStatus" | "seatLimit" | "tvaRate" | "logoUrl">;
  label: string;
  placeholder?: string;
  wide?: boolean;
  hint?: string;
  textarea?: boolean;
};

const IDENTITY: Field[] = [
  { key: "name", label: "Nom commercial", placeholder: "Espace Auto 92", wide: true },
  { key: "phone", label: "Téléphone", placeholder: "01 23 45 67 89" },
  { key: "address", label: "Adresse", placeholder: "426 avenue de la République", wide: true },
  { key: "city", label: "Code postal et ville", placeholder: "92000 Nanterre" },
];

const LEGAL: Field[] = [
  { key: "legalName", label: "Raison sociale", placeholder: "ESPACE AUTO 92 SAS", wide: true },
  { key: "legalForm", label: "Forme juridique", placeholder: "SAS, SARL, EI…" },
  { key: "siret", label: "SIRET", placeholder: "123 456 789 00012", hint: "14 chiffres" },
  { key: "tvaIntra", label: "N° TVA intracommunautaire", placeholder: "FR12345678901" },
  { key: "rcs", label: "RCS", placeholder: "Nanterre 123 456 789" },
  { key: "capital", label: "Capital social", placeholder: "10 000 €" },
  { key: "iban", label: "IBAN (affiché sur les factures)", placeholder: "FR76 …", wide: true },
  { key: "bic", label: "BIC", placeholder: "BNPAFRPP" },
];

const INVOICING: Field[] = [
  { key: "invoicePrefix", label: "Préfixe des factures", placeholder: "FA", hint: "Numérotation FA-2026-00001, continue et sans trou." },
  { key: "paymentTermsText", label: "Conditions de règlement (texte libre)", placeholder: "Paiement comptant à réception. Pour les garages : à 30 jours.", wide: true },
  { key: "invoiceFooter", label: "Pied de facture", placeholder: "CGV disponibles sur demande. Membre d'une association agréée…", wide: true, textarea: true },
];

/* SMS « commande prête » — vide = texte par défaut de lib/sms.ts */
const SMS_HOURS: Field[] = [
  { key: "smsHoraires", label: "Horaires indiqués dans le SMS", placeholder: SMS_DEFAULT_HORAIRES, hint: "Remplace {horaires} dans les messages." },
];
const SMS_READY: Field = {
  key: "smsReadyTemplate",
  label: "Message — commande complète",
  placeholder: SMS_DEFAULT_READY_TEMPLATE,
  wide: true,
  textarea: true,
};
const SMS_PARTIAL: Field = {
  key: "smsPartialTemplate",
  label: "Message — commande partielle (reliquat en cours)",
  placeholder: SMS_DEFAULT_PARTIAL_TEMPLATE,
  wide: true,
  textarea: true,
};
/** Sample order shown in the live preview. */
const SMS_SAMPLE = { client: "Jean Dupont", commande: "CO-2026-00042" };

export default function ParametresPage() {
  const { profile } = useAuth();
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const isAdmin = profile?.role === "ADMIN";

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
      await updateOrganizationProfile(sb, settings);
      setMessage("Paramètres enregistrés.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const set = (key: Field["key"], value: string) =>
    setSettings((s) => (s ? { ...s, [key]: value } : s));

  const renderFields = (fields: Field[]) =>
    fields.map((f) => (
      <div key={f.key} className={`od-field ${f.wide ? "st-f-desig" : "st-f-ref"}`}>
        <label className="od-label" htmlFor={`org-${f.key}`}>{f.label}</label>
        {f.textarea ? (
          <textarea
            id={`org-${f.key}`}
            className="od-input"
            rows={3}
            value={(settings?.[f.key] as string | null) ?? ""}
            onChange={(e) => set(f.key, e.target.value)}
            disabled={loading || !isAdmin}
            placeholder={f.placeholder}
          />
        ) : (
          <input
            id={`org-${f.key}`}
            className="od-input"
            value={(settings?.[f.key] as string | null) ?? ""}
            onChange={(e) => set(f.key, e.target.value)}
            disabled={loading || !isAdmin}
            placeholder={f.placeholder}
            required={f.key === "name"}
          />
        )}
        {f.hint && <span className="st-cmd-hint">{f.hint}</span>}
      </div>
    ));

  /** Exactly what the client would receive, with the cost in SMS. */
  const renderSmsPreview = (kind: SmsKind, label: string) => {
    if (!settings) return null;
    const { text, size } = buildClientSms(kind, SMS_SAMPLE, {
      magasin: settings.name,
      horaires: settings.smsHoraires,
      readyTemplate: settings.smsReadyTemplate,
      partialTemplate: settings.smsPartialTemplate,
    });
    return (
      <div className="od-field">
        <span className="od-label">{label}</span>
        <div className="sms-bubble">{text}</div>
        <span className="sms-meta">
          {size.chars} caractères · {size.segments} SMS
          {size.encoding === "UCS-2" ? " (caractères spéciaux : 70 par SMS)" : ""}
        </span>
      </div>
    );
  };

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            Paramètres du <span className="nc-title-accent">magasin</span>
          </h1>
          <p className="rl-subtitle">
            Identité imprimée sur vos tickets et factures, mentions légales obligatoires, TVA, état de l&apos;abonnement.
            {!isAdmin && " Seul l'administrateur peut modifier ces réglages."}
          </p>
        </div>
      </header>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}
      {message && <p className="stat-change" style={{ color: "var(--clr-success)" }}>{message}</p>}

      <form onSubmit={submit}>
        <section className="od-card st-rajout">
          <header className="st-rajout-head">
            <h2 className="st-rajout-title"><Building2 className="h-4 w-4" /> Identité du magasin</h2>
          </header>
          <div className="st-rajout-grid">{renderFields(IDENTITY)}</div>
        </section>

        <section className="od-card st-rajout">
          <header className="st-rajout-head">
            <h2 className="st-rajout-title"><FileText className="h-4 w-4" /> Mentions légales des factures</h2>
          </header>
          <p className="st-cmd-hint" style={{ marginBottom: 10 }}>
            Une facture française doit porter la raison sociale, la forme juridique, le capital, le SIRET, le RCS et le numéro de TVA intracommunautaire du vendeur.
          </p>
          <div className="st-rajout-grid">{renderFields(LEGAL)}</div>
        </section>

        <section className="od-card st-rajout">
          <header className="st-rajout-head">
            <h2 className="st-rajout-title"><FileText className="h-4 w-4" /> TVA et facturation</h2>
          </header>
          <div className="st-rajout-grid">
            <div className="od-field st-f-ref">
              <label className="od-label" htmlFor="org-tva">Taux de TVA par défaut (%)</label>
              <input
                id="org-tva"
                className="od-input"
                type="number"
                min={0}
                max={100}
                step="0.1"
                value={settings?.tvaRate ?? 20}
                onChange={(e) => setSettings((s) => (s ? { ...s, tvaRate: Number(e.target.value) } : s))}
                disabled={loading || !isAdmin}
              />
              <span className="st-cmd-hint">Les prix saisis sont TTC ; le HT et la TVA sont calculés à ce taux (une ligne peut avoir son propre taux).</span>
            </div>
            {renderFields(INVOICING)}
          </div>
        </section>

        <section className="od-card st-rajout">
          <header className="st-rajout-head">
            <h2 className="st-rajout-title"><MessageSquare className="h-4 w-4" /> SMS aux clients</h2>
          </header>
          <p className="st-cmd-hint" style={{ marginBottom: 10 }}>
            Envoyé depuis «&nbsp;Commande à préparer&nbsp;» quand les pièces d&apos;un client sont arrivées.
            Champs disponibles : {"{client}"}, {"{commande}"}, {"{horaires}"}, {"{magasin}"}. Vide = texte par défaut.
            Les lettres hors alphabet SMS (ê, ô, ç…) sont remplacées à l&apos;envoi pour tenir en un seul SMS.
          </p>
          <div className="st-rajout-grid">{renderFields(SMS_HOURS)}</div>
          <div className="sms-settings-grid">
            {renderFields([SMS_READY])}
            {renderSmsPreview("READY", "Aperçu — commande complète")}
            {renderFields([SMS_PARTIAL])}
            {renderSmsPreview("PARTIAL", "Aperçu — commande partielle")}
          </div>
          {isAdmin && (
            <div className="st-rajout-submit">
              <button type="submit" className="od-btn od-btn--primary" disabled={saving || loading}>
                <Save className="h-4 w-4" />
                {saving ? "Enregistrement..." : "Enregistrer"}
              </button>
            </div>
          )}
        </section>
      </form>

      {profile?.organization_id && (
        <SavSettingsCard
          orgId={profile.organization_id}
          orgName={settings?.name ?? ""}
          horaires={settings?.smsHoraires ?? null}
          isAdmin={isAdmin}
        />
      )}

      <section className="od-card st-rajout">
        <div className="od-card-title">Abonnement</div>
        <p className="rl-muted" style={{ marginBottom: 10 }}>
          {(settings?.subscriptionStatus ?? "").toLowerCase() === "active"
            ? "Votre abonnement est actif. Factures, moyen de paiement et résiliation se gèrent depuis le portail sécurisé."
            : "Passez à l'abonnement pour garder l'accès au magasin après la période d'essai."}
        </p>
        <div className="st-actions">
          {(settings?.subscriptionStatus ?? "").toLowerCase() === "active" ? (
            <SubscribeButton portal label="Gérer mon abonnement" className="od-btn od-btn--ghost" />
          ) : (
            <SubscribeButton label="S'abonner" />
          )}
          <Link href="/tarifs" className="od-btn od-btn--ghost">Voir les tarifs</Link>
        </div>
      </section>

      <div className="ga-stats">
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}>
            <Settings className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{settings?.plan === "TRIAL" ? "Essai" : settings?.plan ?? "—"}</p>
            <p className="ga-stat-label">Plan</p>
          </div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#DCFCE7", color: "#059669" }}>
            <Settings className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">
              {(settings?.subscriptionStatus ?? "").toLowerCase() === "active"
                ? "Actif"
                : (settings?.subscriptionStatus ?? "").toLowerCase().startsWith("trial")
                  ? "Essai en cours"
                  : settings?.subscriptionStatus ?? "—"}
            </p>
            <p className="ga-stat-label">Abonnement</p>
          </div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#D97706" }}>
            <Settings className="h-5 w-5" />
          </span>
          <div>
            <p className="ga-stat-value">{settings?.seatLimit ?? "—"}</p>
            <p className="ga-stat-label">Accès inclus (équipe)</p>
          </div>
        </div>
      </div>
    </div>
  );
}
