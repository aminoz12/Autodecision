"use client";

import { Ban, Check, CheckCircle2, CloudOff, Flag, Loader2, Play, RotateCcw, Store, Warehouse } from "lucide-react";
import type { CSSProperties } from "react";
import {
  pct,
  pickupState,
  PICKUP_STATE_LABEL,
  scheduleSlots,
  slotLabel,
  supplierStops,
  TOUR_STATUS_LABEL,
  tourColor,
  tourStats,
  type PickupState,
  type PickupStatus,
  type SupplierTour,
  type SupplierTourBoard,
  type TourLine,
  type TourStatus,
} from "@/lib/data/tournees";

type Props = {
  board: SupplierTourBoard | null;
  day: string;
  today: string;
  tomorrow: string;
  onDay: (day: string) => void;
  loading: boolean;
  error: string | null;
  livreurId: string;
  /** Parts / tours whose tick is waiting for the network. */
  queuedLines: ReadonlySet<string>;
  queuedTours: ReadonlySet<string>;
  onPickup: (line: TourLine, status: PickupStatus | null) => void;
  /** `left`: parts still to collect on the tour (asked before finishing). */
  onTourStatus: (tour: SupplierTour, status: TourStatus, left: number) => void;
};

function Box({ state }: { state: PickupState }) {
  return (
    <span className="lpt-box" aria-hidden="true">
      {state === "picked" ? <Check /> : state === "received" ? <Store /> : state === "unavailable" ? <Ban /> : null}
    </span>
  );
}

/**
 * Livreur « Fournisseurs » tab: the tournées of the day in departure order,
 * one block per supplier, one tap per part collected.
 */
