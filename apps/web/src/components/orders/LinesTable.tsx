"use client";

import { Ban, Check, CheckCircle2, Clock, Hourglass, Loader2, RotateCcw, Truck, X, XCircle, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { BoardLine, ReceptionStatus } from "@/lib/data/commandes";

/*
 * The line table of « Suivi des commandes » (Pièces à recevoir, Reliquats,
 * Historique). A component of its own, not declared inside the page: declared
 * there, every state change of the page made React rebuild the whole table
 * (scroll position and the « Partiel » input lost on each keystroke or click).
 */

export const STATUT: Record<ReceptionStatus, { label: string; cls: string; icon: LucideIcon }> = {
  PENDING: { label: "En attente", cls: "attente", icon: Clock },
  RECEIVED: { label: "Reçu", cls: "recu", icon: CheckCircle2 },
  PARTIAL: { label: "Reçu partiel", cls: "reliquat", icon: Hourglass },
  BACKORDER: { label: "Reliquat", cls: "reliquat", icon: Hourglass },
  NOT_RECEIVED: { label: "Non reçu", cls: "nonrecu", icon: XCircle },
};

export function fmtDay(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

export function fmtDayTime(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  const day = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `${day} à ${time}`;
}

/** What the page shares with every table: state of the board and its actions. */
export type LinesTableContext = {
  loading: boolean;
  /** Line ids with an action running (« bulk » = the grouped action). */
  busy: Set<string>;
  selected: Set<string>;
  allVisibleSelected: boolean;
  toggleSelectAll: () => void;
  toggleSelect: (id: string) => void;
  /** Per order: units already taken by the client vs. ordered (all lines). */
  handedByOrder: Map<string, { handed: number; total: number }>;
  /** Réception partielle: which line has its quantity input open. */
  partial: { lineId: string; qty: string } | null;
  setPartial: (partial: { lineId: string; qty: string } | null) => void;
  actReceive: (line: BoardLine, qty?: number) => Promise<void>;
  actHandOver: (line: BoardLine) => Promise<void>;
  actStatus: (line: BoardLine, status: "BACKORDER" | "NOT_RECEIVED") => Promise<void>;
  /** « Promis le … » under an order ref. */
  promiseNote: (orderId: string) => ReactNode;
  /** Names of the magasin's people, for « par Sofia · … » under the status. */
  staffNames: Map<string, string>;
};

export function LinesTable({
  ctx,
  rows,
  showActions,
  onReturn,
  showHandOver = true,
  selectable = false,
}: {
  ctx: LinesTableContext;
  rows: BoardLine[];
  showActions: boolean;
  onReturn?: (line: BoardLine) => void;
  /** "Remis client" column (hidden on the Historique tab). */
  showHandOver?: boolean;
  /** Checkbox column for grouped actions. */
  selectable?: boolean;
}) {
  const {
    loading,
    busy,
    selected,
    allVisibleSelected,
    toggleSelectAll,
    toggleSelect,
    handedByOrder,
    partial,
    setPartial,
    actReceive,
    actHandOver,
    actStatus,
    promiseNote,
    staffNames,
  } = ctx;
  const showReceivedAt = !showActions;
  const colCount =
    6 + (showHandOver ? 1 : 0) + (showReceivedAt ? 1 : 0) + (showActions ? 1 : 0) + (onReturn ? 1 : 0) + (selectable ? 1 : 0);
  return (
    <section className="od-card rc-table-card">
      <div className="rc-table-wrap">
        <table className={`rc-table${showActions || onReturn ? " rc-table--sticky-actions" : ""}`}>
          <thead>
            <tr>
              {selectable && (
                <th className="rc-th-check">
                  <input
                    type="checkbox"
                    className="rc-check"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    aria-label="Tout sélectionner"
                  />
                </th>
              )}
              <th>Commande</th>
              <th>Client</th>
              <th>Référence / Désignation</th>
              <th>Fournisseur</th>
              <th className="rc-th-center">Reçu / Cmd</th>
              {showHandOver && <th>Remis client</th>}
              <th>Statut</th>
              {showReceivedAt && <th>Reçu le</th>}
              {showActions && <th className="rc-th-center">Actions</th>}
              {onReturn && <th className="rc-th-center">Retour</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const St = STATUT[r.status];
              const StIcon = St.icon;
              const type = r.fromStock ? "stock" : r.isGarage ? "garage" : "client";
              const isBusy = busy.has(r.id) || busy.has("bulk");
              const isSelected = selectable && selected.has(r.id);
              return (
                <tr
                  key={r.id}
                  className={`rc-row rc-row--${type}${isSelected ? " rc-row--selected" : ""}`}
                >
                  {selectable && (
                    <td className="rc-th-check">
                      <input
                        type="checkbox"
                        className="rc-check"
                        checked={isSelected}
                        onChange={() => toggleSelect(r.id)}
                        aria-label={`Sélectionner ${r.reference}`}
                      />
                    </td>
                  )}
                  <td>
                    <Link href={`/dashboard/commandes/${r.orderId}`} className="rc-cmd">
                      {r.orderRef}
                    </Link>
                    <p className="rl-muted">{fmtDay(r.orderDate)}</p>
                    {promiseNote(r.orderId)}
                  </td>
                  <td>
                    <p className="rl-client">
                      {r.clientName}
                      <span className={`rc-type rc-type--${type} rc-type--inline`}>
                        {r.fromStock ? "Stock" : r.isGarage ? "Garage" : "Client"}
                      </span>
                    </p>
                    {r.clientPhone && <p className="rl-muted">{r.clientPhone}</p>}
                    {(() => {
                      const h = handedByOrder.get(r.orderId);
                      if (!h || h.handed === 0) return null;
                      const left = Math.max(0, h.total - h.handed);
                      return (
                        <p className="rl-handed">
                          Client a pris {h.handed}/{h.total} pièce(s)
                          {left > 0 ? ` · reste ${left}` : " · complet"}
                        </p>
                      );
                    })()}
                  </td>
                  <td>
                    <p className="rl-ref">{r.reference}</p>
                    {r.referenceCommande && r.referenceCommande !== r.reference && (
                      <p className="rl-ref-cmd">Réf. cmd. {r.referenceCommande}</p>
                    )}
                    <p className="rl-muted">{r.designation}</p>
                  </td>
                  <td>
                    <span className={`rc-brand ${r.supplierName ? "rc-brand--supplier" : "rc-brand--stock"}`}>
                      {r.supplierName ?? "Stock magasin"}
                    </span>
                    {r.supplierName && (r.supplierOwnDelivery || r.supplierLeadDays > 0) && (
                      <p className="rc-supplier-mode">
                        {r.supplierOwnDelivery ? <Truck className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                        {r.supplierOwnDelivery ? "Livreur du fournisseur" : "Tournée"}
                        {r.supplierLeadDays > 0 ? ` · J+${r.supplierLeadDays}` : ""}
                      </p>
                    )}
                    {r.expectedAt && r.status !== "RECEIVED" && (
                      <p className="rl-muted">Prévu {fmtDayTime(r.expectedAt)}</p>
                    )}
                  </td>
                  <td className="rc-th-center">
                    <span className={`rc-qty${r.received >= r.quantity ? " rc-qty--full" : r.received > 0 ? " rc-qty--part" : ""}`}>
                      <strong>{r.received}</strong>
                      <em>/ {r.quantity}</em>
                      <i style={{ width: `${Math.min(100, Math.round((r.received / Math.max(1, r.quantity)) * 100))}%` }} />
                    </span>
                  </td>
                  {showHandOver && (
                  <td>
                    {(() => {
                      const left = Math.max(0, r.quantity - r.handedOver);
                      const available = r.fromStock
                        ? r.quantity
                        : Math.min(r.quantity, r.received);
                      const canHand = available > r.handedOver && Boolean(r.clientId);
                      return (
                        <div className="rc-remise">
                          {r.handedOver >= r.quantity ? (
                            <span className="rc-statut rc-statut--recu">
                              <Check className="h-3.5 w-3.5" />
                              Remis {r.handedOver}/{r.quantity}
                            </span>
                          ) : r.handedOver > 0 ? (
                            <span className="rc-statut rc-statut--reliquat">
                              Remis {r.handedOver}/{r.quantity} · reste {left}
                            </span>
                          ) : (
                            <span className="rc-statut rc-statut--attente">Non remis</span>
                          )}
                          {canHand && (
                            <button
                              type="button"
                              className="rc-act rc-act--remise"
                              disabled={isBusy}
                              onClick={() => actHandOver(r)}
                              title="Le client emporte les pièces disponibles"
                            >
                              Remettre {Math.max(0, available - r.handedOver)}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </td>
                  )}
                  <td>
                    <span className={`rc-statut rc-statut--${St.cls}`}>
                      <StIcon className="h-3.5 w-3.5" />
                      {St.label}
                    </span>
                    {r.pointedBy && staffNames.get(r.pointedBy) && (
                      <p className="rc-pointed">
                        par {staffNames.get(r.pointedBy)} · {fmtDayTime(r.pointedAt)}
                      </p>
                    )}
                  </td>
                  {showReceivedAt && (
                    <td className="rl-muted-strong">{fmtDayTime(r.receivedAt)}</td>
                  )}
                  {showActions && (
                    <td>
                      <div className="rc-actions">
                        <button
                          type="button"
                          className="rc-act rc-act--recu"
                          disabled={isBusy}
                          onClick={() => actReceive(r)}
                        >
                          Reçu{" "}
                          {isBusy ? (
                            <Loader2 className="h-3.5 w-3.5 nc-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                        </button>
                        {r.quantity - r.received > 1 &&
                          (partial?.lineId === r.id ? (
                            <span className="rc-partial">
                              <input
                                className="od-input rc-partial-input"
                                type="number"
                                min={1}
                                max={r.quantity - r.received - 1}
                                value={partial.qty}
                                autoFocus
                                aria-label="Quantité reçue"
                                onChange={(e) => setPartial({ lineId: r.id, qty: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    void actReceive(r, Number(partial.qty));
                                  }
                                  if (e.key === "Escape") setPartial(null);
                                }}
                              />
                              <span className="rl-muted">/ {r.quantity - r.received}</span>
                              <button
                                type="button"
                                className="rc-act rc-act--recu"
                                disabled={isBusy || !partial.qty}
                                onClick={() => actReceive(r, Number(partial.qty))}
                              >
                                OK
                              </button>
                              <button type="button" className="rc-act rc-act--quiet" onClick={() => setPartial(null)}>
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="rc-act rc-act--recu rc-act--quiet"
                              disabled={isBusy}
                              title="Réception partielle : une partie seulement des pièces est arrivée"
                              onClick={() => setPartial({ lineId: r.id, qty: "1" })}
                            >
                              Partiel
                            </button>
                          ))}
                        <button
                          type="button"
                          className="rc-act rc-act--reliquat rc-act--quiet"
                          disabled={isBusy || r.status === "BACKORDER"}
                          onClick={() => actStatus(r, "BACKORDER")}
                        >
                          Reliquat <Hourglass className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          className="rc-act rc-act--nonrecu rc-act--quiet"
                          disabled={isBusy || r.status === "NOT_RECEIVED"}
                          onClick={() => actStatus(r, "NOT_RECEIVED")}
                        >
                          Non reçu <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                  {onReturn && (
                    <td className="rc-th-center">
                      {r.retourImpossible ? (
                        <span className="rt-badge rt-badge--red">
                          <Ban className="h-3.5 w-3.5" /> Retour impossible
                        </span>
                      ) : r.alreadyReturned ? (
                        <span className="rt-badge rt-badge--blue">Déjà retourné</span>
                      ) : (
                        <button
                          type="button"
                          className="rc-act rc-act--retour"
                          onClick={() => onReturn(r)}
                        >
                          Retourner <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="rc-empty-cell">
                  Aucune ligne.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="av-foot">
        <span className="av-foot-count">{rows.length} résultat(s)</span>
      </div>
    </section>
  );
}
