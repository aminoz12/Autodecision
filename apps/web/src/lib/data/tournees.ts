import type { SupabaseClient } from "@supabase/supabase-js";
import { DeliveryNetworkError, isNetworkError, LivreurDisabledError } from "@/lib/data/delivery";

/* ------------------------------------------------------------------ */
/*  Tournée fournisseurs — at each tournée the livreur collects, at    */
/*  every supplier, the parts the vendeurs ordered. The counter board  */
/*  (/dashboard/tournees) and the livreur's « Fournisseurs » tab read  */
/*  the same source: supplier_tour_board(date).                        */
/* ------------------------------------------------------------------ */

export type TourStatus = "PLANIFIEE" | "EN_COURS" | "TERMINEE";
export type PickupStatus = "PICKED_UP" | "UNAVAILABLE";
/** What the board shows for a part — received at the magasin wins over the pickup. */
export type PickupState = "received" | "picked" | "unavailable" | "pending";

export const TOUR_STATUS_LABEL: Record<TourStatus, string> = {
  PLANIFIEE: "Planifiée",
  EN_COURS: "En cours",
  TERMINEE: "Terminée",
};

export const PICKUP_STATE_LABEL: Record<PickupState, string> = {
  pending: "À récupérer",
  picked: "Récupérée",
  unavailable: "Indisponible",
  received: "Reçue au magasin",
};

/** The fixed tournées — same slots as computeTournee() and next_tournee(). */
export const STANDARD_TOURS: ReadonlyArray<{ name: string; slot: string }> = [
  { name: "Tournée 1", slot: "10:00" },
  { name: "Tournée 2", slot: "13:00" },
  { name: "Tournée 3", slot: "15:00" },
  { name: "Tournée 4", slot: "17:30" },
];

/** One colour per tournée of the day (by departure order). */
export const TOUR_COLORS = ["#0570DE", "#DF1B41", "#1EA672", "#ED6704", "#7C3AED", "#0E9CA5"];

/** One colour per vendeur, stable in the order of the team list. */
export const VENDEUR_COLORS = ["#1EA672", "#DF1B41", "#0570DE", "#ED6704", "#7C3AED", "#0E9CA5", "#C2255C", "#8B5E34"];

export type SupplierTour = {
  id: string;
  name: string;
  /** Departure "HH:MM" (Paris). */
  slot: string | null;
  status: TourStatus;
  startedAt: string | null;
  completedAt: string | null;
  /** Instruction from the magasin to the livreur. */
  note: string | null;
  livreurId: string | null;
  livreurName: string | null;
};

export type TourLine = {
  id: string;
  tourId: string;
  orderId: string;
  orderRef: string;
  supplierId: string;
  supplier: string;
  vendeurId: string | null;
  vendeur: string;
  reference: string;
  /** Supplier order reference, when the vendeur noted one. */
  referenceCommande: string | null;
  designation: string;
  quantity: number;
  received: number;
  receptionStatus: string;
  pickupStatus: PickupStatus | null;
  pickupAt: string | null;
  /** Who ticked it (display name). */
  pickupBy: string | null;
  isRestock: boolean;
  /** The crate the part goes to; null when the database RPC predates it. */
  kind: PartKind | null;
  /** Counter staff only — never sent to a livreur. */
  client: string | null;
};

/** The crate a picked part goes to: a garage order, a counter client, or the stock. */
export type PartKind = "GARAGE" | "COMPTOIR" | "STOCK";

export const KIND_LABEL: Record<PartKind, string> = {
  GARAGE: "Garage",
  COMPTOIR: "Comptoir",
  STOCK: "Stock",
};

/** A return the counter handed to the livreur: collect at the garage, or drop at the supplier. */
export type ReturnLeg = "GARAGE_TO_STORE" | "STORE_TO_SUPPLIER";

