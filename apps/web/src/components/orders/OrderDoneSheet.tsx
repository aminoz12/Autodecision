"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Check, Loader2, MessageSquare, PackageCheck, Printer, Send, X } from "lucide-react";
import { useState } from "react";
import { PrintTicketButton } from "@/components/print/PrintTicketButton";
import { boardTicketData } from "@/lib/commandes-board";
import type { BoardLine } from "@/lib/data/commandes";
import type { OrganizationSettings } from "@/lib/data/saas";
import { setOrderSavFields } from "@/lib/data/sav";

/*
 * Shown the moment an order is complete (every awaited part pointed):
 *   particulier → SMS « commande prête » + ticket de rangement (casier) ;
 *   garage      → bon de livraison + « Livrée » (or hand to a livreur) ;
 *   réappro     → the parts go back on the shelf, nothing else.
 * Same component on the counter page (modal) and the stock tablet (sheet).
 */

export type DoneOrder = {
  orderId: string;
  ref: string;
  clientName: string;
  clientPhone: string | null;
  isGarage: boolean;
  isRestock: boolean;
  /** Every line of the order, as on the board. */
  lines: BoardLine[];
  casier: string | null;
};

export function OrderDoneSheet({
  order,
  org,
  vendeur,
  supabase,
  tablet,
  canDispatch,
  busy,
  onClose,
  onSms,
  onDelivered,
  onDispatch,
  onCasier,
}: {
  order: DoneOrder;
  org: OrganizationSettings | null;
  vendeur: string | null;
  supabase: SupabaseClient;
  tablet?: boolean;
  /** A livreur exists: « Envoyer au livreur » is offered too. */
  canDispatch: boolean;
  busy: boolean;
  onClose: () => void;
  onSms: () => void;
  onDelivered: () => void;
  onDispatch: () => void;
  onCasier: (casier: string | null) => void;
}) {
  const [casier, setCasier] = useState(order.casier ?? "");
  const [casierSaving, setCasierSaving] = useState(false);
  const [casierError, setCasierError] = useState<string | null>(null);
  const pieces = order.lines.filter((l) => l.status !== "NOT_RECEIVED").reduce((s, l) => s + l.quantity, 0);
  const hasPhone = !!order.clientPhone && order.clientPhone !== "-";

  async function saveCasier() {
    const next = casier.trim().toUpperCase();
    setCasier(next);
    if (next === (order.casier ?? "")) return;
    setCasierSaving(true);
    setCasierError(null);
    try {
      await setOrderSavFields(supabase, order.orderId, { casier: next || null });
      onCasier(next || null);
    } catch (e) {
      setCasierError(e instanceof Error ? e.message : String(e));
    } finally {
      setCasierSaving(false);
    }
  }

  const title = order.isRestock ? "Réappro reçue" : "Commande complète";
  const btn = tablet ? "tb-btn" : "od-btn";
  const main = tablet ? "tb-btn tb-btn--ok tb-btn--main" : "od-btn od-btn--primary";

  const body = (
    <>
      <p className={tablet ? "tb-sheet-line" : "od-hint"}>
        <strong>{order.ref}</strong> — {order.clientName}
        {hasPhone ? ` · ${order.clientPhone}` : ""} · {pieces} pièce{pieces > 1 ? "s" : ""} reçue{pieces > 1 ? "s" : ""}.
      </p>

      {order.isRestock ? (
        <p className={tablet ? "tb-sheet-line" : "od-hint"}>Les pièces sont rangées en stock : rien d&apos;autre à faire.</p>
      ) : order.isGarage ? (
        <>
          <p className={tablet ? "tb-sheet-line" : "od-hint"}>Imprimez le bon de livraison, puis marquez la commande livrée (ou confiez-la à un livreur).</p>
          <div className={tablet ? "tb-actions" : "ga-modal-actions od-done-actions"}>
            <PrintTicketButton
              ticket={boardTicketData(order.lines, { vendeur })}
              kind="livraison"
              org={org}
              title={`${order.ref}-bon-livraison`}
              className={btn}
            >
              <Printer className="h-5 w-5" /> Bon de livraison
            </PrintTicketButton>
            {canDispatch && (
              <button type="button" className={btn} disabled={busy} onClick={onDispatch}>
                <Send className="h-5 w-5" /> Envoyer au livreur
              </button>
            )}
            <button type="button" className={main} disabled={busy} onClick={onDelivered}>
              {busy ? <Loader2 className="h-5 w-5 nc-spin" /> : <Check className="h-5 w-5" />} Livrée
            </button>
          </div>
        </>
      ) : (
        <>
          <div className={tablet ? "tb-casier" : "od-field"}>
            <label className={tablet ? "tb-casier-label" : "od-label"} htmlFor="done-casier">
              Casier de rangement
            </label>
            <input
              id="done-casier"
              className={tablet ? "tb-casier-input" : "od-input od-casier-input"}
              value={casier}
              onChange={(e) => setCasier(e.target.value)}
              onBlur={() => void saveCasier()}
              placeholder="A3"
              maxLength={12}
              autoComplete="off"
            />
            {casierSaving && <Loader2 className="h-4 w-4 nc-spin" />}
          </div>
          {casierError && <div className="nc-error">{casierError}</div>}
          <div className={tablet ? "tb-actions" : "ga-modal-actions od-done-actions"}>
            <PrintTicketButton
              ticket={boardTicketData(order.lines, { vendeur, casier: casier.trim().toUpperCase() || null })}
              kind="rangement"
              org={org}
              title={`${order.ref}-rangement`}
              className={btn}
            >
              <Printer className="h-5 w-5" /> Ticket de rangement
            </PrintTicketButton>
            <button type="button" className={main} disabled={busy || !hasPhone} onClick={onSms} title={hasPhone ? undefined : "Pas de numéro de téléphone"}>
              <MessageSquare className="h-5 w-5" /> Prévenir par SMS
            </button>
          </div>
        </>
      )}
    </>
  );

  if (tablet) {
    return (
      <div className="tb-sheet-overlay" onClick={onClose}>
        <div className="tb-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
          <div className="tb-sheet-head">
            <p>
              <PackageCheck className="h-5 w-5" /> {title}
            </p>
            <button type="button" className="tb-icon-btn" onClick={onClose} aria-label="Fermer">
              <X className="h-6 w-6" />
            </button>
          </div>
          {body}
          <div className="tb-actions">
            <button type="button" className="tb-btn tb-btn--ghost" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ga-modal-overlay" onClick={onClose}>
      <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="done-title" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title" id="done-title">
            <PackageCheck className="h-4 w-4" /> {title}
          </span>
          <button type="button" className="ga-modal-close" onClick={onClose} aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="ga-modal-form">
          {body}
          <div className="ga-modal-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={onClose}>
              Fermer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
