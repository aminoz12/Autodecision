"use client";

import {
  ArrowLeft,
  Camera,
  Check,
  ChevronRight,
  HandCoins,
  Loader2,
  Mail,
  MapPin,
  MessageSquareText,
  Paperclip,
  Scale,
  Send,
  ShieldCheck,
  Truck,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WarrantyLight } from "@/components/sav/WarrantyLight";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtDateTime, fmtMoney, loadSupplierOptions, type SupplierOption } from "@/lib/data/saas";
import {
  SavUnavailableError,
  addSavCaseFile,
  addSavCaseNote,
  loadSavCase,
  recordSavGesture,
  updateSavCase,
  type SavCaseDetail,
  type SavCasePatch,
} from "@/lib/data/sav";
import {
  CASE_TYPE_LABEL,
  CLIENT_STATUSES,
  CLIENT_STATUS_LABEL,
  GESTURE_BUDGET_LABEL,
  GESTURE_LABEL,
  PART_LOCATION_LABEL,
  SUPPLIER_STATUSES,
  SUPPLIER_STATUS_LABEL,
  clientStatusTone,
  familyLabel,
  laborAmount,
  lineWarranty,
  slaHoursLeft,
  supplierStatusTone,
} from "@/lib/sav";

const FILE_KIND_LABEL: Record<string, string> = {
  DEFAUT: "Photo du défaut",
  PIECE: "Photo de la pièce",
  FACTURE_POSE: "Facture de pose",
  COEUR: "Cœur consigné",
  AUTRE: "Autre",
};

const toNum = (v: string): number | null => {
  const n = Number(v.replace(",", ".").replace(/\s/g, ""));
  return v.trim() !== "" && Number.isFinite(n) ? n : null;
};