export type TourReturn = {
  id: string;
  tourId: string;
  leg: ReturnLeg;
  done: boolean;
  /** Return reference (RET-…). */
  ref: string | null;
  designation: string;
  /** Part reference, when the return is tied to an order line. */
  reference: string | null;
  orderRef: string | null;
  /** The garage (collect) or the supplier (drop). */
  destination: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  /** Bon de retour number handed to the supplier. */
  slip: string | null;
  /** Instruction from the counter. */
  note: string | null;
  doneAt: string | null;
  doneBy: string | null;
};

export type SupplierTourBoard = {
  date: string;
  tours: SupplierTour[];
  lines: TourLine[];
  /** Livreur attitré par nom de tournée (comptoir seulement). */
  defaults: Record<string, { livreurId: string; livreurName: string }>;
  /** Parts to collect on the following days (orders after 17:00 go to the next day's Tournée 1). */
  upcoming: Array<{ date: string; count: number }>;
  /** Returns the counter handed to the day's tournées. */
  returns: TourReturn[];
};

/* ------------------------------------------------------------------ */
/*  Parsing                                                           */
/* ------------------------------------------------------------------ */

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseTourStatus(v: unknown): TourStatus {
  return v === "EN_COURS" || v === "TERMINEE" ? v : "PLANIFIEE";
}

function parsePickupStatus(v: unknown): PickupStatus | null {
  return v === "PICKED_UP" || v === "UNAVAILABLE" ? v : null;
}

function parseKind(v: unknown): PartKind | null {
  return v === "GARAGE" || v === "COMPTOIR" || v === "STOCK" ? v : null;
}

function parseReturns(v: unknown): TourReturn[] {
  return (Array.isArray(v) ? v : [])
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const leg = r.leg === "GARAGE_TO_STORE" || r.leg === "STORE_TO_SUPPLIER" ? r.leg : null;
      return {
        id: String(r.id ?? ""),
        tourId: String(r.tour_id ?? ""),
        leg: leg as ReturnLeg,
        done: r.status === "FAIT",
        ref: text(r.ref),
        designation: text(r.designation) ?? text(r.reference) ?? "Pièce",
        reference: text(r.reference),
        orderRef: text(r.order_ref),
        destination: text(r.destination) ?? (leg === "GARAGE_TO_STORE" ? "Garage" : "Fournisseur"),
        address: text(r.address),
        city: text(r.city),
        phone: text(r.phone),
        slip: text(r.slip),
        note: text(r.note),
        doneAt: text(r.done_at),
        doneBy: text(r.done_by),
      };
    })
    .filter((r) => r.id && r.tourId && r.leg);
}

/** supplier_tour_board() JSON → board; malformed rows are dropped. */
export function parseSupplierTourBoard(json: unknown): SupplierTourBoard {
  const r = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const tours = Array.isArray(r.tours) ? r.tours : [];
  const lines = Array.isArray(r.lines) ? r.lines : [];
  const defaults: SupplierTourBoard["defaults"] = {};
  for (const raw of Array.isArray(r.defaults) ? r.defaults : []) {
    const d = (raw ?? {}) as Record<string, unknown>;
    const name = text(d.tour_name);
    const livreurId = text(d.livreur_id);
    if (name && livreurId) defaults[name] = { livreurId, livreurName: text(d.livreur_name) ?? "Livreur" };
  }
  const upcoming = (Array.isArray(r.upcoming) ? r.upcoming : [])
    .map((raw) => {
      const u = (raw ?? {}) as Record<string, unknown>;
      return { date: text(u.date) ?? "", count: num(u.count) };
    })
    .filter((u) => u.date && u.count > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    date: text(r.date) ?? "",
    defaults,
    upcoming,
    returns: parseReturns(r.returns),
    tours: tours
      .map((raw) => {
        const t = (raw ?? {}) as Record<string, unknown>;
        return {
          id: String(t.id ?? ""),
          name: text(t.name) ?? "Tournée",
          slot: text(t.slot),
          status: parseTourStatus(t.status),
          startedAt: text(t.started_at),
          completedAt: text(t.completed_at),
          note: text(t.note),
          livreurId: text(t.livreur_id),
          livreurName: text(t.livreur_name),
        };
      })
      .filter((t) => t.id),
    lines: lines
      .map((raw) => {
        const l = (raw ?? {}) as Record<string, unknown>;
        return {
          id: String(l.id ?? ""),
          tourId: String(l.tour_id ?? ""),
          orderId: String(l.order_id ?? ""),
          orderRef: String(l.order_ref ?? ""),
          supplierId: String(l.supplier_id ?? ""),
          supplier: text(l.supplier) ?? "Fournisseur",
          vendeurId: text(l.vendeur_id),
          vendeur: text(l.vendeur) ?? "Vendeur",
          reference: String(l.reference ?? ""),
          referenceCommande: text(l.reference_commande),
          designation: String(l.designation ?? ""),
          quantity: num(l.quantity),
          received: num(l.received),
          receptionStatus: String(l.reception_status ?? "PENDING"),
          pickupStatus: parsePickupStatus(l.pickup_status),
          pickupAt: text(l.pickup_at),
          pickupBy: text(l.pickup_by),
          isRestock: l.is_restock === true,
          kind: parseKind(l.kind),
          client: text(l.client),
        };
      })
      .filter((l) => l.id && l.tourId && l.supplierId),
  };
}

