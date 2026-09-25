"use client";

import { LifeBuoy, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  SavUnavailableError,
  createWarrantyRule,
  deleteWarrantyRule,
  loadSavSettings,
  loadWarrantyRules,
  updateSavSettings,
  type SavSettings,
  type WarrantyRule,
} from "@/lib/data/sav";
import { FAMILY_CODES, familyLabel } from "@/lib/sav";
import { QUEUED_SMS_DEFAULTS, QUEUED_SMS_PLACEHOLDERS, buildQueuedSms, type QueuedSmsKind } from "@/lib/sms";

/**
 * Paramètres → Après-vente : les huit automatismes (tous éteints tant que le
 * magasin ne les allume pas), la politique de reprise / consigne / délai de
 * réponse, le lien d'avis Google et les durées de garantie équipementier.
 */
type ToggleKey =
  | "autoSmsReady"
  | "autoSmsDelay"
  | "autoSmsPickupReminders"
  | "autoSmsConsigne"
  | "autoSupplierReminders"
  | "autoSmsSatisfaction"
  | "autoSmsAvoir"
  | "autoSmsMaintenance";

const AUTOMATIONS: { key: ToggleKey; title: string; when: string; kinds: Exclude<QueuedSmsKind, "READY">[]; note?: string }[] = [
  { key: "autoSmsReady", title: "Pièce arrivée → le client est prévenu", when: "Dès que la dernière pièce attendue est réceptionnée. Texte : le modèle « commande prête » ci-dessus.", kinds: [] },
  { key: "autoSmsDelay", title: "Retard fournisseur → le client est prévenu avant de rappeler", when: "Reliquat, pièce indisponible chez le fournisseur ou tournée reportée.", kinds: ["DELAY", "DELAY_NODATE"] },
  { key: "autoSmsPickupReminders", title: "Pièce non retirée → relances J+3, J+7, J+15", when: "À J+15 le comptoir est aussi alerté : remboursement ou remise en stock.", kinds: ["PICKUP_3", "PICKUP_7", "PICKUP_15"] },
  { key: "autoSmsConsigne", title: "Consigne non rendue → rappel à J-10", when: "Dix jours avant la date limite annoncée à la vente.", kinds: ["CONSIGNE_REMINDER"] },
  { key: "autoSupplierReminders", title: "Garantie sans réponse → relance du fournisseur", when: "E-mail avec le n° de dossier après le délai réglé sur la fiche fournisseur (15 jours par défaut). Sans e-mail SAV, le comptoir est seulement alerté.", kinds: [] },
  { key: "autoSmsSatisfaction", title: "Retrait + 3 jours → « la pièce vous convient ? »", when: "Oui → invitation à laisser un avis Google. Non → alerte immédiate au comptoir.", kinds: ["SATISFACTION"] },
  { key: "autoSmsAvoir", title: "Avoir dormant → « vous avez X € d'avoir »", when: "Une fois, quand un avoir n'a pas bougé depuis le nombre de mois réglé ci-dessous.", kinds: ["AVOIR_DORMANT"] },
  {
    key: "autoSmsMaintenance",
    title: "Relance d'entretien (plaquettes, vidange, batterie…)",
    when: "Prospection commerciale : uniquement les clients qui ont donné leur accord à la vente, avec un lien STOP. 40 messages par jour au plus.",
    kinds: ["MAINTENANCE"],
    note: "RGPD",
  },
];

const SAMPLE: Record<string, string> = {
  client: "M. Martin",
  commande: "REQ-2026-00412",
  date: "26/09",
  piece: "vos plaquettes de frein",
  montant: "120,00",
  vehicule: "Peugeot 308",
};

