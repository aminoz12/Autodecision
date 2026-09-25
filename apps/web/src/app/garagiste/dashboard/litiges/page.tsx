"use client";

import { Camera, ChevronDown, Clock, Loader2, Scale, Send, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { loadGarageOrders, type GarageOrder } from "@/lib/data/garage";
import {
  SavUnavailableError,
  addSavCaseFile,
  addSavCaseNote,
  loadGarageCases,
  openGarageDispute,
  type GarageCase,
} from "@/lib/data/sav";
import { CASE_TYPE_LABEL, CLIENT_STATUS_LABEL, GESTURE_LABEL, clientStatusTone, laborAmount, slaHoursLeft } from "@/lib/sav";

function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}
function frDateTime(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
const eur = (n: number) => n.toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
const toNum = (v: string): number | null => {
  const n = Number(v.replace(",", "."));
  return v.trim() !== "" && Number.isFinite(n) ? n : null;
};

/**
 * Litiges & garanties — le garage ouvre un dossier (mauvaise pièce, pièce qui
 * fuit, main d'œuvre perdue), le chiffre (taux horaire × temps barémé), joint
 * ses photos et suit l'avancement. Le magasin s'engage sur un délai de réponse.
 */
export default function LitigesPage() {
  const { supabase, profile } = useAuth();
  const [orders, setOrders] = useState<GarageOrder[]>([]);
  const [cases, setCases] = useState<GarageCase[]>([]);
  const [slaHours, setSlaHours] = useState(48);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now] = useState(() => new Date());

  const [type, setType] = useState<"LITIGE" | "GARANTIE">("LITIGE");
  const [orderId, setOrderId] = useState("");
  const [lineId, setLineId] = useState("");
  const [designation, setDesignation] = useState("");
  const [plate, setPlate] = useState("");
  const [description, setDescription] = useState("");
  const [rate, setRate] = useState("");
  const [hours, setHours] = useState("");
  const [kmMontage, setKmMontage] = useState("");
  const [kmPanne, setKmPanne] = useState("");
  const [reply, setReply] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedOrder = useMemo(() => orders.find((o) => o.id === orderId) ?? null, [orders, orderId]);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    setLoading(true);
    setError(null);
    try {
      const [o, c] = await Promise.all([
        loadGarageOrders(supabase, profile.organization_id, profile.client_id),
        loadGarageCases(supabase),
      ]);
      setOrders(o);
      setCases(c.cases);
      setSlaHours(c.slaHours);
      setRate((r) => (r === "" && c.laborRate != null ? String(c.laborRate) : r));
    } catch (e) {
      setError(
        e instanceof SavUnavailableError
          ? "Votre magasin n'a pas encore activé le suivi des litiges."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.organization_id, profile?.client_id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (orderId && !lineId) return setError("Choisissez la pièce concernée dans la commande.");
    if (!orderId && !designation.trim()) return setError("Indiquez la pièce concernée.");
    if (!description.trim()) return setError("Décrivez le problème rencontré.");
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const id = await openGarageDispute(supabase, {
        type,
        orderId: orderId || null,
        orderLineId: lineId || null,
        designation: orderId ? null : designation.trim(),
        description: description.trim(),
        immatriculation: plate.trim() || null,
        laborRate: toNum(rate),
        laborHours: toNum(hours),
        kmMontage: toNum(kmMontage),
        kmPanne: toNum(kmPanne),
      });
      setOrderId("");
      setLineId("");
      setDesignation("");
      setPlate("");
      setDescription("");
      setHours("");
      setKmMontage("");
      setKmPanne("");
      setMsg(`Dossier ouvert. Votre magasin s'engage à vous répondre sous ${slaHours} h — ajoutez vos photos ci-dessous.`);
      setOpenId(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function sendReply(caseId: string) {
    if (!reply.trim()) return;
    setSaving(true);
    try {
      await addSavCaseNote(supabase, caseId, reply.trim(), true);
      setReply("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function upload(caseId: string, file: File | undefined) {
    if (!file || !profile?.organization_id) return;
    setSaving(true);
    setError(null);
    try {
      await addSavCaseFile(supabase, profile.organization_id, caseId, file, file.type === "application/pdf" ? "FACTURE_POSE" : "DEFAUT", null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="gp-page">
      <header className="gp-header">
        <h1 className="gp-title">Litiges &amp; garanties</h1>
        <p className="gp-subtitle">
          Une pièce non conforme, une panne prématurée, de la main d&apos;œuvre perdue ? Ouvrez un dossier : il est chiffré, suivi, et votre
          magasin s&apos;engage à vous répondre sous {slaHours} h.
        </p>
      </header>

      {error && <div className="nc-error">{error}</div>}
      {msg && <div className="nc-ok">{msg}</div>}

      <form onSubmit={submit} className="gp-card gp-form">
        <div className="gp-card-title">Ouvrir un dossier</div>
        <div className="od-toggle-group">
          <button type="button" className={`od-toggle${type === "LITIGE" ? " od-toggle--on" : ""}`} onClick={() => setType("LITIGE")}>
            <Scale className="h-5 w-5" />
            <span>
              <strong>Litige</strong>
              <em>Mauvaise pièce, temps perdu au montage</em>
            </span>
          </button>
          <button type="button" className={`od-toggle${type === "GARANTIE" ? " od-toggle--on" : ""}`} onClick={() => setType("GARANTIE")}>
            <ShieldCheck className="h-5 w-5" />
            <span>
              <strong>Garantie</strong>
              <em>Pièce montée, tombée en panne</em>
            </span>
          </button>
        </div>

        <div className="od-field">
          <span className="od-label">Commande concernée</span>
          <div className="od-select">
            <select
              value={orderId}
              onChange={(e) => {
                setOrderId(e.target.value);
                setLineId("");
              }}
            >
              <option value="">— Hors commande / je ne sais plus —</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>{o.ref} — {frDate(o.date)}</option>
              ))}
            </select>
            <ChevronDown className="h-4 w-4" />
          </div>
        </div>
        {orderId ? (
          <div className="od-field">
            <span className="od-label">Pièce concernée *</span>
            <div className="od-select">
              <select value={lineId} onChange={(e) => setLineId(e.target.value)}>
                <option value="">— Choisir une pièce —</option>
                {selectedOrder?.lines.map((l) => (
                  <option key={l.id} value={l.id}>{l.designation} ({l.reference})</option>
                ))}
              </select>
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
        ) : (
          <div className="od-field">
            <span className="od-label">Pièce concernée *</span>
            <input className="od-input" value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="Pompe à eau (PA1234)" />
          </div>
        )}

        <div className="ga-modal-row">
          <div className="od-field">
            <span className="od-label">Immatriculation du véhicule</span>
            <input className="od-input" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="AB-123-CD" />
          </div>
          {type === "GARANTIE" && (
            <>
              <div className="od-field">
                <span className="od-label">Km au montage</span>
                <input className="od-input" inputMode="numeric" value={kmMontage} onChange={(e) => setKmMontage(e.target.value)} />
              </div>
              <div className="od-field">
                <span className="od-label">Km à la panne</span>
                <input className="od-input" inputMode="numeric" value={kmPanne} onChange={(e) => setKmPanne(e.target.value)} />
              </div>
            </>
          )}
        </div>

        <div className="od-field">
          <span className="od-label">Ce qui s&apos;est passé *</span>
          <textarea className="gp-textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Pompe montée, fuite au joint dès la mise en eau. Démontage et remontage : 2 h." />
        </div>

        <div className="ga-modal-row">
          <div className="od-field">
            <span className="od-label">Votre taux horaire (€ HT)</span>
            <input className="od-input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="65" />
          </div>
          <div className="od-field">
            <span className="od-label">Temps barémé perdu (h)</span>
            <input className="od-input" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="2" />
          </div>
          <div className="od-field">
            <span className="od-label">Main d&apos;œuvre réclamée</span>
            <p className="sav-amount">{eur(laborAmount(toNum(rate), toNum(hours)))}</p>
          </div>
        </div>

        <div className="gp-form-actions">
          <button type="submit" className="od-btn od-btn--primary" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Scale className="h-4 w-4" />}
            {saving ? "Envoi…" : "Ouvrir le dossier"}
          </button>
        </div>
      </form>

      <section className="gp-card" style={{ marginTop: 18 }}>
        <div className="gp-card-title">Mes dossiers</div>
        {!loading && cases.length === 0 && <p className="stk-empty">Aucun dossier pour l&apos;instant.</p>}
        <div className="sav-toggle-list">
          {cases.map((c) => {
            const sla = slaHoursLeft(c.slaDueAt, c.firstResponseAt, now);
            const open = openId === c.id;
            return (
              <article key={c.id} className="sav-toggle-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <button
                  type="button"
                  className="sav-inline"
                  style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", textAlign: "left", width: "100%" }}
                  onClick={() => setOpenId(open ? null : c.id)}
                  aria-expanded={open}
                >
                  <strong className="stk-ref">{c.ref}</strong>
                  <span className={`rt-badge rt-badge--${c.type === "GARANTIE" ? "violet" : "amber"}`}>{CASE_TYPE_LABEL[c.type]}</span>
                  <span style={{ flex: 1, minWidth: 160 }}>{c.designation}</span>
                  {c.laborAmount > 0 && <span className="sav-sub">M.O. {eur(c.laborAmount)}</span>}
                  <span className={`rt-badge rt-badge--${clientStatusTone(c.clientStatus)}`}>{CLIENT_STATUS_LABEL[c.clientStatus] ?? c.clientStatus}</span>
                  {sla != null && (
                    <span className={`rt-badge rt-badge--${sla < 0 ? "red" : "blue"}`}>
                      <Clock className="h-3.5 w-3.5" /> {sla < 0 ? "Réponse en retard" : `Réponse sous ${sla} h`}
                    </span>
                  )}
                  <ChevronDown className="h-4 w-4" style={{ transform: open ? "rotate(180deg)" : undefined }} />
                </button>

                {open && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
                    <p className="sav-sub">
                      Ouvert le {frDateTime(c.openedAt)}
                      {c.orderRef ? ` · commande ${c.orderRef}` : ""}
                      {c.immatriculation ? ` · ${c.immatriculation}` : ""}
                      {c.closedAt ? ` · clos le ${frDate(c.closedAt)}` : ""}
                    </p>
                    {c.description && <p className="od-note sav-description">{c.description}</p>}
                    {c.gestureType && c.gestureType !== "AUCUN" && (
                      <p className="nc-ok">
                        Geste commercial accordé : {GESTURE_LABEL[c.gestureType]?.toLowerCase()}
                        {c.gestureAmount != null ? ` de ${eur(c.gestureAmount)}` : ""}.
                      </p>
                    )}
                    {c.replacementGiven && <p className="nc-ok">Une pièce de remplacement vous a été remise en attendant la décision du fournisseur.</p>}
                    <ol className="sav-timeline">
                      {c.events.map((ev, i) => (
                        <li key={i} className={`sav-event sav-event--${ev.kind.toLowerCase()}`}>
                          <p className="sav-event-body">{ev.body}</p>
                          <p className="sav-sub">{frDateTime(ev.at)} · {ev.actor ?? "Magasin"}</p>
                        </li>
                      ))}
                    </ol>
                    <p className="sav-sub">{c.files.length} pièce(s) jointe(s) au dossier.</p>
                    {!c.closedAt && (
                      <>
                        <textarea className="gp-textarea" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Ajouter une précision pour le magasin…" />
                        <div className="sav-flow-actions">
                          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" hidden onChange={(e) => void upload(c.id, e.target.files?.[0])} />
                          <button type="button" className="od-btn od-btn--ghost" disabled={saving} onClick={() => fileInput.current?.click()}>
                            <Camera className="h-4 w-4" /> Photo / facture de pose
                          </button>
                          <button type="button" className="od-btn od-btn--outline" disabled={saving || !reply.trim()} onClick={() => void sendReply(c.id)}>
                            <Send className="h-4 w-4" /> Envoyer
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
