"use client";

import { Building2, Check, CheckCircle2, CloudOff, Loader2, MapPin, Navigation, Phone, RotateCcw, Store, Wrench } from "lucide-react";
import { mapsLink } from "@/lib/data/delivery";
import { fmtHour, returnStats, slotLabel, type SupplierTour, type SupplierTourBoard, type TourReturn } from "@/lib/data/tournees";

type Props = {
  board: SupplierTourBoard | null;
  day: string;
  today: string;
  tomorrow: string;
  onDay: (day: string) => void;
  loading: boolean;
  error: string | null;
  /** Returns whose gesture is waiting for the network. */
  queued: ReadonlySet<string>;
  onComplete: (ret: TourReturn, done: boolean) => void;
};

/**
 * Livreur « Retours » tab: what the counter handed to today's tournées —
 * parts to collect at a garage (garage → magasin) and returns to drop at a
 * supplier with their bon de retour (magasin → fournisseur).
 */
export function ReturnsTab({ board, day, today, tomorrow, onDay, loading, error, queued, onComplete }: Props) {
  const isToday = day === today;
  const returns = board?.returns ?? [];
  const garage = returns.filter((r) => r.leg === "GARAGE_TO_STORE");
  const supplier = returns.filter((r) => r.leg === "STORE_TO_SUPPLIER");
  const tourById = new Map((board?.tours ?? []).map((t) => [t.id, t]));

  return (
    <>
      <div className="lpt-days" role="group" aria-label="Jour">
        <button type="button" className={`nc-chip${isToday ? " nc-chip--on" : ""}`} onClick={() => onDay(today)}>
          Aujourd&apos;hui
        </button>
        <button type="button" className={`nc-chip${day === tomorrow ? " nc-chip--on" : ""}`} onClick={() => onDay(tomorrow)}>
          Demain
        </button>
        {loading && <Loader2 className="h-4 w-4 nc-spin lpt-days-spin" />}
      </div>

      {error && <div className="nc-error">{error}</div>}

      {!board && !error && (
        <div className="lp-empty lp-empty--offline">
          {loading ? <Loader2 className="h-8 w-8 nc-spin" /> : <CloudOff className="h-8 w-8" />}
          <p>{loading ? "Chargement des retours…" : "Retours pas encore chargés : ils s'afficheront dès que le téléphone aura du réseau."}</p>
        </div>
      )}

      {board && returns.length === 0 && (
        <div className="lp-empty">
          <CheckCircle2 className="h-8 w-8" />
          <p>Aucun retour confié pour {isToday ? "aujourd'hui" : "demain"}.</p>
        </div>
      )}

      {board && returns.length > 0 && (
        <>
          <section className="lv-ret-kpis" aria-label="Retours du jour">
            <div className="lv-ret-kpi lv-ret-kpi--garage">
              <span className="lv-ret-kpi-icons">
                <Wrench /> → <Store />
              </span>
              <p>GARAGE → MAGASIN</p>
              <strong>{returnStats(garage).left}</strong>
              <span>à récupérer</span>
            </div>
            <div className="lv-ret-kpi lv-ret-kpi--supplier">
              <span className="lv-ret-kpi-icons">
                <Store /> → <Building2 />
              </span>
              <p>MAGASIN → FOURN.</p>
              <strong>{returnStats(supplier).left}</strong>
              <span>à déposer</span>
            </div>
          </section>

          <ReturnSection
            title="GARAGE → MAGASIN"
            tone="garage"
            icon={Wrench}
            items={garage}
            action="Récupéré"
            doneLabel="Récupérée"
            tourById={tourById}
            queued={queued}
            isToday={isToday}
            onComplete={onComplete}
          />
          <ReturnSection
            title="MAGASIN → FOURNISSEUR"
            tone="supplier"
            icon={Building2}
            items={supplier}
            action="Déposé"
            doneLabel="Déposée"
            tourById={tourById}
            queued={queued}
            isToday={isToday}
            onComplete={onComplete}
          />
        </>
      )}
    </>
  );
}

