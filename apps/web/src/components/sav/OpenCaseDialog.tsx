"use client";

import { Check, Loader2, Scale, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { WarrantyLight } from "@/components/sav/WarrantyLight";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney } from "@/lib/data/saas";
import { openSavCase } from "@/lib/data/sav";
import { PART_LOCATION_LABEL, laborAmount, presumptionApplies, type LineWarranty } from "@/lib/sav";

/**
 * Ouvrir un dossier SAV (garantie ou litige) sans ressaisie : la vente, le
 * retour ou la commande d'origine pré-remplissent tout ce qui est connu.
 * Used from the carnet véhicule, the order detail, « Retours » and the SAV page.
 */
export type OpenCasePreset = {
  type?: "GARANTIE" | "LITIGE";
  orderLineId?: string | null;
  orderId?: string | null;
  clientId?: string | null;
  returnId?: string | null;
  designation?: string | null;
  reference?: string | null;
  immatriculation?: string | null;
  serialNumber?: string | null;
  garagePoseur?: string | null;
  kmMontage?: number | null;
  description?: string | null;
  clientName?: string | null;
  orderRef?: string | null;
  warranty?: LineWarranty | null;
  /** Where the part is when the dialog opens (a return is already at the counter). */
  partLocation?: string | null;
};

type DialogProps = {
  preset: OpenCasePreset | null;
  onClose: () => void;
  onCreated: (caseId: string) => void;
};

/** Mounted only while a preset is set, so every opening starts from a fresh form. */
export function OpenCaseDialog({ preset, onClose, onCreated }: DialogProps) {
  if (!preset) return null;
  return <OpenCaseForm preset={preset} onClose={onClose} onCreated={onCreated} />;
}

