"use client";

import { Check, Hourglass, ListChecks, Loader2, Truck, X } from "lucide-react";
import { useState } from "react";
import { LINE_KIND_LABEL, type ReceiveOrder } from "@/lib/commandes-board";
import type { BoardLine } from "@/lib/data/commandes";

/*
 * « À recevoir », one card per ORDER (2026-10-18, user: « pointe par commande
 * au lieu de pointer par pièce »). The big button receives every awaited line
 * at once; each line keeps its own buttons for the exceptions (one part
 * missing, a backorder, an unavailable part). Shared by the counter page and
 * the stock tablet.
 */

const STATUS: Record<string, { label: string; cls: string }> = {
  PENDING: { label: "Attendue", cls: "wait" },
  PARTIAL: { label: "Reçu partiel", cls: "partial" },
  BACKORDER: { label: "Reliquat", cls: "partial" },
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" }) + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export function ReceiveOrderCard({
  order,
  busy,
  staffNames,
  onReceiveAll,
  onReceiveLine,
  onStatus,
  onOpen,
}: {
  order: ReceiveOrder;
  /** Order id or line id of the action running (null = none). */
  busy: string | null;
  staffNames: Map<string, string>;
  onReceiveAll: (order: ReceiveOrder) => void;
  onReceiveLine: (line: BoardLine, qty?: number) => void;
  onStatus: (line: BoardLine, status: "BACKORDER" | "NOT_RECEIVED") => void;
  /** Opens the checklist (which parts came in, which did not) — offered when more than one part is awaited. */
  onOpen?: (order: ReceiveOrder) => void;
}) {
  /** The line whose « Partiel » quantity picker is open. */
  const [partial, setPartial] = useState<{ lineId: string; qty: number } | null>(null);
  const orderBusy = busy === order.orderId;
  const anyBusy = busy !== null;

  return (
    <article className={`ro-card ro-card--${order.kind.toLowerCase()}`}>
      <header className="ro-head">
        <div className="ro-head-main">
          <p className="ro-ref">
            {order.ref}
            <span className={`ro-kind ro-kind--${order.kind.toLowerCase()}`}>{LINE_KIND_LABEL[order.kind]}</span>
            {order.partial && (
              <span className="ro-kind ro-kind--partial" title={`${order.receivedUnits} pièce(s) déjà reçue(s), ${order.missing} manquante(s)`}>
                Partielle
              </span>
            )}
          </p>
          <p className="ro-client">{order.clientName}</p>
          <p className="ro-meta">
            {[
              order.clientPhone && order.clientPhone !== "-" ? order.clientPhone : null,
              order.plate,
              order.vehicle,
              order.tourName,
              order.expectedAt ? `prévu ${when(order.expectedAt)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="ro-head-acts">
        {onOpen && order.missing > 1 && (
          <button type="button" className="ro-open" disabled={anyBusy} onClick={() => onOpen(order)} title="Cocher pièce par pièce ce qui est arrivé">
            <ListChecks className="h-5 w-5" /> Ouvrir
          </button>
        )}
        <button
          type="button"
          className="ro-all"
          disabled={anyBusy}
          onClick={() => onReceiveAll(order)}
          title="Toutes les pièces attendues de cette commande sont arrivées"
        >
          {orderBusy ? <Loader2 className="h-5 w-5 nc-spin" /> : <Check className="h-5 w-5" />}
          <span>
            Tout reçu
            <small>
              {order.missing} pièce{order.missing > 1 ? "s" : ""} · {order.lines.length} ligne{order.lines.length > 1 ? "s" : ""}
            </small>
          </span>
        </button>
        </div>
      </header>

      <ul className="ro-lines">
        {order.lines.map((l) => {
          const st = STATUS[l.status] ?? { label: l.status, cls: "wait" };
          const missing = Math.max(0, l.quantity - l.received);
          const lineBusy = busy === l.id;
          const open = partial?.lineId === l.id;
          const who = l.pointedBy && staffNames.get(l.pointedBy);
          return (
            <li key={l.id} className={`ro-line ro-line--${st.cls}`}>
              <div className="ro-line-main">
                <p className="ro-line-ref">
                  <strong>{l.reference}</strong>
                  {l.designation && l.designation.trim().toLowerCase() !== l.reference.trim().toLowerCase() ? ` ${l.designation}` : ""}
                </p>
                <p className="ro-line-meta">
                  <span className="ro-supplier">
                    <Truck className="h-3.5 w-3.5" /> {l.supplierName ?? "Stock magasin"}
                  </span>
                  {l.referenceCommande && l.referenceCommande !== l.reference && (
                    <span className="ro-ref-sup">réf. fourn. {l.referenceCommande}</span>
                  )}
                  <span className={`ro-badge ro-badge--${st.cls}`}>{st.label}</span>
                  <span className="ro-qty">
                    reçu <strong>{l.received}</strong> / {l.quantity}
                  </span>
                  {who && (
                    <span className="ro-who">
                      {who} · {when(l.pointedAt)}
                    </span>
                  )}
                </p>
              </div>
              {open ? (
                <div className="ro-partial">
                  <button type="button" className="ro-step" onClick={() => setPartial({ lineId: l.id, qty: Math.max(1, (partial?.qty ?? 1) - 1) })} aria-label="Moins">
                    −
                  </button>
                  <strong>{partial?.qty}</strong>
                  <button
                    type="button"
                    className="ro-step"
                    onClick={() => setPartial({ lineId: l.id, qty: Math.min(missing - 1, (partial?.qty ?? 1) + 1) })}
                    aria-label="Plus"
                  >
                    +
                  </button>
                  <span className="ro-partial-of">/ {missing}</span>
                  <button
                    type="button"
                    className="ro-act ro-act--ok"
                    disabled={anyBusy}
                    onClick={() => {
                      const q = partial?.qty ?? 1;
                      setPartial(null);
                      onReceiveLine(l, q);
                    }}
                  >
                    {lineBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Valider
                  </button>
                  <button type="button" className="ro-act" onClick={() => setPartial(null)}>
                    Annuler
                  </button>
                </div>
              ) : (
                <div className="ro-line-acts">
                  <button type="button" className="ro-act ro-act--ok" disabled={anyBusy} onClick={() => onReceiveLine(l)} title="Cette ligne seule est arrivée">
                    {lineBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Reçu
                  </button>
                  {missing > 1 && (
                    <button type="button" className="ro-act" disabled={anyBusy} onClick={() => setPartial({ lineId: l.id, qty: 1 })} title="Une partie seulement des pièces est arrivée">
                      Partiel
                    </button>
                  )}
                  <button type="button" className="ro-act" disabled={anyBusy || l.status === "BACKORDER"} onClick={() => onStatus(l, "BACKORDER")}>
                    <Hourglass className="h-4 w-4" /> Reliquat
                  </button>
                  <button type="button" className="ro-act ro-act--no" disabled={anyBusy || l.status === "NOT_RECEIVED"} onClick={() => onStatus(l, "NOT_RECEIVED")}>
                    <X className="h-4 w-4" /> Non reçu
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}