function ReturnSection({
  title,
  tone,
  icon: Icon,
  items,
  action,
  doneLabel,
  tourById,
  queued,
  isToday,
  onComplete,
}: {
  title: string;
  tone: "garage" | "supplier";
  icon: typeof Wrench;
  items: TourReturn[];
  action: string;
  doneLabel: string;
  tourById: Map<string, SupplierTour>;
  queued: ReadonlySet<string>;
  isToday: boolean;
  onComplete: Props["onComplete"];
}) {
  if (items.length === 0) return null;
  const stats = returnStats(items);
  return (
    <section className={`lv-ret lv-ret--${tone}`} aria-label={title}>
      <p className="lv-ret-head">
        <Icon /> {title}
        <span>
          {stats.done}/{stats.total}
        </span>
      </p>
      <div className="lv-ret-list">
        {items.map((r) => {
          const t = tourById.get(r.tourId);
          const link = r.leg === "GARAGE_TO_STORE" ? mapsLink(r.address, r.city) : null;
          const waiting = queued.has(r.id);
          return (
            <article key={r.id} className={`lv-ret-item${r.done ? " lv-ret-item--done" : ""}`}>
              <div className="lv-ret-item-top">
                <div className="lv-ret-item-text">
                  <strong>
                    {r.designation}
                    {r.reference && r.reference !== r.designation ? ` · ${r.reference}` : ""}
                  </strong>
                  <span>
                    {r.leg === "STORE_TO_SUPPLIER" ? "→ " : ""}
                    {r.destination}
                    {r.slip ? ` · bon ${r.slip}` : ""}
                    {r.ref ? ` · ${r.ref}` : ""}
                    {t ? ` · ${t.name} ${slotLabel(t.slot)}` : ""}
                  </span>
                </div>
                {waiting ? (
                  <CloudOff className="lv-queued" aria-label="En attente de réseau" />
                ) : (
                  !r.done && <span className="lv-ret-wait">EN ATTENTE</span>
                )}
              </div>
              {r.leg === "GARAGE_TO_STORE" && (r.address || r.city) && (
                <p className="lp-address">
                  <MapPin className="h-4 w-4" />
                  <span>
                    {r.address && <strong>{r.address}</strong>}
                    {r.city ? (r.address ? ` · ${r.city}` : r.city) : ""}
                  </span>
                </p>
              )}
              {r.note && <p className="lp-note">📝 {r.note}</p>}
              {r.leg === "GARAGE_TO_STORE" && (r.phone || link) && (
                <div className="lp-contact">
                  {r.phone && (
                    <a href={`tel:${r.phone.replace(/\s/g, "")}`} className="lp-call">
                      <Phone className="h-4 w-4" />
                      Appeler
                    </a>
                  )}
                  {link && (
                    <a href={link} target="_blank" rel="noreferrer" className="lp-call lp-call--nav">
                      <Navigation className="h-4 w-4" />
                      Itinéraire
                    </a>
                  )}
                </div>
              )}
              {r.done ? (
                <p className="lv-ret-done">
                  <Check />
                  {doneLabel}
                  {r.doneAt ? ` à ${fmtHour(r.doneAt)}` : ""}
                  {r.doneBy ? ` par ${r.doneBy}` : ""}
                  {isToday && !waiting && (
                    <button type="button" className="lv-ret-undo" onClick={() => onComplete(r, false)}>
                      <RotateCcw />
                      Annuler
                    </button>
                  )}
                </p>
              ) : (
                <button
                  type="button"
                  className={`lv-ret-btn lv-ret-btn--${tone}`}
                  disabled={!isToday || waiting}
                  title={isToday ? undefined : "À faire le jour de la tournée"}
                  onClick={() => onComplete(r, true)}
                >
                  <Check />
                  {action.toUpperCase()}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