/* ------------------------------------------------------------------ */
/*  States & counts                                                   */
/* ------------------------------------------------------------------ */

export function pickupState(line: Pick<TourLine, "receptionStatus" | "pickupStatus">): PickupState {
  if (line.receptionStatus === "RECEIVED") return "received";
  if (line.pickupStatus === "PICKED_UP") return "picked";
  if (line.pickupStatus === "UNAVAILABLE" || line.receptionStatus === "NOT_RECEIVED") return "unavailable";
  return "pending";
}

export type TourStats = Record<PickupState, number> & {
  total: number;
  /** Récupérées + déjà reçues. */
  done: number;
};

export function tourStats(lines: TourLine[]): TourStats {
  const s: TourStats = { total: 0, pending: 0, picked: 0, unavailable: 0, received: 0, done: 0 };
  for (const l of lines) {
    s.total += 1;
    s[pickupState(l)] += 1;
  }
  s.done = s.picked + s.received;
  return s;
}

export function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

/* ------------------------------------------------------------------ */
/*  Dates — tournées live on Paris dates and times                    */
/* ------------------------------------------------------------------ */

/** yyyy-mm-dd of `now` in Paris. */
export function parisDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** The instant of a Paris wall-clock time (whatever the browser time zone). */
export function parisDateTime(ymd: string, hhmm: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const seenInParis = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (seenInParis - guess));
}

/** "jeudi 01/08/2026" */
export function fmtBoardDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** "Demain", "Après-demain" or "jeu. 17/09" relative to `from`. */
export function fmtRelativeDay(ymd: string, from: string): string {
  if (ymd === addDays(from, 1)) return "Demain";
  if (ymd === addDays(from, 2)) return "Après-demain";
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
  });
}

/** "10:00" → "10H00" */
export function slotLabel(slot: string | null): string {
  return slot ? slot.replace(":", "H") : "—";
}

export function fmtHour(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
}

function fmtDuration(minutes: number): string {
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return `${days} j`;
  }
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/*  Schedule                                                          */
/* ------------------------------------------------------------------ */

export type TourSlot = {
  key: string;
  name: string;
  slot: string | null;
  /** null: nothing ordered for this tournée yet (no delivery_tours row). */
  tour: SupplierTour | null;
  /** Departure order in the day — drives the colour. */
  index: number;
};

/**
 * The tournées of a day in departure order. The counter sees the fixed
 * tournées even when nothing is ordered yet; the livreur only the tours
 * the server returned for them.
 */