export default function SavCasePage() {
  const { profile } = useAuth();
  const params = useParams<{ id: string }>();
  const caseId = params?.id ?? "";
  const [detail, setDetail] = useState<SavCaseDetail | null>(null);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now] = useState(() => new Date());

  // Editable fields (saved explicitly — a status change is one click).
  const [form, setForm] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [noteVisible, setNoteVisible] = useState(false);
  const [gestureType, setGestureType] = useState("AVOIR");
  const [gestureAmount, setGestureAmount] = useState("");
  const [gestureBudget, setGestureBudget] = useState("MAGASIN");
  const [gestureNote, setGestureNote] = useState("");
  const [gestureCredit, setGestureCredit] = useState(true);
  const [fileKind, setFileKind] = useState("DEFAUT");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !caseId) return;
    setError(null);
    try {
      const sb = createClient();
      const [d, s] = await Promise.all([loadSavCase(sb, caseId), loadSupplierOptions(sb, profile.organization_id)]);
      setDetail(d);
      setSuppliers(s);
      if (d) {
        const c = d.case;
        setForm({
          supplier_id: c.supplierId ?? "",
          supplier_case_number: c.supplierCaseNumber ?? "",
          supplier_credit_amount: c.supplierCreditAmount != null ? String(c.supplierCreditAmount) : "",
          km_montage: c.kmMontage != null ? String(c.kmMontage) : "",
          km_panne: c.kmPanne != null ? String(c.kmPanne) : "",
          garage_poseur: c.garagePoseur ?? "",
          pose_invoice_ref: c.poseInvoiceRef ?? "",
          serial_number: c.serialNumber ?? "",
          marque: c.marque ?? "",
          part_location_note: c.partLocationNote ?? "",
          replacement_note: c.replacementNote ?? "",
          labor_rate: c.laborRate != null ? String(c.laborRate) : "",
          labor_hours: c.laborHours != null ? String(c.laborHours) : "",
          resolution_note: c.resolutionNote ?? "",
        });
      }
    } catch (e) {
      setError(e instanceof SavUnavailableError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id, caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback(
    async (key: string, p: SavCasePatch, done?: string) => {
      setBusy(key);
      setError(null);
      try {
        await updateSavCase(createClient(), caseId, p);
        if (done) setNotice(done);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [caseId, load],
  );

  const c = detail?.case ?? null;
  const warranty = useMemo(() => (c ? lineWarranty({ start: c.purchaseDate, warrantyMonths: c.lineWarrantyMonths, extensionMonths: c.lineExtensionMonths }) : null), [c]);
  const sla = c ? slaHoursLeft(c.slaDueAt, c.firstResponseAt, now) : null;
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (loading) return <div className="od-page"><p className="text-muted">Chargement…</p></div>;
  if (!c) {
    return (
      <div className="od-page">
        {error && <div className="nc-error">{error}</div>}
        <p className="text-muted">Dossier introuvable.</p>
        <Link href="/dashboard/sav" className="od-btn od-btn--ghost"><ArrowLeft className="h-4 w-4" /> Retour à l&apos;après-vente</Link>
      </div>
    );
  }

  const saveDossier = () =>
    patch(
      "dossier",
      {
        km_montage: toNum(form.km_montage ?? ""),
        km_panne: toNum(form.km_panne ?? ""),
        garage_poseur: form.garage_poseur || null,
        pose_invoice_ref: form.pose_invoice_ref || null,
        serial_number: form.serial_number || null,
        marque: form.marque || null,
        labor_rate: toNum(form.labor_rate ?? ""),
        labor_hours: toNum(form.labor_hours ?? ""),
        resolution_note: form.resolution_note || null,
      },
      "Dossier enregistré.",
    );

  const saveSupplier = () =>
    patch(
      "supplier",
      {
        supplier_id: form.supplier_id || null,
        supplier_case_number: form.supplier_case_number || null,
        supplier_credit_amount: toNum(form.supplier_credit_amount ?? ""),
      },
      "Côté fournisseur enregistré.",
    );

  const submitNote = async () => {
    if (!note.trim()) return;
    setBusy("note");
    try {
      await addSavCaseNote(createClient(), caseId, note.trim(), noteVisible);
      setNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submitGesture = async () => {
    setBusy("gesture");
    setError(null);
    try {
      const num = await recordSavGesture(createClient(), {
        caseId,
        type: gestureType,
        amount: gestureType === "AUCUN" ? null : toNum(gestureAmount),
        budget: gestureType === "AUCUN" ? null : gestureBudget,
        note: gestureNote.trim() || null,
        createCredit: gestureType === "AVOIR" && gestureCredit,
      });
      setNotice(num ? `Geste enregistré — avoir ${num} émis.` : "Geste commercial enregistré.");
      setGestureAmount("");
      setGestureNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file || !profile?.organization_id) return;
    setBusy("file");
    setError(null);
    try {
      await addSavCaseFile(createClient(), profile.organization_id, caseId, file, fileKind, null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  // Relance manuelle : le même texte que la relance automatique, prêt à partir.
  const reminderMailto = (() => {
    if (!c.supplierEmail) return null;
    const subject = `Relance garantie ${c.supplierCaseNumber ?? c.ref}`;
    const body = [
      "Bonjour,",
      "",
      `Nous restons sans réponse sur le dossier de garantie${c.supplierDeclaredAt ? ` déclaré le ${fmtDate(c.supplierDeclaredAt)}` : ""}.`,
      c.supplierCaseNumber ? `Votre n° de dossier : ${c.supplierCaseNumber}` : "",
      `Notre référence : ${c.ref}`,
      `Pièce : ${c.designation}${c.reference ? ` (réf. ${c.reference})` : ""}${c.serialNumber ? ` — n° de série ${c.serialNumber}` : ""}`,
      "",
      "Merci de nous indiquer votre décision.",
    ]
      .filter((l) => l !== "")
      .join("\n");
    return `mailto:${c.supplierEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  })();

  const TypeIcon = c.type === "GARANTIE" ? ShieldCheck : Scale;
  const labor = laborAmount(toNum(form.labor_rate ?? ""), toNum(form.labor_hours ?? ""));

  return (
    <div className="od-page">
      <nav className="od-breadcrumb">
        <Link href="/dashboard/sav">Après-vente</Link>
        <span className="od-breadcrumb-sep"><ChevronRight className="h-3.5 w-3.5" /></span>
        <span className="od-breadcrumb-current">{c.ref}</span>
      </nav>

      <div className="od-title-row">
        <div>
          <h1 className="od-title">
            <TypeIcon className="h-6 w-6" /> {CASE_TYPE_LABEL[c.type]} {c.ref}
          </h1>
          <p className="rl-subtitle">
            {c.designation}
            {c.reference ? ` · ${c.reference}` : ""} · ouvert le {fmtDateTime(c.openedAt)}
            {c.origin === "GARAGE" ? " par le garage" : " au comptoir"}
            {c.closedAt ? ` · clos le ${fmtDate(c.closedAt)}` : ""}
          </p>
        </div>
        <div className="od-title-actions">
          {sla != null && (
            <span className={`rt-badge rt-badge--${sla < 0 ? "red" : sla <= 12 ? "amber" : "blue"}`}>
              {sla < 0 ? `Délai de réponse dépassé de ${-sla} h` : `Réponse attendue sous ${sla} h`}
            </span>
          )}
          {c.closedAt && <span className="rt-badge rt-badge--gray">Dossier clos</span>}
        </div>
      </div>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      <div className="sav-case-grid">
        <div className="sav-case-main">
          {/* ---------------- Côté client ---------------- */}
          <section className="od-card sav-flow sav-flow--client">
            <h2 className="od-card-title">Côté client — {c.clientName}</h2>
            <p className="sav-sub">Le client n&apos;a rien à régler avec l&apos;équipementier : son interlocuteur, c&apos;est le magasin.</p>
            <div className="sav-steps" role="radiogroup" aria-label="Statut côté client">
              {CLIENT_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={c.clientStatus === s}
                  disabled={busy !== null}
                  className={`sav-step${c.clientStatus === s ? ` sav-step--on sav-step--${clientStatusTone(s)}` : ""}`}
                  onClick={() => c.clientStatus !== s && void patch("client", { client_status: s })}
                >
                  {CLIENT_STATUS_LABEL[s]}
                </button>
              ))}
            </div>

            <div className={`sav-replacement${c.replacementGiven ? " sav-replacement--on" : ""}`}>
              <Wrench className="h-5 w-5" />
              <div className="sav-replacement-text">
                <strong>Dépannage immédiat</strong>
                <span>
                  {c.replacementGiven
                    ? `Pièce de remplacement remise le ${fmtDate(c.replacementAt)} — le dossier fournisseur reste ouvert derrière.`
                    : "Un client immobilisé ne peut pas attendre six semaines : donnez la pièce, gardez le dossier fournisseur ouvert."}
                </span>
                <input
                  className="od-input"
                  placeholder="Pièce remise, n° de commande de remplacement…"
                  value={form.replacement_note ?? ""}
                  onChange={set("replacement_note")}
                />
              </div>
              <button
                type="button"
                className={`od-btn ${c.replacementGiven ? "od-btn--ghost" : "od-btn--primary"}`}
                disabled={busy !== null}
                onClick={() =>
                  void patch(
                    "replacement",
                    { replacement_given: !c.replacementGiven, replacement_note: form.replacement_note || null },
                    c.replacementGiven ? "Dépannage annulé." : "Dépannage tracé.",
                  )
                }
              >
                {c.replacementGiven ? "Annuler" : "Client dépanné"}
              </button>
            </div>
          </section>

          {/* ---------------- Côté fournisseur ---------------- */}
          <section className="od-card sav-flow sav-flow--supplier">
            <h2 className="od-card-title">
              <Truck className="h-4 w-4" /> Côté fournisseur
              {c.supplierStatus && (
                <span className={`rt-badge rt-badge--${supplierStatusTone(c.supplierStatus)}`}>{SUPPLIER_STATUS_LABEL[c.supplierStatus]}</span>
              )}
            </h2>
            <div className="sav-steps" role="radiogroup" aria-label="Statut côté fournisseur">
              {SUPPLIER_STATUSES.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={c.supplierStatus === s}
                  disabled={busy !== null}
                  className={`sav-step${c.supplierStatus === s ? ` sav-step--on sav-step--${supplierStatusTone(s)}` : ""}`}
                  onClick={() => c.supplierStatus !== s && void patch("supplier-status", { supplier_status: s })}
                >
                  {SUPPLIER_STATUS_LABEL[s]}
                </button>
              ))}
              {c.supplierStatus && (
                <button type="button" className="sav-step" disabled={busy !== null} onClick={() => void patch("supplier-status", { supplier_status: null })}>
                  Non concerné
                </button>
              )}
            </div>
            <div className="ga-modal-row">
              <label className="od-field">
                <span className="od-label">Fournisseur</span>
                <select className="od-input" value={form.supplier_id ?? ""} onChange={set("supplier_id")}>
                  <option value="">— à préciser —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="od-field">
                <span className="od-label">N° de dossier fournisseur</span>
                <input className="od-input" value={form.supplier_case_number ?? ""} onChange={set("supplier_case_number")} placeholder="ACR-2291" />
              </label>
              <label className="od-field">
                <span className="od-label">Avoir reçu (€)</span>
                <input className="od-input" inputMode="decimal" value={form.supplier_credit_amount ?? ""} onChange={set("supplier_credit_amount")} />
              </label>
            </div>
            <div className="sav-flow-foot">
              <p className="sav-sub">
                {c.supplierDeclaredAt ? `Déclaré le ${fmtDate(c.supplierDeclaredAt)}` : "Pas encore déclaré"}
                {c.supplierAnsweredAt ? ` · réponse le ${fmtDate(c.supplierAnsweredAt)}` : ""}
                {c.supplierReminderCount > 0 ? ` · ${c.supplierReminderCount} relance(s), la dernière le ${fmtDate(c.supplierLastReminderAt)}` : ""}
                {!c.supplierAnsweredAt && c.supplierDeclaredAt ? " · relance automatique à J+15 sans réponse" : ""}
              </p>
              <div className="sav-flow-actions">
                {reminderMailto ? (
                  <a className="od-btn od-btn--ghost" href={reminderMailto}>
                    <Mail className="h-4 w-4" /> Relancer par e-mail
                  </a>
                ) : (
                  <Link className="sav-sub sav-link" href="/dashboard/fournisseurs">Ajouter l&apos;e-mail SAV du fournisseur</Link>
                )}
                <button type="button" className="od-btn od-btn--outline" disabled={busy !== null} onClick={() => void saveSupplier()}>
                  {busy === "supplier" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Enregistrer
                </button>
              </div>
            </div>
          </section>

          {/* ---------------- Le dossier ---------------- */}
          <section className="od-card">
            <h2 className="od-card-title">{c.type === "GARANTIE" ? "Pièces du dossier garantie" : "Chiffrage du litige"}</h2>
            {c.description && <p className="od-note sav-description">{c.description}</p>}
            {c.type === "GARANTIE" ? (
              <>
                <div className="ga-modal-row">
                  <label className="od-field">
                    <span className="od-label">Km au montage</span>
                    <input className="od-input" inputMode="numeric" value={form.km_montage ?? ""} onChange={set("km_montage")} />
                  </label>
                  <label className="od-field">
                    <span className="od-label">Km à la panne</span>
                    <input className="od-input" inputMode="numeric" value={form.km_panne ?? ""} onChange={set("km_panne")} />
                  </label>
                  <label className="od-field">
                    <span className="od-label">Parcourus</span>
                    <p className="sav-amount">
                      {toNum(form.km_montage ?? "") != null && toNum(form.km_panne ?? "") != null
                        ? `${((toNum(form.km_panne ?? "") ?? 0) - (toNum(form.km_montage ?? "") ?? 0)).toLocaleString("fr-FR")} km`
                        : "—"}
                    </p>
                  </label>
                </div>
                <div className="ga-modal-row">
                  <label className="od-field">
                    <span className="od-label">Garage qui a monté</span>
                    <input className="od-input" value={form.garage_poseur ?? ""} onChange={set("garage_poseur")} />
                  </label>
                  <label className="od-field">
                    <span className="od-label">Facture de pose</span>
                    <input className="od-input" value={form.pose_invoice_ref ?? ""} onChange={set("pose_invoice_ref")} />
                  </label>
                </div>
                <div className="ga-modal-row">
                  <label className="od-field">
                    <span className="od-label">Marque</span>
                    <input className="od-input" value={form.marque ?? ""} onChange={set("marque")} placeholder="Bosch, Valeo…" />
                  </label>
                  <label className="od-field">
                    <span className="od-label">N° de série</span>
                    <input className="od-input" value={form.serial_number ?? ""} onChange={set("serial_number")} />
                  </label>
                </div>
              </>
            ) : (
              <div className="ga-modal-row">
                <label className="od-field">
                  <span className="od-label">Taux horaire du garage (€ HT)</span>
                  <input className="od-input" inputMode="decimal" value={form.labor_rate ?? ""} onChange={set("labor_rate")} />
                </label>
                <label className="od-field">
                  <span className="od-label">Temps barémé perdu (h)</span>
                  <input className="od-input" inputMode="decimal" value={form.labor_hours ?? ""} onChange={set("labor_hours")} />
                </label>
                <div className="od-field">
                  <span className="od-label">Main d&apos;œuvre réclamée</span>
                  <p className="sav-amount">{fmtMoney(labor)}</p>
                </div>
              </div>
            )}
            <label className="od-field">
              <span className="od-label">Conclusion</span>
              <textarea className="od-input sav-textarea" rows={2} value={form.resolution_note ?? ""} onChange={set("resolution_note")} placeholder="Ce qui a été décidé, et pourquoi." />
            </label>
            <div className="sav-flow-actions">
              <button type="button" className="od-btn od-btn--outline" disabled={busy !== null} onClick={() => void saveDossier()}>
                {busy === "dossier" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Enregistrer le dossier
              </button>
            </div>
          </section>

          {/* ---------------- Geste commercial ---------------- */}
          <section className="od-card">
            <h2 className="od-card-title"><HandCoins className="h-4 w-4" /> Geste commercial</h2>
            {c.gestureType ? (
              <p className="od-note">
                <strong>{GESTURE_LABEL[c.gestureType] ?? c.gestureType}</strong>
                {c.gestureAmount != null ? ` de ${fmtMoney(c.gestureAmount)}` : ""}
                {c.gestureBudget ? ` — ${GESTURE_BUDGET_LABEL[c.gestureBudget]?.toLowerCase()}` : ""}, accordé le {fmtDate(c.gestureAt)}.
                {c.gestureNote ? ` ${c.gestureNote}` : ""}
                {c.creditNoteId && (
                  <>
                    {" "}
                    <Link className="sav-link" href="/dashboard/avoirs">Voir l&apos;avoir</Link>
                  </>
                )}
              </p>
            ) : (
              <p className="sav-sub">Rien n&apos;a encore été accordé. Tracez le montant, la forme, et l&apos;enveloppe sur laquelle il s&apos;impute.</p>
            )}
            {!c.creditNoteId && (
              <>
                <div className="ga-modal-row">
                  <label className="od-field">
                    <span className="od-label">Forme</span>
                    <select className="od-input" value={gestureType} onChange={(e) => setGestureType(e.target.value)}>
                      {Object.entries(GESTURE_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </label>
                  {gestureType !== "AUCUN" && (
                    <>
                      <label className="od-field">
                        <span className="od-label">Montant (€)</span>
                        <input
                          className="od-input"
                          inputMode="decimal"
                          value={gestureAmount}
                          onChange={(e) => setGestureAmount(e.target.value)}
                          placeholder={c.laborAmount > 0 ? String(c.laborAmount) : ""}
                        />
                      </label>
                      <label className="od-field">
                        <span className="od-label">Enveloppe</span>
                        <select className="od-input" value={gestureBudget} onChange={(e) => setGestureBudget(e.target.value)}>
                          {Object.entries(GESTURE_BUDGET_LABEL).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                          ))}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                <label className="od-field">
                  <span className="od-label">Pourquoi</span>
                  <input className="od-input" value={gestureNote} onChange={(e) => setGestureNote(e.target.value)} placeholder="2 h de main d'œuvre perdues, client fidèle…" />
                </label>
                {gestureType === "AVOIR" && c.clientId && (
                  <label className="sav-check">
                    <input type="checkbox" checked={gestureCredit} onChange={(e) => setGestureCredit(e.target.checked)} />
                    Émettre l&apos;avoir maintenant (valable 1 an, visible sur la fiche du client)
                  </label>
                )}
                <div className="sav-flow-actions">
                  <button type="button" className="od-btn od-btn--primary" disabled={busy !== null} onClick={() => void submitGesture()}>
                    {busy === "gesture" ? <Loader2 className="h-4 w-4 nc-spin" /> : <HandCoins className="h-4 w-4" />} Accorder
                  </button>
                </div>
              </>
            )}
          </section>
        </div>

        {/* ---------------- Colonne de droite ---------------- */}
        <aside className="sav-case-side">
          <section className="od-card">
            <h2 className="od-card-title">La vente</h2>
            {c.type === "GARANTIE" && <WarrantyLight warranty={warranty} />}
            <dl className="od-kv">
              <div className="od-kv-row"><dt>Client</dt><dd>{c.clientId ? <Link className="sav-link" href={c.isGarage ? `/dashboard/garages/${c.clientId}` : `/dashboard/clients/${c.clientId}`}>{c.clientName}</Link> : c.clientName}</dd></div>
              {c.orderId && <div className="od-kv-row"><dt>Commande</dt><dd><Link className="sav-link" href={`/dashboard/commandes/${c.orderId}`}>{c.orderRef ?? "Voir"}</Link></dd></div>}
              <div className="od-kv-row"><dt>Achetée le</dt><dd>{fmtDate(c.purchaseDate)}</dd></div>
              {c.immatriculation && <div className="od-kv-row"><dt>Véhicule</dt><dd><Link className="sav-link" href={`/dashboard/vehicules?q=${encodeURIComponent(c.immatriculation)}`}>{c.immatriculation}</Link></dd></div>}
              <div className="od-kv-row"><dt>Famille</dt><dd>{familyLabel(c.famille)}</dd></div>
              {c.partValue != null && <div className="od-kv-row"><dt>Valeur de la pièce</dt><dd className="od-kv-strong">{fmtMoney(c.partValue)}</dd></div>}
              {c.returnId && <div className="od-kv-row"><dt>Origine</dt><dd><Link className="sav-link" href="/dashboard/retours">Issu d&apos;un retour</Link></dd></div>}
            </dl>
          </section>

          <section className="od-card">
            <h2 className="od-card-title"><MapPin className="h-4 w-4" /> Où est la pièce défectueuse ?</h2>
            <div className="sav-steps sav-steps--wrap">
              {Object.entries(PART_LOCATION_LABEL).map(([code, label]) => (
                <button
                  key={code}
                  type="button"
                  disabled={busy !== null}
                  className={`sav-step${c.partLocation === code ? " sav-step--on sav-step--blue" : ""}`}
                  onClick={() => c.partLocation !== code && void patch("location", { part_location: code, part_location_note: form.part_location_note || null })}
                >
                  {label}
                </button>
              ))}
            </div>
            <input className="od-input" value={form.part_location_note ?? ""} onChange={set("part_location_note")} placeholder="Partie par la tournée du 12/09, bon n° 1842…" />
          </section>

          <section className="od-card">
            <h2 className="od-card-title"><Camera className="h-4 w-4" /> Photos et justificatifs</h2>
            <div className="sav-files">
              {detail?.files.map((f) => (
                <a key={f.id} className="sav-file" href={f.url ?? "#"} target="_blank" rel="noreferrer" title={f.caption ?? FILE_KIND_LABEL[f.kind]}>
                  {f.url && !f.path.endsWith(".pdf") ? (
                    // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URL
                    <img src={f.url} alt={FILE_KIND_LABEL[f.kind] ?? "Pièce jointe"} />
                  ) : (
                    <Paperclip className="h-5 w-5" />
                  )}
                  <span>{FILE_KIND_LABEL[f.kind] ?? f.kind}</span>
                </a>
              ))}
              {detail?.files.length === 0 && <p className="sav-sub">Une photo du défaut prise au comptoir vaut tous les échanges de mails.</p>}
            </div>
            <div className="sav-upload">
              <select className="od-input" value={fileKind} onChange={(e) => setFileKind(e.target.value)} aria-label="Type de pièce jointe">
                {Object.entries(FILE_KIND_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
              <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" hidden onChange={(e) => void upload(e.target.files?.[0])} />
              <button type="button" className="od-btn od-btn--outline" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
                {busy === "file" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Camera className="h-4 w-4" />} Ajouter
              </button>
            </div>
          </section>

          <section className="od-card">
            <h2 className="od-card-title"><MessageSquareText className="h-4 w-4" /> Journal du dossier</h2>
            <ol className="sav-timeline">
              {detail?.events.map((e) => (
                <li key={e.id} className={`sav-event sav-event--${e.kind.toLowerCase()}`}>
                  <p className="sav-event-body">{e.body}</p>
                  <p className="sav-sub">
                    {fmtDateTime(e.createdAt)} · {e.actor ?? "Système"}
                    {e.visibleToClient && c.isGarage ? " · visible par le garage" : ""}
                    {e.emailTo ? (e.emailSentAt && !e.emailError ? ` · e-mail envoyé à ${e.emailTo}` : e.emailError === "NO_PROVIDER" ? " · e-mail non configuré" : " · e-mail en attente") : ""}
                  </p>
                </li>
              ))}
            </ol>
            <textarea className="od-input sav-textarea" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ajouter une note au dossier…" />
            <div className="sav-flow-foot">
              {c.isGarage ? (
                <label className="sav-check">
                  <input type="checkbox" checked={noteVisible} onChange={(e) => setNoteVisible(e.target.checked)} /> Visible par le garage
                </label>
              ) : (
                <span />
              )}
              <button type="button" className="od-btn od-btn--outline" disabled={busy !== null || !note.trim()} onClick={() => void submitNote()}>
                {busy === "note" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Send className="h-4 w-4" />} Ajouter
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
