"use client";

import { Ban, Check } from "lucide-react";
import type { CSSProperties } from "react";
import { overviewCellKind, slotLabel, tourColor, type DayOverview, type OverviewCell } from "@/lib/data/tournees";

type Props = {
  overview: DayOverview;
  /** Cell of the stop the livreur last opened (see `cellKey`). */
  activeKey: string | null;
  onCell: (tourId: string, supplierId: string) => void;
};

export function cellKey(tourId: string, supplierId: string): string {
  return `${tourId}:${supplierId}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

/** « AZ, Tournée 2 : 2 à prendre, 1 récupérée, 1 indisponible » */
function describeCell(supplier: string, tourName: string, cell: OverviewCell): string {
  const parts = [
    cell.pending > 0 ? `${cell.pending} à prendre` : "",
    cell.done > 0 ? `${cell.done} récupérée${cell.done > 1 ? "s" : ""}` : "",
    cell.unavailable > 0 ? `${cell.unavailable} indisponible${cell.unavailable > 1 ? "s" : ""}` : "",
  ].filter(Boolean);
  return `${supplier}, ${tourName} : ${parts.join(", ")}`;
}

/**
 * The day at a glance, the way the legacy sheet laid it out: one row per
 * tournée, one column per supplier — but a count per cell, not the
 * references, so seven suppliers fit a phone. A tap opens the stop below.
 */
export function DayOverviewGrid({ overview, activeKey, onCell }: Props) {
  const suppliers = overview.suppliers;
  return (
    <section className="lpo" aria-label="Vue d'ensemble de la journée">
      <p className="lpo-head">
        <span>Journée</span>
        <em>
          {plural(overview.total, "pièce")} · {plural(suppliers.length, "fournisseur")}
        </em>
      </p>
      <div className="lpo-scroll">
        <table className="lpo-grid" style={{ minWidth: 46 + (suppliers.length + 1) * 3 + suppliers.length * 36 }}>
          <thead>
            <tr>
              <th scope="col" className="lpo-corner">
                <span className="sr-only">Tournée</span>
              </th>
              {suppliers.map((s) => (
                <th key={s.id} scope="col">
                  <abbr title={s.name}>{s.short}</abbr>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {overview.rows.map((row) => {
              const tour = row.slot.tour;
              if (!tour) return null;
              return (
                <tr
                  key={row.slot.key}
                  className={`lpo-row lpo-row--${tour.status}`}
                  style={{ "--tc": tourColor(row.slot.index) } as CSSProperties}
                >
                  <th scope="row" className="lpo-slot" aria-label={tour.name}>
                    {slotLabel(row.slot.slot)}
                  </th>
                  {suppliers.map((s) => {
                    const cell = row.cells.get(s.id);
                    const kind = overviewCellKind(cell);
                    const key = cellKey(tour.id, s.id);
                    const active = activeKey === key;
                    return (
                      <td key={s.id}>
                        {!cell || kind === "empty" ? (
                          <span className="lpo-cell lpo-cell--empty" aria-hidden="true">
                            ·
                          </span>
                        ) : (
                          <button
                            type="button"
                            className={`lpo-cell lpo-cell--${kind}${active ? " lpo-cell--active" : ""}`}
                            aria-label={describeCell(s.name, tour.name, cell)}
                            aria-current={active ? "true" : undefined}
                            onClick={() => onCell(tour.id, s.id)}
                          >
                            {kind === "done" ? (
                              <Check />
                            ) : kind === "unavailable" ? (
                              <>
                                <Ban />
                                {cell.unavailable}
                              </>
                            ) : (
                              cell.pending
                            )}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="lpo-legend" aria-hidden="true">
        <li>
          <i className="lpo-cell--todo" /> à prendre
        </li>
        <li>
          <i className="lpo-cell--done" /> récupéré
        </li>
        <li>
          <i className="lpo-cell--unavailable" /> indispo
        </li>
        <li>
          <i className="lpo-legend-here" /> affiché en bas
        </li>
      </ul>
    </section>
  );
}