export function scheduleSlots(tours: SupplierTour[], withStandard: boolean): TourSlot[] {
  const used = new Set<string>();
  const slots: Omit<TourSlot, "index">[] = [];
  if (withStandard) {
    for (const s of STANDARD_TOURS) {
      const tour = tours.find((t) => t.name === s.name && !used.has(t.id)) ?? null;
      if (tour) used.add(tour.id);
      slots.push({ key: tour?.id ?? s.name, name: s.name, slot: tour?.slot ?? s.slot, tour });
    }
  }
  for (const tour of tours) {
    if (!used.has(tour.id)) slots.push({ key: tour.id, name: tour.name, slot: tour.slot, tour });
  }
  slots.sort((a, b) => (a.slot ?? "99:99").localeCompare(b.slot ?? "99:99") || a.name.localeCompare(b.name, "fr"));
  return slots.map((s, index) => ({ ...s, index }));
}

export function tourColor(index: number): string {
  return TOUR_COLORS[index % TOUR_COLORS.length];
}

/**
 * The standard tournée that follows one leaving at `slot` — the same rule as
 * next_standard_tour() in the database: 10h → 13h → 15h → 17h30 → 10h the
 * next day. A tour without a slot goes to the next morning.
 */
export function nextStandardTour(slot: string | null): { name: string; slot: string; nextDay: boolean } {
  if (slot && slot < "13:00") return { name: "Tournée 2", slot: "13:00", nextDay: false };
  if (slot && slot < "15:00") return { name: "Tournée 3", slot: "15:00", nextDay: false };
  if (slot && slot < "17:30") return { name: "Tournée 4", slot: "17:30", nextDay: false };
  return { name: "Tournée 1", slot: "10:00", nextDay: true };
}

export type ReturnStats = { total: number; done: number; left: number };

export function returnStats(returns: TourReturn[], leg?: ReturnLeg): ReturnStats {
  const list = leg ? returns.filter((r) => r.leg === leg) : returns;
  const done = list.filter((r) => r.done).length;
  return { total: list.length, done, left: list.length - done };
}

/**
 * The tournée to put forward: the one in progress, else a departure that
 * is late with parts still to collect, else the next departure, else the
 * last tournée of the day.
 */
export function focusSlot(
  slots: TourSlot[],
  date: string,
  pendingByTour: Map<string, number>,
  now: Date = new Date(),
): TourSlot | null {
  if (slots.length === 0) return null;
  const running = slots.find((s) => s.tour?.status === "EN_COURS");
  if (running) return running;
  const today = parisDate(now);
  if (date > today) return slots.find((s) => s.tour) ?? slots[0];
  if (date < today) return slots[slots.length - 1];
  const t = now.getTime();
  const departs = (s: TourSlot) => (s.slot ? parisDateTime(date, s.slot).getTime() : Number.POSITIVE_INFINITY);
  const late = slots.find(
    (s) => s.tour?.status === "PLANIFIEE" && departs(s) < t && (pendingByTour.get(s.tour.id) ?? 0) > 0,
  );
  if (late) return late;
  const next = slots.find((s) => s.tour?.status !== "TERMINEE" && departs(s) >= t);
  return next ?? slots[slots.length - 1];
}

/** « Départ dans 2 h 06 », « En cours depuis 10:32 », « Terminée à 11:15 »… */
export function departureText(slot: TourSlot, date: string, now: Date = new Date()): string {
  const tour = slot.tour;
  if (tour?.status === "TERMINEE") return tour.completedAt ? `Terminée à ${fmtHour(tour.completedAt)}` : "Terminée";
  if (tour?.status === "EN_COURS") return tour.startedAt ? `En cours depuis ${fmtHour(tour.startedAt)}` : "En cours";
  if (!slot.slot) return "Horaire non défini";
  const minutes = Math.round((parisDateTime(date, slot.slot).getTime() - now.getTime()) / 60_000);
  if (minutes > 0) return `Départ dans ${fmtDuration(minutes)}`;
  if (minutes === 0) return "Départ maintenant";
  return `Départ prévu il y a ${fmtDuration(-minutes)}`;
}

/* ------------------------------------------------------------------ */
/*  Counter board grid: tournée × vendeur rows, one column / supplier */
/* ------------------------------------------------------------------ */

