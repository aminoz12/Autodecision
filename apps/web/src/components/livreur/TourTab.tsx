"use client";

import {
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  CloudOff,
  Flag,
  Loader2,
  Play,
  RotateCcw,
  Store,
  UserRound,
  Warehouse,
  Wrench,
} from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  buildDayOverview,
  departureText,
  fmtHour,
  focusSlot,
  KIND_LABEL,
  nextStandardTour,
  pct,
  pickupState,
  PICKUP_STATE_LABEL,
  scheduleSlots,
  shortSupplierLabels,
  slotLabel,
  supplierStops,
  TOUR_STATUS_LABEL,
  tourColor,
  tourStats,
  type PartKind,
  type PickupStatus,
  type SupplierTour,
  type SupplierTourBoard,
  type TourLine,
  type TourStatus,
} from "@/lib/data/tournees";
import { cellKey, DayOverviewGrid } from "./DayOverviewGrid";

export type NextTour = { name: string; slot: string; nextDay: boolean };

type Props = {
  board: SupplierTourBoard | null;
  day: string;
  today: string;
  tomorrow: string;
  onDay: (day: string) => void;
  loading: boolean;
  error: string | null;
  livreurId: string | null;
  /** Parts / tours whose tick is waiting for the network. */
  queuedLines: ReadonlySet<string>;
  queuedTours: ReadonlySet<string>;
  onPickup: (line: TourLine, status: PickupStatus | null) => void;
  /** `left`: parts still to collect on the tour (asked before finishing). */
  onTourStatus: (tour: SupplierTour, status: TourStatus, left: number) => void;
  /** Reporter à la tournée suivante — a move, so it needs the network. */
  onDefer: (line: TourLine, next: NextTour) => void;
  deferring: ReadonlySet<string>;
  online: boolean;
};

const KIND_ICON: Record<PartKind, typeof Wrench> = { GARAGE: Wrench, COMPTOIR: UserRound, STOCK: Warehouse };
const KINDS: PartKind[] = ["GARAGE", "COMPTOIR", "STOCK"];

function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

/** Parts still to take per crate on the tour shown; `known` is false on a database that predates kinds. */
function countKinds(lines: TourLine[]): Record<PartKind, number> & { known: boolean } {
  const c = { GARAGE: 0, COMPTOIR: 0, STOCK: 0, known: false };
  for (const l of lines) {
    if (!l.kind) continue;
    c.known = true;
    if (pickupState(l) === "pending") c[l.kind] += 1;
  }
  return c;
}

/**
 * Livreur « Tournée » tab, laid out like the espace-auto-chauffeur design:
 * the tournée on screen as a hero card (progress, one counter per supplier),
 * the other tournées of the day as small cards, the three crates, the day
 * grid folded away, then one accordion per supplier with a tap per part.
 */