export function SavSettingsCard({ orgId, orgName, horaires, isAdmin }: { orgId: string; orgName: string; horaires: string | null; isAdmin: boolean }) {
  const [settings, setSettings] = useState<SavSettings | null>(null);
  const [rules, setRules] = useState<WarrantyRule[]>([]);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [ruleMarque, setRuleMarque] = useState("");
  const [ruleFamille, setRuleFamille] = useState("");
  const [ruleMonths, setRuleMonths] = useState("24");

  const load = useCallback(async () => {
    try {
      const sb = createClient();
      const [s, r] = await Promise.all([loadSavSettings(sb), loadWarrantyRules(sb, orgId)]);
      setSettings(s);
      setRules(r);
    } catch (e) {
      if (e instanceof SavUnavailableError) setHidden(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) {
    return (
      <section className="od-card st-rajout">
        <header className="st-rajout-head">
          <h2 className="st-rajout-title"><LifeBuoy className="h-4 w-4" /> Après-vente</h2>
        </header>
        <p className="sav-hint">Le module après-vente s&apos;active en appliquant les migrations 20260920010000 et 20260920020000 (npx supabase db push).</p>
      </section>
    );
  }
  if (!settings) return null;

  const patch = (p: Partial<SavSettings>) => setSettings((s) => (s ? { ...s, ...p } : s));
  const preview = (kind: Exclude<QueuedSmsKind, "READY">) =>
    buildQueuedSms(kind, SAMPLE, { magasin: orgName, horaires, readyTemplate: null, partialTemplate: null, templates: settings.templates }, { lien: "autodecision.fr/avis/…", stop: "autodecision.fr/stop/…" });

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      setSettings(await updateSavSettings(createClient(), settings));
      setMessage("Réglages après-vente enregistrés.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const addRule = async () => {
    const months = Number(ruleMonths);
    if (!ruleMarque.trim() && !ruleFamille) return setError("Indiquez une marque, une famille, ou les deux.");
    if (!Number.isInteger(months) || months < 1 || months > 120) return setError("Durée en mois : entre 1 et 120.");
    setError(null);
    try {
      await createWarrantyRule(createClient(), orgId, { marque: ruleMarque.trim() || null, famille: ruleFamille || null, months });
      setRuleMarque("");
      setRuleFamille("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeRule = async (id: string) => {
    try {
      await deleteWarrantyRule(createClient(), id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <section className="od-card st-rajout">
        <header className="st-rajout-head">
          <h2 className="st-rajout-title"><LifeBuoy className="h-4 w-4" /> Après-vente — automatismes</h2>
        </header>
        <p className="st-cmd-hint" style={{ marginBottom: 6 }}>
          Rien ne part vers un client tant que la ligne n&apos;est pas cochée. Les messages partent entre 8 h et 20 h, jamais le dimanche pour
          les rappels commerciaux, et tiennent en un SMS. Sans fournisseur SMS configuré, ils sont simulés et visibles dans Après-vente → Messages clients.
        </p>
        {error && <div className="nc-error">{error}</div>}
        {message && <p className="stat-change" style={{ color: "var(--clr-success)" }}>{message}</p>}

        <div className="sav-toggle-list">
          {AUTOMATIONS.map((a) => (
            <div key={a.key} className="sav-toggle-row">
              <input
                id={`sav-${a.key}`}
                type="checkbox"
                checked={settings[a.key]}
                disabled={!isAdmin}
                onChange={(e) => patch({ [a.key]: e.target.checked } as Partial<SavSettings>)}
              />
              <label className="sav-toggle-text" htmlFor={`sav-${a.key}`}>
                <strong>
                  {a.title} {a.note && <span className="rt-badge rt-badge--amber">{a.note}</span>}
                </strong>
                <span>{a.when}</span>
                {settings[a.key] &&
                  a.kinds.map((k) => {
                    const p = preview(k);
                    return (
                      <code key={k}>
                        {p.text} <em>— {p.size.chars} car. · {p.size.segments} SMS</em>
                      </code>
                    );
                  })}
              </label>
            </div>
          ))}
        </div>

        {isAdmin && (
          <details className="sav-templates">
            <summary>Personnaliser le texte des messages</summary>
            <p className="st-cmd-hint">Vide = texte par défaut. Les champs entre accolades sont remplacés à l&apos;envoi.</p>
            {(Object.keys(QUEUED_SMS_DEFAULTS) as Exclude<QueuedSmsKind, "READY">[]).map((k) => (
              <label key={k} className="od-field">
                <span className="od-label">
                  {k} — {QUEUED_SMS_PLACEHOLDERS[k].map((p) => `{${p}}`).join(" ")}
                </span>
                <textarea
                  className="od-input sav-textarea"
                  rows={2}
                  maxLength={320}
                  value={settings.templates[k] ?? ""}
                  placeholder={QUEUED_SMS_DEFAULTS[k]}
                  onChange={(e) => {
                    const next = { ...settings.templates };
                    if (e.target.value.trim()) next[k] = e.target.value;
                    else delete next[k];
                    patch({ templates: next });
                  }}
                />
              </label>
            ))}
          </details>
        )}

        <div className="st-rajout-grid" style={{ marginTop: 14 }}>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sav-channel">Canal</label>
            <select id="sav-channel" className="od-input" value={settings.channel} disabled={!isAdmin} onChange={(e) => patch({ channel: e.target.value === "WHATSAPP" ? "WHATSAPP" : "SMS" })}>
              <option value="SMS">SMS</option>
              <option value="WHATSAPP">WhatsApp (avec la photo de la pièce)</option>
            </select>
            <span className="st-cmd-hint">WhatsApp demande un expéditeur WhatsApp Business chez Twilio (TWILIO_WHATSAPP_FROM) et des modèles approuvés ; sinon le message part en SMS.</span>
          </div>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sav-review">Lien d&apos;avis Google</label>
            <input id="sav-review" className="od-input" value={settings.googleReviewUrl ?? ""} disabled={!isAdmin} onChange={(e) => patch({ googleReviewUrl: e.target.value || null })} placeholder="https://g.page/r/…/review" />
            <span className="st-cmd-hint">Proposé au client qui répond « oui » à l&apos;enquête de satisfaction.</span>
          </div>
        </div>
      </section>

      <section className="od-card st-rajout">
        <header className="st-rajout-head">
          <h2 className="st-rajout-title"><ShieldCheck className="h-4 w-4" /> Après-vente — politique du magasin</h2>
        </header>
        <div className="st-rajout-grid">
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sav-policy-days">Délai de reprise commerciale (jours)</label>
            <input id="sav-policy-days" className="od-input" type="number" min={0} max={365} value={settings.returnPolicyDays} disabled={!isAdmin} onChange={(e) => patch({ returnPolicyDays: Number(e.target.value) })} />
            <span className="st-cmd-hint">En boutique, aucun droit de rétractation légal : c&apos;est votre politique, imprimée sur le ticket.</span>
          </div>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sav-consigne-days">Retour de consigne par le client (jours)</label>
            <input id="sav-consigne-days" className="od-input" type="number" min={1} max={365} value={settings.consigneClientDays} disabled={!isAdmin} onChange={(e) => patch({ consigneClientDays: Number(e.target.value) })} />
          </div>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sav-sla">Délai de réponse aux litiges garages (heures)</label>
            <input id="sav-sla" className="od-input" type="number" min={1} max={720} value={settings.slaHours} disabled={!isAdmin} onChange={(e) => patch({ slaHours: Number(e.target.value) })} />
            <span className="st-cmd-hint">Affiché au garage : « réponse sous {settings.slaHours} h ».</span>
          </div>
          <div className="od-field st-f-ref">
            <label className="od-label" htmlFor="sav-dormant">Avoir dormant après (mois)</label>
            <input id="sav-dormant" className="od-input" type="number" min={1} max={60} value={settings.dormantCreditMonths} disabled={!isAdmin} onChange={(e) => patch({ dormantCreditMonths: Number(e.target.value) })} />
          </div>
        </div>
        <div className="od-field">
          <label className="od-label" htmlFor="sav-policy-text">Conditions de reprise imprimées sur le ticket</label>
          <textarea
            id="sav-policy-text"
            className="od-input sav-textarea"
            rows={2}
            maxLength={300}
            disabled={!isAdmin}
            value={settings.returnPolicyText ?? ""}
            onChange={(e) => patch({ returnPolicyText: e.target.value || null })}
            placeholder={`Reprise sous ${settings.returnPolicyDays} jours, pièce non montée, dans son emballage d'origine, sur présentation du ticket. Pièces électriques montées : ni reprises ni échangées.`}
          />
        </div>

        <h3 className="sav-panel-subtitle">Garantie commerciale des équipementiers</h3>
        <p className="st-cmd-hint">
          La garantie légale (24 mois) est calculée d&apos;office sur chaque ligne vendue. Ajoutez ici les durées commerciales par marque et/ou
          famille : la règle la plus précise l&apos;emporte.
        </p>
        <table className="sav-mini">
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.marque ?? "Toutes marques"}</strong></td>
                <td>{r.famille ? familyLabel(r.famille) : "Toutes familles"}</td>
                <td className="av-th-right"><strong>{r.months} mois</strong></td>
                <td className="av-th-right">
                  {isAdmin && (
                    <button type="button" className="rc-act rc-act--quiet" onClick={() => void removeRule(r.id)} aria-label="Supprimer la règle">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td className="text-muted">Aucune règle : seule la garantie légale de 24 mois est comptée.</td></tr>}
          </tbody>
        </table>
        {isAdmin && (
          <div className="sav-rule-add">
            <input className="od-input" value={ruleMarque} onChange={(e) => setRuleMarque(e.target.value)} placeholder="Marque (Bosch, Valeo…)" aria-label="Marque" />
            <select className="od-input" value={ruleFamille} onChange={(e) => setRuleFamille(e.target.value)} aria-label="Famille">
              <option value="">Toutes familles</option>
              {FAMILY_CODES.filter((c) => c !== "AUTRE").map((c) => (
                <option key={c} value={c}>{familyLabel(c)}</option>
              ))}
            </select>
            <input className="od-input" type="number" min={1} max={120} value={ruleMonths} onChange={(e) => setRuleMonths(e.target.value)} aria-label="Durée en mois" />
            <button type="button" className="od-btn od-btn--outline" onClick={() => void addRule()}>
              <Plus className="h-4 w-4" /> Ajouter
            </button>
          </div>
        )}

        {isAdmin && (
          <div className="st-rajout-submit">
            <button type="button" className="od-btn od-btn--primary" disabled={saving} onClick={() => void save()}>
              <Save className="h-4 w-4" />
              {saving ? "Enregistrement..." : "Enregistrer l'après-vente"}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
