"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Check, Loader2, PackageCheck, X } from "lucide-react";
import { useState } from "react";
import { deductionMessage, fmtMoney, loadDeduction, receiveGarageReturn } from "@/lib/data/saas";

/** What the dialog needs from a garage return waiting at the counter. */
export type ReceivableReturn = {
  id: string;
  ref: string;
  designation: string;
  quantity: number;
  /** Value of the returned units (quantity × unit price). */
  amount: number;
  orderId: string | null;
  orderRef: string | null;
  /** The livreur marked it collected. */
  legDone: boolean;
};

type Choice = "DEDUCTION" | "AVOIR" | "REMPLACEMENT";

const CHOICES: { id: Choice; label: string; hint: string }[] = [
  {
    id: "DEDUCTION",
    label: "Déduire de l'encours",
    hint: "Le montant est retiré de ce que le garage doit : cette commande d'abord, puis ses autres commandes à régler. S'il ne doit plus rien, le reste devient un avoir.",
  },
  { id: "AVOIR", label: "Faire un avoir", hint: "Un avoir du montant est créé ; il servira sur une prochaine commande ou se déduira plus tard depuis la fiche." },
  { id: "REMPLACEMENT", label: "Remplacement", hint: "La pièce a été échangée : rien ne change dans ce que le garage doit." },
];

/**
 * « Réceptionner » a return the garage asked for: the part is back on the shelf,
 * and the counter says what happens to the money (migration 20261005010000).
 */
export function ReceiveReturnDialog({
  ret,
  supabase,
  onClose,
  onDone,
}: {
  ret: ReceivableReturn;
  supabase: SupabaseClient;
  onClose: () => void;
  /** Called once received, with the sentence to show the cashier. */
  onDone: (message: string) => void;
}) {
  const [choice, setChoice] = useState<Choice>("DEDUCTION");
  const [amount, setAmount] = useState(ret.amount > 0 ? ret.amount.toFixed(2).replace(".", ",") : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = choice !== "REMPLACEMENT";
  const value = Math.round(Number(amount.replace(/\s/g, "").replace(",", ".")) * 100) / 100;

  async function submit() {
    if (money && !(value > 0)) {
      setError("Indiquez le montant à déduire.");
      return;
    }
    if (money && value > ret.amount + 0.005) {
      setError(`Le montant ne peut pas dépasser la valeur du retour (${fmtMoney(ret.amount)}).`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await receiveGarageReturn(supabase, ret.id, { compensation: choice, amount: money ? value : null });
      const head = `${ret.ref} réceptionné : ${ret.quantity} × ${ret.designation} de retour en stock.`;
      if (choice === "REMPLACEMENT") {
        onDone(`${head} Remplacement : rien ne change dans ce que le garage doit.`);
      } else if (choice === "AVOIR") {
        onDone(`${head} Avoir de ${fmtMoney(value)} créé.`);
      } else {
        // The credit note of this return is the newest one on its order.
        let num: string | null = null;
        if (ret.orderId) {
          const { data } = await supabase
            .from("credit_notes")
            .select("num")
            .eq("order_id", ret.orderId)
            .order("created_at", { ascending: false })
            .limit(1);
          num = (data?.[0] as { num?: string } | undefined)?.num ?? null;
        }
        onDone(`${head} ${deductionMessage(await loadDeduction(supabase, num))}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="ga-modal-overlay" onClick={() => !busy && onClose()}>
      <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="receive-return-title" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title" id="receive-return-title">
            <PackageCheck className="h-4 w-4" /> Réceptionner {ret.ref}
          </span>
          <button type="button" className="ga-modal-close" onClick={onClose} aria-label="Fermer" disabled={busy}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="ga-modal-form">
          <p className="st-cmd-hint">
            {ret.quantity} × {ret.designation}
            {ret.orderRef ? ` · commande ${ret.orderRef}` : ""} · valeur {fmtMoney(ret.amount)}
          </p>
          {!ret.legDone && <div className="nc-hint">Le livreur n&apos;a pas encore marqué cette pièce récupérée.</div>}
          {error && <div className="nc-error">{error}</div>}
          <div className="od-field">
            <span className="od-label">Et l&apos;argent ?</span>
            <div className="nc-pay-quick" role="radiogroup" aria-label="Compensation du retour">
              {CHOICES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={choice === c.id}
                  className={`nc-chip${choice === c.id ? " nc-chip--on" : ""}${c.id === "DEDUCTION" ? " nc-chip--account" : ""}`}
                  onClick={() => setChoice(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <span className="st-cmd-hint">{CHOICES.find((c) => c.id === choice)?.hint}</span>
          </div>
          {money && (
            <div className="od-field">
              <span className="od-label">{choice === "DEDUCTION" ? "Montant déduit" : "Montant de l'avoir"} <span className="od-req">*</span></span>
              <div className="nc-pay-input">
                <input
                  className="od-input nc-pay-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={amount.trim() !== "" && !(value > 0)}
                />
                <span className="nc-pay-unit">€</span>
              </div>
              <span className="st-cmd-hint">Diminuez-le pour retenir des frais de retour.</span>
            </div>
          )}
          <div className="ga-modal-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="button" className="od-btn od-btn--primary" onClick={() => void submit()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
              Réceptionner
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