export function TourTab({
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
  onDefer,
  deferring,
  online,
}: Props) {
  const isToday = day === today;
  const slots = useMemo(() => (board ? scheduleSlots(board.tours, false) : []), [board]);
  const pendingByTour = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of board?.lines ?? []) if (pickupState(l) === "pending") m.set(l.tourId, (m.get(l.tourId) ?? 0) + 1);
    return m;
  }, [board]);
  const [selected, setSelected] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const accordions = useRef(new Map<string, HTMLDetailsElement>());

  const focus = focusSlot(slots, day, pendingByTour);
  const current = slots.find((s) => s.tour?.id === selected) ?? focus;
  const tour = current?.tour ?? null;
  const lines = board && tour ? board.lines.filter((l) => l.tourId === tour.id) : [];
  const stats = tourStats(lines);
  const stops = supplierStops(lines);
  const shorts = shortSupplierLabels(stops.map((s) => s.supplier));
  const kinds = countKinds(lines);
  const overview = board ? buildDayOverview(slots, board.lines) : null;
  const others = slots.filter((s) => s.tour && s.tour.id !== tour?.id);
  const next = nextStandardTour(current?.slot ?? null);
  const firstOpen = Math.max(0, stops.findIndex((s) => s.left > 0));
  const tomorrowCount = isToday ? (board?.upcoming.find((u) => u.date === tomorrow)?.count ?? 0) : 0;

  const changeDay = (d: string) => {
    setSelected(null);
    setActiveKey(null);
    onDay(d);
  };

  /** A tap on a counter or a grid cell: show that tournée, open that supplier, scroll to it. */
  const openStop = (tourId: string, supplierId: string) => {
    const key = cellKey(tourId, supplierId);
    setSelected(tourId);
    setActiveKey(key);
    window.requestAnimationFrame(() => {
      const el = accordions.current.get(key);
      if (!el) return;
      el.open = true;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    });
  };

  return (
    <>
      <div className="lpt-days" role="group" aria-label="Jour">
        <button type="button" className={`nc-chip${isToday ? " nc-chip--on" : ""}`} onClick={() => changeDay(today)}>
          Aujourd&apos;hui
        </button>
        <button type="button" className={`nc-chip${day === tomorrow ? " nc-chip--on" : ""}`} onClick={() => changeDay(tomorrow)}>
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

      {board && tour && current && (
        <>
          <section className="lv-hero" style={{ "--tc": tourColor(current.index) } as CSSProperties} aria-label={tour.name}>
            <div className="lv-hero-top">
              <div>
                <p className="lv-eyebrow">{tour.name}</p>
                <p className="lv-hero-time">{slotLabel(current.slot)}</p>
                <p className="lv-hero-sub">
                  {plural(stops.length, "fournisseur")} · {plural(stats.total, "pièce")}
                  {stats.unavailable > 0 ? ` · ${stats.unavailable} indispo` : ""}
                </p>
              </div>
              <div className="lv-hero-count">
                <strong>
                  {stats.done}/{stats.total}
                </strong>
                <span>récupérées</span>
              </div>
            </div>
            {stats.total > 0 && (
              <div className="lv-bar">
                <span style={{ width: `${pct(stats.done, stats.total)}%` }} />
              </div>
            )}
            <p className="lv-hero-status">
              <span className={`lv-pill lv-pill--${tour.status}`}>{TOUR_STATUS_LABEL[tour.status]}</span>
              {departureText(current, day)}
              {tour.livreurId && tour.livreurId !== livreurId ? " · confiée à un autre livreur" : ""}
              {queuedTours.has(tour.id) && <CloudOff className="lv-queued" aria-label="En attente de réseau" />}
            </p>
            {tour.note && <p className="lv-hero-note">📝 {tour.note}</p>}
            {stops.length > 0 && (
              <div className="lv-hero-grid" role="list" aria-label="Pièces à prendre par fournisseur">
                {stops.map((s, i) => (
                  <button
                    type="button"
                    key={s.supplierId}
                    role="listitem"
                    className={`lv-hero-cell${s.left === 0 ? " lv-hero-cell--done" : ""}`}
                    onClick={() => openStop(tour.id, s.supplierId)}
                    aria-label={`${s.supplier} : ${s.left === 0 ? "tout récupéré" : plural(s.left, "pièce") + " à prendre"}`}
                  >
                    <span>{shorts[i]}</span>
                    <strong>{s.left === 0 ? <Check /> : s.left}</strong>
                  </button>
                ))}
              </div>
            )}
            {isToday && (
              <div className="lv-hero-actions">
                {tour.status === "PLANIFIEE" && (
                  <button type="button" className="lv-hero-btn" onClick={() => onTourStatus(tour, "EN_COURS", stats.pending)}>
                    <Play /> Démarrer la tournée
                  </button>
                )}
                {tour.status === "EN_COURS" && (
                  <button type="button" className="lv-hero-btn" onClick={() => onTourStatus(tour, "TERMINEE", stats.pending)}>
                    <Flag /> Tournée terminée
                  </button>
                )}
                {tour.status === "TERMINEE" && (
                  <button type="button" className="lv-hero-btn lv-hero-btn--ghost" onClick={() => onTourStatus(tour, "EN_COURS", stats.pending)}>
                    <RotateCcw /> Reprendre la tournée
                  </button>
                )}
              </div>
            )}
          </section>

          {others.length > 0 && (
            <section aria-label="Autres tournées du jour">
              <p className="lv-section-title">
                <Clock3 /> Autres tournées {isToday ? "du jour" : "de demain"}
              </p>
              <div className="lv-next-grid">
                {others.map((s) => {
                  const t = s.tour as SupplierTour;
                  const tl = board.lines.filter((l) => l.tourId === t.id);
                  const ts = tourStats(tl);
                  const sup = new Set(tl.map((l) => l.supplierId)).size;
                  return (
                    <button
                      type="button"
                      key={s.key}
                      className={`lv-next-card lv-next-card--${t.status}`}
                      style={{ "--tc": tourColor(s.index) } as CSSProperties}
                      onClick={() => setSelected(t.id)}
                      aria-label={`${t.name} à ${slotLabel(s.slot)} : ${plural(ts.total, "pièce")}, ${TOUR_STATUS_LABEL[t.status]}`}
                    >
                      <span className="lv-next-time">{slotLabel(s.slot)}</span>
                      <strong>{ts.total}</strong>
                      <span className="lv-next-meta">pièce{ts.total > 1 ? "s" : ""}</span>
                      <span className="lv-next-sup">{plural(sup, "fournisseur")}</span>
                      <span className="lv-next-status">{ts.total > 0 && ts.done === ts.total ? "Tout récupéré" : TOUR_STATUS_LABEL[t.status]}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {kinds.known && stats.total > 0 && (
            <section className="lv-kinds" aria-label="Caisses">
              {KINDS.map((k) => {
                const Icon = KIND_ICON[k];
                return (
                  <div key={k} className={`lv-kind lv-kind--${k}`}>
                    <span className="lv-kind-head">
                      <Icon /> {KIND_LABEL[k].toUpperCase()}
                    </span>
                    <strong>{kinds[k]}</strong>
                    <span className="lv-kind-sub">à prendre · caisse {KIND_LABEL[k].toLowerCase()}</span>
                  </div>
                );
              })}
            </section>
          )}

          {overview && overview.total > 0 && (
            <details className="lv-details">
              <summary>
                <span>Vue de la journée</span>
                <ChevronDown />
              </summary>
              <DayOverviewGrid overview={overview} activeKey={activeKey} onCell={openStop} />
            </details>
          )}

          <section className="lv-stops" aria-label="Fournisseurs">
            {stops.map((stop, i) => {
              const key = cellKey(tour.id, stop.supplierId);
              return (
                <details
                  key={key}
                  className={`lv-acc${activeKey === key ? " lv-acc--active" : ""}`}
                  open={i === firstOpen}
                  ref={(el) => {
                    if (el) accordions.current.set(key, el);
                    else accordions.current.delete(key);
                  }}
                >
                  <summary className="lv-acc-head">
                    <span className={`lv-acc-code${stop.left > 0 ? " lv-acc-code--on" : ""}`}>{shorts[i]}</span>
                    <span className="lv-acc-titles">
                      <strong>{stop.supplier}</strong>
                      <span>
                        <em className={stop.left > 0 ? "lv-warn" : "lv-ok"}>{stop.left}</em> à récupérer · {stop.lines.length} réf.
                      </span>
                    </span>
                    <ChevronDown className="lv-acc-chevron" />
                  </summary>
                  <div className="lv-acc-body">
                    {stop.lines.map((l) => (
                      <PartRow
                        key={l.id}
                        line={l}
                        queued={queuedLines.has(l.id)}
                        deferring={deferring.has(l.id)}
                        canDefer={online && isToday}
                        next={next}
                        onPickup={onPickup}
                        onDefer={onDefer}
                      />
                    ))}
                  </div>
                </details>
              );
            })}
            {lines.length === 0 && <p className="lp-meta">Aucune pièce sur cette tournée.</p>}
          </section>
        </>
      )}
    </>
  );
}

function PartRow({
  line,
  queued,
  deferring,
  canDefer,
  next,
  onPickup,
  onDefer,
}: {
  line: TourLine;
  queued: boolean;
  deferring: boolean;
  canDefer: boolean;
  next: NextTour;
  onPickup: Props["onPickup"];
  onDefer: Props["onDefer"];
}) {
  const state = pickupState(line);
  const unavailable = line.pickupStatus === "UNAVAILABLE";
  const Icon = line.kind ? KIND_ICON[line.kind] : null;
  return (
    <article className={`lv-part lv-part--${state}`}>
      <button
        type="button"
        role="checkbox"
        aria-checked={state === "picked"}
        aria-label={`${line.reference} : ${PICKUP_STATE_LABEL[state]}`}
        className="lv-status"
        disabled={state === "received"}
        onClick={() => onPickup(line, state === "picked" ? null : "PICKED_UP")}
      >
        {state === "picked" ? <Check /> : state === "received" ? <Store /> : state === "unavailable" ? <Ban /> : null}
      </button>
      <div className="lv-part-body">
        <p className="lv-part-ref">
          <strong>
            {line.reference}
            {line.quantity > 1 ? ` ×${line.quantity}` : ""}
          </strong>
          {line.kind && Icon && (
            <span className={`lv-badge lv-badge--${line.kind}`}>
              <Icon />
              {KIND_LABEL[line.kind]}
            </span>
          )}
          {queued && <CloudOff className="lv-queued" aria-label="En attente de réseau" />}
        </p>
        <p className="lv-part-meta">
          {line.designation}
          {line.referenceCommande ? ` · réf. ${line.referenceCommande}` : ""} · {line.vendeur}
        </p>
        {state !== "pending" && (
          <p className={`lv-part-state lv-part-state--${state}`}>
            {PICKUP_STATE_LABEL[state]}
            {line.pickupAt && state !== "received" ? ` · ${fmtHour(line.pickupAt)}` : ""}
          </p>
        )}
        {state !== "received" && (
          <div className="lv-part-actions">
            <button
              type="button"
              className={`lv-mini${unavailable ? " lv-mini--on" : ""}`}
              aria-pressed={unavailable}
              onClick={() => onPickup(line, unavailable ? null : "UNAVAILABLE")}
            >
              <Ban />
              Indispo
            </button>
            {state !== "picked" && (
              <button
                type="button"
                className="lv-mini lv-mini--defer"
                disabled={!canDefer || deferring || queued}
                title={canDefer ? undefined : "Il faut du réseau, et la tournée du jour, pour reporter une pièce"}
                onClick={() => onDefer(line, next)}
              >
                {deferring ? <Loader2 className="nc-spin" /> : <Clock3 />}
                Reporter à {next.slot.replace(":", "H")}
                {next.nextDay ? " demain" : ""}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