function OpenCaseForm({ preset, onClose, onCreated }: DialogProps & { preset: OpenCasePreset }) {
  const [type, setType] = useState<"GARANTIE" | "LITIGE">(preset.type ?? "GARANTIE");
  const [designation, setDesignation] = useState(preset.designation ?? "");
  const [plate, setPlate] = useState(preset.immatriculation ?? "");
  const [description, setDescription] = useState(preset.description ?? "");
  const [kmMontage, setKmMontage] = useState(preset.kmMontage != null ? String(preset.kmMontage) : "");
  const [kmPanne, setKmPanne] = useState("");
  const [poseur, setPoseur] = useState(preset.garagePoseur ?? "");
  const [poseInvoice, setPoseInvoice] = useState("");
  const [serial, setSerial] = useState(preset.serialNumber ?? "");
  const [rate, setRate] = useState("");
  const [hours, setHours] = useState("");
  const [location, setLocation] = useState(preset.partLocation ?? (preset.returnId ? "MAGASIN" : "CLIENT"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromSale = Boolean(preset.orderLineId);
  const toNum = (v: string): number | null => {
    const n = Number(v.replace(",", "."));
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
  };

  const submit = async () => {
    if (!designation.trim()) return setError("Indiquez la pièce concernée.");
    if (!description.trim()) return setError("Décrivez le problème : c'est ce que le fournisseur lira en premier.");
    setBusy(true);
    setError(null);
    try {
      const id = await openSavCase(createClient(), {
        type,
        orderLineId: preset.orderLineId,
        orderId: preset.orderId,
        clientId: preset.clientId,
        returnId: preset.returnId,
        designation: designation.trim(),
        reference: preset.reference,
        immatriculation: plate.trim() || null,
        description: description.trim(),
        kmMontage: toNum(kmMontage),
        kmPanne: toNum(kmPanne),
        garagePoseur: poseur.trim() || null,
        poseInvoiceRef: poseInvoice.trim() || null,
        serialNumber: serial.trim() || null,
        laborRate: toNum(rate),
        laborHours: toNum(hours),
        partLocation: location,
      });
      onCreated(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ga-modal-overlay" onClick={() => !busy && onClose()}>
      <div className="ga-modal ga-modal--wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title">
            {type === "GARANTIE" ? <ShieldCheck className="h-4 w-4" /> : <Scale className="h-4 w-4" />} Ouvrir un dossier
            {preset.orderRef ? ` — ${preset.orderRef}` : ""}
          </span>
          <button type="button" className="ga-modal-close" onClick={onClose} aria-label="Fermer" disabled={busy}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <form
          className="ga-modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {error && <div className="nc-error">{error}</div>}

          <div className="od-toggle-group">
            <button type="button" className={`od-toggle${type === "GARANTIE" ? " od-toggle--on" : ""}`} onClick={() => setType("GARANTIE")}>
              <ShieldCheck className="h-5 w-5" />
              <span>
                <strong>Garantie</strong>
                <em>Pièce tombée en panne — dossier client + dossier fournisseur</em>
              </span>
            </button>
            <button type="button" className={`od-toggle${type === "LITIGE" ? " od-toggle--on" : ""}`} onClick={() => setType("LITIGE")}>
              <Scale className="h-5 w-5" />
              <span>
                <strong>Litige</strong>
                <em>Mauvaise pièce, main d&apos;œuvre perdue, geste commercial</em>
              </span>
            </button>
          </div>

          {preset.warranty && type === "GARANTIE" && (
            <>
              <WarrantyLight warranty={preset.warranty} />
              {presumptionApplies(preset.warranty) && (
                <p className="sav-hint">
                  Moins de 24 mois : le défaut est présumé exister à la délivrance. C&apos;est au vendeur de prouver le contraire — et
                  l&apos;interlocuteur du client, c&apos;est le magasin, pas l&apos;équipementier.
                </p>
              )}
            </>
          )}

          <div className="ga-modal-row">
            <label className="od-field">
              <span className="od-label">Pièce</span>
              <input className="od-input" value={designation} onChange={(e) => setDesignation(e.target.value)} readOnly={fromSale} placeholder="Alternateur 120 A" />
            </label>
            <label className="od-field">
              <span className="od-label">Immatriculation</span>
              <input className="od-input" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} placeholder="AB-123-CD" />
            </label>
          </div>
          {preset.clientName && <p className="st-cmd-hint">Client : {preset.clientName}</p>}

          <label className="od-field">
            <span className="od-label">
              Problème constaté <span className="od-req">*</span>
            </span>
            <textarea
              className="od-input sav-textarea"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={type === "GARANTIE" ? "Ne charge plus après 4 mois, voyant batterie allumé…" : "Pompe à eau non conforme, 2 h de main d'œuvre perdues…"}
            />
          </label>

          {type === "GARANTIE" ? (
            <>
              <div className="ga-modal-row">
                <label className="od-field">
                  <span className="od-label">Km au montage</span>
                  <input className="od-input" inputMode="numeric" value={kmMontage} onChange={(e) => setKmMontage(e.target.value)} placeholder="120 000" />
                </label>
                <label className="od-field">
                  <span className="od-label">Km à la panne</span>
                  <input className="od-input" inputMode="numeric" value={kmPanne} onChange={(e) => setKmPanne(e.target.value)} placeholder="124 500" />
                </label>
                <label className="od-field">
                  <span className="od-label">N° de série</span>
                  <input className="od-input" value={serial} onChange={(e) => setSerial(e.target.value)} />
                </label>
              </div>
              <div className="ga-modal-row">
                <label className="od-field">
                  <span className="od-label">Garage qui a monté</span>
                  <input className="od-input" value={poseur} onChange={(e) => setPoseur(e.target.value)} placeholder="Garage du Centre" />
                </label>
                <label className="od-field">
                  <span className="od-label">Facture de pose</span>
                  <input className="od-input" value={poseInvoice} onChange={(e) => setPoseInvoice(e.target.value)} placeholder="N° de facture" />
                </label>
              </div>
            </>
          ) : (
            <div className="ga-modal-row">
              <label className="od-field">
                <span className="od-label">Taux horaire du garage (€ HT)</span>
                <input className="od-input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="65" />
              </label>
              <label className="od-field">
                <span className="od-label">Temps barémé perdu (h)</span>
                <input className="od-input" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="2" />
              </label>
              <div className="od-field">
                <span className="od-label">Main d&apos;œuvre réclamée</span>
                <p className="sav-amount">{fmtMoney(laborAmount(toNum(rate), toNum(hours)))}</p>
              </div>
            </div>
          )}

          <label className="od-field">
            <span className="od-label">Où est la pièce ?</span>
            <select className="od-input" value={location} onChange={(e) => setLocation(e.target.value)}>
              {Object.entries(PART_LOCATION_LABEL).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <div className="ga-modal-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" className="od-btn od-btn--primary" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
              {busy ? "Ouverture…" : "Ouvrir le dossier"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