export type TourFilters = {
  vendeur: string;
  supplierId: string;
  query: string;
};

function normalize(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function vendeurKey(line: Pick<TourLine, "vendeurId" | "vendeur">): string {
  return line.vendeurId ?? line.vendeur;
}

export function filterTourLines(lines: TourLine[], f: TourFilters): TourLine[] {
  const q = normalize(f.query);
  return lines.filter(
    (l) =>
      (!f.vendeur || vendeurKey(l) === f.vendeur) &&
      (!f.supplierId || l.supplierId === f.supplierId) &&
      (!q ||
        [l.reference, l.referenceCommande, l.designation, l.orderRef, l.client].some(
          (v) => v && normalize(v).includes(q),
        )),
  );
}

export type GridRow = {
  vendeurKey: string;
  vendeur: string;
  /** supplierId → parts */
  cells: Map<string, TourLine[]>;
  count: number;
};

export type GridSlot = TourSlot & { rows: GridRow[]; stats: TourStats };

export type TourGrid = {
  suppliers: Array<{ id: string; name: string; count: number }>;
  slots: GridSlot[];
  total: number;
};

export function buildTourGrid(slots: TourSlot[], lines: TourLine[]): TourGrid {
  const tourIds = new Set(slots.flatMap((s) => (s.tour ? [s.tour.id] : [])));
  const byTour = new Map<string, TourLine[]>();
  const suppliers = new Map<string, { id: string; name: string; count: number }>();
  let total = 0;
  for (const l of lines) {
    if (!tourIds.has(l.tourId)) continue;
    total += 1;
    const list = byTour.get(l.tourId);
    if (list) list.push(l);
    else byTour.set(l.tourId, [l]);
    const sup = suppliers.get(l.supplierId);
    if (sup) sup.count += 1;
    else suppliers.set(l.supplierId, { id: l.supplierId, name: l.supplier, count: 1 });
  }

  return {
    suppliers: [...suppliers.values()].sort((a, b) => a.name.localeCompare(b.name, "fr")),
    total,
    slots: slots.map((s) => {
      const mine = s.tour ? byTour.get(s.tour.id) ?? [] : [];
      const rows = new Map<string, GridRow>();
      for (const l of mine) {
        const key = vendeurKey(l);
        let row = rows.get(key);
        if (!row) {
          row = { vendeurKey: key, vendeur: l.vendeur, cells: new Map(), count: 0 };
          rows.set(key, row);
        }
        const cell = row.cells.get(l.supplierId);
        if (cell) cell.push(l);
        else row.cells.set(l.supplierId, [l]);
        row.count += 1;
      }
      return {
        ...s,
        rows: [...rows.values()].sort((a, b) => a.vendeur.localeCompare(b.vendeur, "fr")),
        stats: tourStats(mine),
      };
    }),
  };
}

/** Vendeur colours: team order first (stable from day to day), then anyone else by name. */
export function vendeurColors(teamOrder: string[], lines: TourLine[]): Map<string, string> {
  const keys = [...teamOrder];
  const others = new Map<string, string>();
  for (const l of lines) {
    const key = vendeurKey(l);
    if (!keys.includes(key)) others.set(key, l.vendeur);
  }
  keys.push(...[...others.entries()].sort((a, b) => a[1].localeCompare(b[1], "fr")).map(([k]) => k));
  return new Map(keys.map((k, i) => [k, VENDEUR_COLORS[i % VENDEUR_COLORS.length]]));
}

/* ------------------------------------------------------------------ */
/*  Livreur view: one stop per supplier                                */
/* ------------------------------------------------------------------ */

export type SupplierStop = {
  supplierId: string;
  supplier: string;
  lines: TourLine[];
  /** Parts still to collect at this supplier. */
  left: number;
};

/** Suppliers by name, parts by reference — the list never jumps while ticking. */
export function supplierStops(lines: TourLine[]): SupplierStop[] {
  const stops = new Map<string, SupplierStop>();
  for (const l of lines) {
    let stop = stops.get(l.supplierId);
    if (!stop) {
      stop = { supplierId: l.supplierId, supplier: l.supplier, lines: [], left: 0 };
      stops.set(l.supplierId, stop);
    }
    stop.lines.push(l);
    if (pickupState(l) === "pending") stop.left += 1;
  }
  return [...stops.values()]
    .map((s) => ({ ...s, lines: [...s.lines].sort((a, b) => a.reference.localeCompare(b.reference, "fr")) }))
    .sort((a, b) => a.supplier.localeCompare(b.supplier, "fr"));
}

/* ------------------------------------------------------------------ */
/*  Livreur day overview: tournées down, suppliers across, a count/cell */
/* ------------------------------------------------------------------ */

export type OverviewCell = TourStats & { tourId: string; supplierId: string };

export type OverviewColumn = {
  id: string;
  name: string;
  /** Column head that fits a phone cell: « AZ », « OTTO », « CODI »… */
  short: string;
  count: number;
};

export type OverviewRow = {
  slot: TourSlot;
  /** supplierId → the parts of this tournée at this supplier. */
  cells: Map<string, OverviewCell>;
  stats: TourStats;
};

export type DayOverview = {
  suppliers: OverviewColumn[];
  rows: OverviewRow[];
  total: number;
};

/** What a cell says at a glance. */
export type OverviewCellKind = "empty" | "todo" | "partial" | "done" | "unavailable";

export function overviewCellKind(
  cell: Pick<TourStats, "total" | "pending" | "done" | "unavailable"> | undefined,
): OverviewCellKind {
  if (!cell || cell.total === 0) return "empty";
  if (cell.pending > 0) return cell.done > 0 || cell.unavailable > 0 ? "partial" : "todo";
  return cell.unavailable > 0 ? "unavailable" : "done";
}

/**
 * Column heads short enough for a phone: the first 4 letters of each name,
 * lengthened only when two suppliers would otherwise read the same.
 */
export function shortSupplierLabels(names: string[]): string[] {
  const compact = names.map((n) => normalize(n).replace(/[^a-z0-9]/g, "").toUpperCase() || "?");
  const labels = compact.map((c) => c.slice(0, 4));
  for (let len = 5; ; len += 1) {
    const seen = new Map<string, number>();
    for (const l of labels) seen.set(l, (seen.get(l) ?? 0) + 1);
    let grew = false;
    labels.forEach((l, i) => {
      if ((seen.get(l) ?? 0) > 1 && compact[i].length >= len) {
        labels[i] = compact[i].slice(0, len);
        grew = true;
      }
    });
    if (!grew) break;
  }
  return labels;
}

/** The day as the legacy sheet showed it, with a count per cell instead of the references. */
export function buildDayOverview(slots: TourSlot[], lines: TourLine[]): DayOverview {
  const rows: OverviewRow[] = slots.map((slot) => ({ slot, cells: new Map(), stats: tourStats([]) }));
  const rowByTour = new Map<string, OverviewRow>();
  for (const r of rows) if (r.slot.tour) rowByTour.set(r.slot.tour.id, r);
  const suppliers = new Map<string, OverviewColumn>();
  let total = 0;
  for (const l of lines) {
    const row = rowByTour.get(l.tourId);
    if (!row) continue;
    total += 1;
    const sup = suppliers.get(l.supplierId);
    if (sup) sup.count += 1;
    else suppliers.set(l.supplierId, { id: l.supplierId, name: l.supplier, short: "", count: 1 });
    let cell = row.cells.get(l.supplierId);
    if (!cell) {
      cell = { ...tourStats([]), tourId: l.tourId, supplierId: l.supplierId };
      row.cells.set(l.supplierId, cell);
    }
    const state = pickupState(l);
    for (const s of [cell, row.stats]) {
      s.total += 1;
      s[state] += 1;
      s.done = s.picked + s.received;
    }
  }
  const columns = [...suppliers.values()].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  shortSupplierLabels(columns.map((c) => c.name)).forEach((short, i) => {
    columns[i].short = short;
  });
  return { suppliers: columns, rows, total };
}

type QueuedTourAction = {
  kind: string;
  lineId?: string;
  pickupStatus?: PickupStatus | null;
  tourId?: string;
  tourStatus?: TourStatus;
  returnId?: string;
  returnDone?: boolean;
};

/** Show what the livreur ticked offline on top of the last board loaded. */
export function applyQueuedTourActions(board: SupplierTourBoard, items: QueuedTourAction[]): SupplierTourBoard {
  let { lines, tours, returns } = board;
  for (const item of items) {
    const { lineId, tourId, tourStatus, returnId } = item;
    if (item.kind === "pickup" && lineId) {
      const status = item.pickupStatus ?? null;
      lines = lines.map((l) => (l.id === lineId ? { ...l, pickupStatus: status } : l));
    } else if (item.kind === "tour" && tourId && tourStatus) {
      tours = tours.map((t) => (t.id === tourId ? { ...t, status: tourStatus } : t));
    } else if (item.kind === "return" && returnId && returns.some((r) => r.id === returnId)) {
      const done = item.returnDone !== false;
      returns = returns.map((r) => (r.id === returnId ? { ...r, done, doneAt: done ? new Date().toISOString() : null } : r));
    }
  }
  return lines === board.lines && tours === board.tours && returns === board.returns ? board : { ...board, lines, tours, returns };
}

/* ------------------------------------------------------------------ */
/*  Server calls                                                      */
/* ------------------------------------------------------------------ */

const SERVER_MESSAGES: Array<[RegExp, string]> = [
  [/already been received/i, "Cette pièce est déjà reçue au magasin."],
  [/assigned to another livreur/i, "Cette tournée est confiée à un autre livreur."],
  [/tour date is not available/i, "Cette date de tournée n'est pas accessible."],
  [/back to planned/i, "Seul le magasin peut remettre une tournée en planifiée."],
  [/has been cancelled/i, "Cette commande a été annulée par le magasin."],
  [/not on a supplier tour/i, "Cette pièce n'est pas sur une tournée fournisseur."],
  [/tour not found/i, "Tournée introuvable."],
  [/order line not found/i, "Pièce introuvable."],
  [/livreur not found or inactive/i, "Ce livreur n'existe pas ou est désactivé."],
  [/staff access is required/i, "Accès refusé : reconnectez-vous."],
  [/no later tour to defer to/i, "Pas de tournée suivante pour reporter cette pièce."],
  [/return not found/i, "Retour introuvable."],
  [/return is not on a tour/i, "Ce retour n'est pas sur une tournée."],
  [/no client to collect from/i, "Ce retour n'a pas de garage où le récupérer."],
  [/no supplier to deliver to/i, "Ce retour n'a pas de fournisseur où le déposer."],
  [/unknown return leg/i, "Trajet de retour inconnu."],
];

/** Server (English) error → French message the counter or the livreur can act on. */
export function tourErrorMessage(raw: string): string {
  for (const [re, fr] of SERVER_MESSAGES) if (re.test(raw)) return fr;
  return raw;
}

/** The database does not have the tournée fournisseurs functions yet. */
export class TourBoardUnavailableError extends Error {
  constructor() {
    super("Cette fonction de la tournée n'est pas encore activée sur la base de données (migration à appliquer).");
    this.name = "TourBoardUnavailableError";
  }
}

function toTourError(message: string, code?: string): Error {
  if (code === "PGRST202" || /could not find the function/i.test(message)) return new TourBoardUnavailableError();
  if (/access is disabled/i.test(message)) return new LivreurDisabledError();
  if (isNetworkError(new Error(message))) return new DeliveryNetworkError(message);
  return new Error(tourErrorMessage(message));
}

export async function loadSupplierTourBoard(supabase: SupabaseClient, date: string): Promise<SupplierTourBoard> {
  const { data, error } = await supabase.rpc("supplier_tour_board", { p_date: date });
  if (error) throw toTourError(error.message, error.code);
  return parseSupplierTourBoard(data);
}

/** Récupérée / indisponible chez le fournisseur, or back to « à récupérer » (null). */
export async function setLinePickup(
  supabase: SupabaseClient,
  lineId: string,
  status: PickupStatus | null,
): Promise<void> {
  const { error } = await supabase.rpc("set_line_pickup", { p_line_id: lineId, p_status: status });
  if (error) throw toTourError(error.message, error.code);
}

export async function setSupplierTourStatus(
  supabase: SupabaseClient,
  tourId: string,
  status: TourStatus,
): Promise<void> {
  const { error } = await supabase.rpc("set_supplier_tour_status", { p_tour_id: tourId, p_status: status });
  if (error) throw toTourError(error.message, error.code);
}

/** The part moves to the following standard tournée (created if needed), back to « à récupérer ». */
export async function deferLineToNextTour(
  supabase: SupabaseClient,
  lineId: string,
): Promise<{ tourId: string; tourName: string; slot: string | null; date: string }> {
  const { data, error } = await supabase.rpc("defer_line_to_next_tour", { p_line_id: lineId });
  if (error) throw toTourError(error.message, error.code);
  const r = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return {
    tourId: String(r.tour_id ?? ""),
    tourName: String(r.tour_name ?? "Tournée"),
    slot: typeof r.slot === "string" ? r.slot : null,
    date: String(r.date ?? ""),
  };
}

/** Livreur or counter: the return leg is done (collected at the garage / dropped at the supplier), or back to « à faire ». */
export async function completeReturnLeg(supabase: SupabaseClient, returnId: string, done = true): Promise<void> {
  const { error } = await supabase.rpc("complete_return_leg", { p_return_id: returnId, p_done: done });
  if (error) throw toTourError(error.message, error.code);
}

/** Counter only: hand a return to a tournée (leg null = take it back from the livreur). */
export async function assignReturnLeg(
  supabase: SupabaseClient,
  input: { returnId: string; leg: ReturnLeg | null; tourId: string | null; slip?: string; note?: string },
): Promise<void> {
  const { error } = await supabase.rpc("assign_return_leg", {
    p_return_id: input.returnId,
    p_leg: input.leg,
    p_tour_id: input.tourId,
    p_slip: input.slip ?? null,
    p_note: input.note ?? null,
  });
  if (error) throw toTourError(error.message, error.code);
}

/**
 * Counter only: the delivery_tours row of a tournée on a date, created when no
 * order has opened it yet — so a livreur or a consigne can be set in advance.
 */
export async function ensureSupplierTour(
  supabase: SupabaseClient,
  input: { date: string; name: string; slot: string | null },
): Promise<string> {
  const { data, error } = await supabase.rpc("ensure_supplier_tour", {
    p_date: input.date,
    p_name: input.name,
    p_slot: input.slot,
  });
  if (error) throw toTourError(error.message, error.code);
  const id = typeof data === "string" ? data : "";
  if (!id) throw new Error("La tournée n'a pas pu être créée.");
  return id;
}

/**
 * Counter only: who runs the tournée and the instruction they get.
 * `remember`: true = this livreur runs this tournée every day from now on,
 * false = no more attitré, undefined = leave the default alone.
 */
export async function updateSupplierTour(
  supabase: SupabaseClient,
  tourId: string,
  input: { livreurId: string | null; note: string; remember?: boolean },
): Promise<void> {
  const { error } = await supabase.rpc("update_supplier_tour", {
    p_tour_id: tourId,
    p_livreur_id: input.livreurId,
    p_note: input.note,
    p_remember: input.remember ?? null,
  });
  if (error) throw toTourError(error.message, error.code);
}

/** Counter team in a stable order — gives every vendeur the same colour each day. */
export async function loadTeamOrder(supabase: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id,created_at")
    .eq("organization_id", orgId)
    .is("client_id", null)
    .is("livreur_id", null)
    .order("created_at", { ascending: true });
  if (error) return [];
  return (data ?? []).map((r) => String((r as Record<string, unknown>).user_id));
}