export function SupplierPickups({
  board,
  day,
  today,
  tomorrow,
  onDay,
  loading,
  error,
  livreurId,
  queuedLines,
  queuedTours,
  onPickup,
  onTourStatus,
}: Props) {
  const slots = board ? scheduleSlots(board.tours, false) : [];
  const isToday = day === today;
  const tomorrowCount = isToday ? board?.upcoming.find((u) => u.date === tomorrow)?.count ?? 0 : 0;

  return (
    <>
      <div className="lpt-days" role="group" aria-label="Jour">
        <button type="button" className={`nc-chip${isToday ? " nc-chip--on" : ""}`} onClick={() => onDay(today)}>
          Aujourd&apos;hui
        </button>
        <button type="button" className={`nc-chip${day === tomorrow ? " nc-chip--on" : ""}`} onClick={() => onDay(tomorrow)}>
          Demain{tomorrowCount > 0 ? ` (${tomorrowCount})` : ""}
        </button>
        {loading && <Loader2 className="h-4 w-4 nc-spin lpt-days-spin" />}
      </div>

      {error && <div className="nc-error">{error}</div>}

      {!board && !error && (
        <div className="lp-empty lp-empty--offline">
          {loading ? <Loader2 className="h-8 w-8 nc-spin" /> : <CloudOff className="h-8 w-8" />}
          <p>
            {loading
              ? "Chargement des tournées…"
              : "Tournées pas encore chargées : elles s'afficheront dès que le téléphone aura du réseau."}
          </p>
        </div>
      )}

      {board && slots.length === 0 && (
        <div className="lp-empty">
          <CheckCircle2 className="h-8 w-8" />
          <p>
            Rien à récupérer chez les fournisseurs {isToday ? "aujourd'hui" : "demain"}.
            {tomorrowCount > 0 && ` ${tomorrowCount} pièce${tomorrowCount > 1 ? "s" : ""} à récupérer demain.`}
          </p>
        </div>
      )}

      {board &&
        slots.map((slot) => {
          const tour = slot.tour;
          if (!tour) return null;
          const lines = board.lines.filter((l) => l.tourId === tour.id);
          const stats = tourStats(lines);
          const stops = supplierStops(lines);
          return (
            <article
              key={slot.key}
              className="lp-card lpt-tour"
              style={{ "--tc": tourColor(slot.index) } as CSSProperties}
            >
              <div className="lpt-tour-head">
                <span className="lpt-time">{slotLabel(slot.slot)}</span>
                <div className="lpt-tour-titles">
                  <p className="lp-client">
                    {tour.name}
                    <span className={`lpt-status lpt-status--${tour.status}`}>{TOUR_STATUS_LABEL[tour.status]}</span>
                    {queuedTours.has(tour.id) && <CloudOff className="h-4 w-4 lpt-queued" aria-label="En attente de réseau" />}
                  </p>
                  <p className="lp-meta">
                    {stats.done}/{stats.total} récupérée{stats.done > 1 ? "s" : ""}
                    {stats.unavailable > 0 ? ` · ${stats.unavailable} indispo` : ""}
                    {" · "}
                    {tour.livreurId === livreurId ? "confiée à vous" : "sans livreur attitré"}
                  </p>
                </div>
              </div>

              {stats.total > 0 && (
                <div className="tf-bar">
                  <span style={{ width: `${pct(stats.done, stats.total)}%` }} />
                </div>
              )}

              {tour.note && <p className="lp-note">📝 {tour.note}</p>}

              {stops.map((stop) => (
                <div key={stop.supplierId} className="lpt-stop">
                  <p className="lpt-stop-head">
                    <Warehouse className="h-4 w-4" />
                    <strong>{stop.supplier}</strong>
                    <span className={`lp-count${stop.left === 0 ? " lp-count--done" : ""}`}>
                      {stop.left === 0 ? "✓" : `${stop.left} à prendre`}
                    </span>
                  </p>
                  {stop.lines.map((l) => {
                    const state = pickupState(l);
                    const unavailable = l.pickupStatus === "UNAVAILABLE";
                    return (
                      <div key={l.id} className={`lpt-line lpt-line--${state}`}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={state === "picked"}
                          className="lpt-line-main"
                          disabled={state === "received"}
                          onClick={() => onPickup(l, state === "picked" ? null : "PICKED_UP")}
                        >
                          <Box state={state} />
                          <span className="lpt-line-text">
                            <strong>
                              {l.reference}
                              {l.quantity > 1 ? ` ×${l.quantity}` : ""}
                            </strong>
                            <span>
                              {l.designation}
                              {l.referenceCommande ? ` · réf. ${l.referenceCommande}` : ""} · {l.vendeur}
                            </span>
                            {state !== "pending" && <em>{PICKUP_STATE_LABEL[state]}</em>}
                          </span>
                          {queuedLines.has(l.id) && <CloudOff className="h-4 w-4 lpt-queued" aria-label="En attente de réseau" />}
                        </button>
                        {state !== "received" && (
                          <button
                            type="button"
                            className={`lpt-unavail${unavailable ? " lpt-unavail--on" : ""}`}
                            aria-pressed={unavailable}
                            onClick={() => onPickup(l, unavailable ? null : "UNAVAILABLE")}
                          >
                            <Ban className="h-4 w-4" />
                            Indispo
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}

              {lines.length === 0 && <p className="lp-meta">Aucune pièce sur cette tournée.</p>}

              {isToday && (
                <div className="lpt-tour-actions">
                  {tour.status === "PLANIFIEE" && (
                    <button type="button" className="lp-deliver" onClick={() => onTourStatus(tour, "EN_COURS", stats.pending)}>
                      <Play className="h-5 w-5" /> Démarrer la tournée
                    </button>
                  )}
                  {tour.status === "EN_COURS" && (
                    <button type="button" className="lp-deliver" onClick={() => onTourStatus(tour, "TERMINEE", stats.pending)}>
                      <Flag className="h-5 w-5" /> Tournée terminée
                    </button>
                  )}
                  {tour.status === "TERMINEE" && (
                    <button type="button" className="lpt-reopen" onClick={() => onTourStatus(tour, "EN_COURS", stats.pending)}>
                      <RotateCcw className="h-5 w-5" /> Reprendre la tournée
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
    </>
  );
}
