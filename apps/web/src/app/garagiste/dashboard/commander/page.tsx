"use client";

import { Check, Loader2, Plus, ShoppingCart, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createGarageOrder, type NewOrderLine } from "@/lib/data/garage";

const emptyLine: NewOrderLine = { nom_produit: "", reference: "", quantity: 1 };

export default function CommanderPage() {
  const { supabase, profile } = useAuth();
  const [immatriculation, setImmatriculation] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<NewOrderLine[]>([{ ...emptyLine }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRef, setCreatedRef] = useState<string | null>(null);

  function setLine(i: number, field: keyof NewOrderLine, value: string | number) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, [field]: value } : l)));
  }
  const addLine = () => setLines((prev) => [...prev, { ...emptyLine }]);
  const removeLine = (i: number) => setLines((prev) => prev.filter((_, idx) => idx !== i));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.client_id || !profile.organization_id || !profile.user_id) return;
    const valid = lines.filter((l) => l.nom_produit.trim() && l.reference.trim());
    if (valid.length === 0) {
      setError("Ajoutez au moins une pièce (désignation + référence).");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const order = await createGarageOrder(
        supabase,
        profile.user_id,
        profile.organization_id,
        profile.client_id,
        { phone: null, immatriculation, vehicle, note, lines: valid },
      );
      setCreatedRef(order.ref_demande);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setImmatriculation("");
    setVehicle("");
    setNote("");
    setLines([{ ...emptyLine }]);
    setError(null);
    setCreatedRef(null);
  }

  if (createdRef) {
    return (
      <div className="gp-page">
        <div className="gp-soon">
          <span className="gp-success-icon"><Check className="h-7 w-7" /></span>
          <h1 className="gp-title" style={{ marginTop: 12 }}>Commande envoyée</h1>
          <p className="gp-subtitle">
            Votre commande <strong>{createdRef}</strong> a bien été transmise à votre
            magasin. Suivez son état dans « Mes commandes ».
          </p>
          <div className="gp-success-actions">
            <button type="button" className="od-btn od-btn--primary" onClick={reset}>
              <Plus className="h-4 w-4" /> Nouvelle commande
            </button>
            <Link href="/garagiste/dashboard/commandes" className="od-btn od-btn--ghost">
              Mes commandes
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gp-page">
      <header className="gp-header">
        <h1 className="gp-title">Commander des pièces</h1>
        <p className="gp-subtitle">
          Indiquez les pièces souhaitées. Votre magasin les prépare et fixe les prix.
        </p>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <form onSubmit={submit} className="gp-form">
        <section className="gp-card">
          <div className="gp-card-title">Véhicule (optionnel)</div>
          <div className="gp-grid-2">
            <div className="od-field">
              <span className="od-label">Immatriculation</span>
              <input className="od-input" placeholder="AA-123-BB" value={immatriculation} onChange={(e) => setImmatriculation(e.target.value)} />
            </div>
            <div className="od-field">
              <span className="od-label">Véhicule</span>
              <input className="od-input" placeholder="Renault Clio IV" value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
            </div>
          </div>
        </section>

        <section className="gp-card">
          <div className="gp-card-title">Pièces</div>
          <div className="gp-lines">
            {lines.map((l, i) => (
              <div key={i} className="gp-line">
                <div className="od-field gp-line-desig">
                  <span className="od-label">Désignation</span>
                  <input className="od-input" placeholder="Plaquettes de frein avant" value={l.nom_produit} onChange={(e) => setLine(i, "nom_produit", e.target.value)} />
                </div>
                <div className="od-field gp-line-ref">
                  <span className="od-label">Référence</span>
                  <input className="od-input" placeholder="GDB1330" value={l.reference} onChange={(e) => setLine(i, "reference", e.target.value)} />
                </div>
                <div className="od-field gp-line-qty">
                  <span className="od-label">Qté</span>
                  <input className="od-input" type="number" min={1} value={l.quantity || ""} onChange={(e) => setLine(i, "quantity", Number(e.target.value))} />
                </div>
                <button type="button" className="gp-line-del" onClick={() => removeLine(i)} disabled={lines.length === 1} aria-label="Supprimer">
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <button type="button" className="gp-add-line" onClick={addLine}>
            <Plus className="h-4 w-4" /> Ajouter une pièce
          </button>
        </section>

        <section className="gp-card">
          <div className="gp-card-title">Note (optionnel)</div>
          <textarea className="gp-textarea" rows={3} placeholder="Précisions pour le magasin…" value={note} onChange={(e) => setNote(e.target.value)} />
        </section>

        <div className="gp-form-actions">
          <button type="submit" className="od-btn od-btn--primary" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <ShoppingCart className="h-4 w-4" />}
            {saving ? "Envoi…" : "Envoyer la commande"}
          </button>
        </div>
      </form>
    </div>
  );
}
