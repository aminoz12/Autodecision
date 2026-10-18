"use client";

import { Check, ListChecks, Loader2, PackageOpen, Printer, Truck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { PrintTicketButton } from "@/components/print/PrintTicketButton";
import { partialTicketData, type ReceiveOrder } from "@/lib/commandes-board";
import type { BoardLine } from "@/lib/data/commandes";
import type { OrganizationSettings } from "@/lib/data/saas";

/*
 * « Ouvrir » on an order of « Pièces à recevoir » (2026-10-18, user: « open
 * an order when it has more than one part, check which one is received and
 * which one not, print a ticket mentioning commande partielle »).
 * One row per awaited line, one box per unit still to come: tick what is on
 * the counter. Everything ticked → the usual « commande complète » flow;
 * part of it → the units are received, the order stays « à recevoir » as
 * « partielle » and a « réception partielle » ticket can be printed.
 * Same component on the counter page (modal) and the stock tablet (sheet).
 */

/** Beyond this many units on one line, a stepper replaces the boxes. */
const UNIT_BOXES_MAX = 12;

function plural(n: number, word: string, fem = false): string {
  return `${n} ${word}${n > 1 ? "s" : ""}${fem && n > 1 ? "" : ""}`;
}

export function ReceiveOrderSheet({
  order,
  allLines,
  org,
  vendeur,
  casier,
  tablet,
  busy,
  onClose,
  onConfirm,
}: {
  order: ReceiveOrder;
  /** Every line of the order (received ones included) for the ticket. */
  allLines: BoardLine[];
  org: OrganizationSettings | null;
  vendeur: string | null;
  casier: string | null;
  tablet?: boolean;
  busy: boolean;
  onClose: () => void;
  /** Receives the ticked units (line id → units). Resolves true when saved. */
  onConfirm: (picks: Map<string, number>) => Promise<boolean>;
}) {
  const [picks, setPicks] = useState<Map<string, number>>(() => new Map(order.lines.map((l) => [l.id, 0])));
  const [done, setDone] = useState(false);
  const missingOf = (l: BoardLine) => Math.max(0, l.quantity - l.received);
  const picked = useMemo(() => [...picks.values()].reduce((s, n) => s + n, 0), [picks]);
  const complete = order.missing > 0 && picked >= order.missing;
  const left = order.missing - picked;

  function setQty(line: BoardLine, qty: number) {
    const next = Math.max(0, Math.min(missingOf(line), qty));
    setPicks((prev) => new Map(prev).set(line.id, next));
  }

  async function confirm() {
    if (picked === 0 || busy) return;
    const ok = await onConfirm(picks);
    // A complete order is closed by the parent (the « commande complète » sheet takes over).
    if (ok && !complete) setDone(true);
  }

  const ticket = useMemo(() => partialTicketData(allLines, picks, { vendeur, casier }), [allLines, picks, vendeur, casier]);
  const hint = tablet ? "tb-sheet-line" : "od-hint";
  const btn = tablet ? "tb-btn" : "od-btn";
  const main = tablet ? "tb-btn tb-btn--ok tb-btn--main" : "od-btn od-btn--primary";
  const title = done ? "Réception partielle" : order.ref;

  const body = done ? (
    <>
      <p className={hint}>
        <strong>{order.ref}</strong> — {order.clientName} : {plural(picked, "pièce")} reçue{picked > 1 ? "s" : ""}, {plural(left, "pièce")} à venir.
        La commande reste dans « Pièces à recevoir » (filtre « Partielles »).
      </p>
      {ticket && (
        <div className="rs-recap-wrap">
          <p className="rs-recap-title">Reçu</p>
          <ul className="rs-recap">
            {ticket.lines.map((l, i) => (
              <li key={`r${i}`}>
                <span>
                  <strong>{l.reference}</strong>
                  {l.designation && l.designation.trim().toLowerCase() !== l.reference.trim().toLowerCase() ? ` ${l.designation}` : ""}
                </span>
                <strong>× {l.quantity}</strong>
              </li>
            ))}
          </ul>
          {(ticket.missing ?? []).length > 0 && (
            <>
              <p className="rs-recap-title">Manquant · à venir</p>
              <ul className="rs-recap rs-recap--missing">
                {(ticket.missing ?? []).map((l, i) => (
                  <li key={`m${i}`}>
                    <span>
                      <strong>{l.reference}</strong>
                      {l.designation && l.designation.trim().toLowerCase() !== l.reference.trim().toLowerCase() ? ` ${l.designation}` : ""}
                    </span>
                    <strong>× {l.quantity}</strong>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <div className={tablet ? "tb-actions" : "ga-modal-actions od-done-actions"}>
        <PrintTicketButton ticket={ticket} kind="reception" org={org} title={`${order.ref}-reception-partielle`} className={main}>
          <Printer className="h-5 w-5" /> Ticket « commande partielle »
        </PrintTicketButton>
      </div>
    </>
  ) : (
    <>
      <p className={hint}>
        {order.clientName}
        {order.clientPhone && order.clientPhone !== "-" ? ` · ${order.clientPhone}` : ""} — cochez les pièces arrivées. Ce qui n&apos;est pas coché reste attendu.
      </p>
      <ul className="rs-lines">
        {order.lines.map((l) => {
          const missing = missingOf(l);
          const qty = picks.get(l.id) ?? 0;
          const boxes = missing <= UNIT_BOXES_MAX;
          return (
            <li key={l.id} className={`rs-line${qty > 0 ? " rs-line--on" : ""}`}>
              <div className="rs-line-main">
                <p className="rs-line-ref">
                  <strong>{l.reference}</strong>
                  {l.designation && l.designation.trim().toLowerCase() !== l.reference.trim().toLowerCase() ? ` ${l.designation}` : ""}
                </p>
                <p className="rs-line-meta">
                  <span>
                    <Truck className="h-3.5 w-3.5" /> {l.supplierName ?? "Stock magasin"}
                  </span>
                  {l.referenceCommande && l.referenceCommande !== l.reference && <span>réf. fourn. {l.referenceCommande}</span>}
                  {l.received > 0 && (
                    <span>
                      déjà reçu {l.received} / {l.quantity}
                    </span>
                  )}
                </p>
              </div>
              <div className="rs-units" role="group" aria-label={`Pièces reçues pour ${l.reference}`}>
                {boxes ? (
                  Array.from({ length: missing }, (_, i) => i + 1).map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`rs-unit${k <= qty ? " rs-unit--on" : ""}`}
                      aria-pressed={k <= qty}
                      aria-label={`Pièce ${k} sur ${missing}`}
                      disabled={busy}
                      onClick={() => setQty(l, k <= qty ? k - 1 : k)}
                    >
                      {k <= qty ? <Check /> : k}
                    </button>
                  ))
                ) : (
                  <span className="rs-stepper">
                    <button type="button" className="ro-step" disabled={busy || qty <= 0} onClick={() => setQty(l, qty - 1)} aria-label="Moins">
                      −
                    </button>
                    <strong>{qty}</strong>
                    <button type="button" className="ro-step" disabled={busy || qty >= missing} onClick={() => setQty(l, qty + 1)} aria-label="Plus">
                      +
                    </button>
                    <span>/ {missing}</span>
                  </span>
                )}
                <button type="button" className="rs-all" disabled={busy} onClick={() => setQty(l, qty === missing ? 0 : missing)}>
                  {qty === missing ? "Aucune" : "Toutes"}
                </button>
              </div>
              <p className="rs-line-count">
                {qty} / {missing} reçue{qty > 1 ? "s" : ""}
              </p>
            </li>
          );
        })}
      </ul>
      <p className={`rs-summary${complete ? " rs-summary--complete" : ""}`} aria-live="polite">
        {complete
          ? `Les ${plural(order.missing, "pièce")} attendues sont là : la commande sera complète.`
          : picked === 0
            ? `Aucune pièce cochée sur ${order.missing} attendue${order.missing > 1 ? "s" : ""}.`
            : `${plural(picked, "pièce")} reçue${picked > 1 ? "s" : ""} sur ${order.missing} · ${plural(left, "pièce")} manquante${left > 1 ? "s" : ""} → commande partielle.`}
      </p>
      <div className={tablet ? "tb-actions" : "ga-modal-actions od-done-actions"}>
        <button type="button" className={main} disabled={busy || picked === 0} onClick={() => void confirm()}>
          {busy ? <Loader2 className="h-5 w-5 nc-spin" /> : complete ? <Check className="h-5 w-5" /> : <PackageOpen className="h-5 w-5" />}
          {complete ? "Tout reçu" : picked === 0 ? "Valider" : `Valider la réception partielle (${picked})`}
        </button>
      </div>
    </>
  );

  if (tablet) {
    return (
      <div className="tb-sheet-overlay" onClick={onClose}>
        <div className="tb-sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
          <div className="tb-sheet-head">
            <p>
              <ListChecks className="h-5 w-5" /> {title}
            </p>
            <button type="button" className="tb-icon-btn" onClick={onClose} aria-label="Fermer">
              <X className="h-6 w-6" />
            </button>
          </div>
          {body}
          <div className="tb-actions">
            <button type="button" className="tb-btn tb-btn--ghost" onClick={onClose} disabled={busy}>
              {done ? "Fermer" : "Annuler"}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="ga-modal-overlay" onClick={onClose}>
      <div className="ga-modal ga-modal--wide" role="dialog" aria-modal="true" aria-labelledby="rs-title" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title" id="rs-title">
            <ListChecks className="h-4 w-4" /> {title}
          </span>
          <button type="button" className="ga-modal-close" onClick={onClose} aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="ga-modal-form">
          {body}
          <div className="ga-modal-actions">
            <button type="button" className={`${btn} od-btn--ghost`} onClick={onClose} disabled={busy}>
              {done ? "Fermer" : "Annuler"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
