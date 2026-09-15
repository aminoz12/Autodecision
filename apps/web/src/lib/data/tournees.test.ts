import { describe, expect, it } from "vitest";
import {
  addDays,
  applyQueuedTourActions,
  buildTourGrid,
  departureText,
  filterTourLines,
  fmtRelativeDay,
  focusSlot,
  parisDate,
  parisDateTime,
  parseSupplierTourBoard,
  pickupState,
  scheduleSlots,
  supplierStops,
  tourErrorMessage,
  tourStats,
  VENDEUR_COLORS,
  vendeurColors,
  type SupplierTour,
  type TourLine,
} from "./tournees";

function tour(p: Partial<SupplierTour> & { id: string; name: string }): SupplierTour {
  return {
    slot: null,
    status: "PLANIFIEE",
    startedAt: null,
    completedAt: null,
    note: null,
    livreurId: null,
    livreurName: null,
    ...p,
  };
}

function line(p: Partial<TourLine> & { id: string }): TourLine {
  return {
    tourId: "t1",
    orderId: "o1",
    orderRef: "REQ-2026-00001",
    supplierId: "s-az",
    supplier: "AZ",
    vendeurId: "u1",
    vendeur: "Karim",
    reference: p.id,
    referenceCommande: null,
    designation: "Filtre",
    quantity: 1,
    received: 0,
    receptionStatus: "PENDING",
    pickupStatus: null,
    pickupAt: null,
    pickupBy: null,
    isRestock: false,
    client: null,
    ...p,
  };
}

describe("parseSupplierTourBoard", () => {
  it("maps the RPC JSON and drops malformed rows", () => {
    const board = parseSupplierTourBoard({
      date: "2026-09-15",
      defaults: [{ tour_name: "Tournée 1", livreur_id: "lv1", livreur_name: "Rachid" }, { tour_name: "x" }],
      tours: [
        { id: "t1", name: "Tournée 1", slot: "10:00", status: "EN_COURS", livreur_name: "Rachid" },
        { id: "t2", name: "Tournée 2", status: "WHATEVER" },
        { name: "sans id" },
      ],
      lines: [
        {
          id: "l1",
          tour_id: "t1",
          supplier_id: "s1",
          supplier: "AZ",
          reference: "K1125",
          quantity: "2",
          pickup_status: "PICKED_UP",
          reception_status: "PENDING",
          vendeur: "Karim",
        },
        { id: "l2", tour_id: "t1", supplier_id: "s1", pickup_status: "LOST" },
        { id: "l3", supplier_id: "s1" },
        null,
      ],
    });
    expect(board.date).toBe("2026-09-15");
    expect(board.tours.map((t) => [t.id, t.status])).toEqual([
      ["t1", "EN_COURS"],
      ["t2", "PLANIFIEE"],
    ]);
    expect(board.tours[0].livreurName).toBe("Rachid");
    expect(board.lines.map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(board.lines[0]).toMatchObject({ reference: "K1125", quantity: 2, pickupStatus: "PICKED_UP", supplier: "AZ" });
    expect(board.lines[1].pickupStatus).toBeNull();
    expect(board.defaults).toEqual({ "Tournée 1": { livreurId: "lv1", livreurName: "Rachid" } });
    expect(parseSupplierTourBoard(null)).toEqual({ date: "", tours: [], lines: [], defaults: {}, upcoming: [] });
  });

  it("keeps the upcoming days with parts, in date order", () => {
    const board = parseSupplierTourBoard({
      upcoming: [
        { date: "2026-09-17", count: "2" },
        { date: "2026-09-16", count: 4 },
        { date: "2026-09-18", count: 0 },
        { count: 3 },
      ],
    });
    expect(board.upcoming).toEqual([
      { date: "2026-09-16", count: 4 },
      { date: "2026-09-17", count: 2 },
    ]);
  });
});

describe("pickupState", () => {
  it("puts the magasin reception first, then the pickup", () => {
    expect(pickupState({ receptionStatus: "RECEIVED", pickupStatus: "UNAVAILABLE" })).toBe("received");
    expect(pickupState({ receptionStatus: "PENDING", pickupStatus: "PICKED_UP" })).toBe("picked");
    expect(pickupState({ receptionStatus: "NOT_RECEIVED", pickupStatus: "PICKED_UP" })).toBe("picked");
    expect(pickupState({ receptionStatus: "NOT_RECEIVED", pickupStatus: null })).toBe("unavailable");
    expect(pickupState({ receptionStatus: "BACKORDER", pickupStatus: "UNAVAILABLE" })).toBe("unavailable");
    expect(pickupState({ receptionStatus: "PARTIAL", pickupStatus: null })).toBe("pending");
  });

  it("counts the day", () => {
    const s = tourStats([
      line({ id: "a" }),
      line({ id: "b", pickupStatus: "PICKED_UP" }),
      line({ id: "c", receptionStatus: "RECEIVED" }),
      line({ id: "d", pickupStatus: "UNAVAILABLE" }),
    ]);
    expect(s).toEqual({ total: 4, pending: 1, picked: 1, unavailable: 1, received: 1, done: 2 });
  });
});

describe("Paris dates", () => {
  it("uses the Paris calendar day", () => {
    expect(parisDate(new Date("2026-09-14T22:30:00Z"))).toBe("2026-09-15");
    expect(parisDate(new Date("2026-09-14T21:30:00Z"))).toBe("2026-09-14");
  });

  it("turns a Paris wall-clock time into the right instant, summer and winter", () => {
    expect(parisDateTime("2026-09-15", "10:00").toISOString()).toBe("2026-09-15T08:00:00.000Z");
    expect(parisDateTime("2026-01-15", "17:30").toISOString()).toBe("2026-01-15T16:30:00.000Z");
  });

  it("moves across months", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("names the following days", () => {
    expect(fmtRelativeDay("2026-09-16", "2026-09-15")).toBe("Demain");
    expect(fmtRelativeDay("2026-09-17", "2026-09-15")).toBe("Après-demain");
    expect(fmtRelativeDay("2026-09-18", "2026-09-15")).toMatch(/^ven\.? 18\/09$/);
  });
});

describe("schedule", () => {
  const t1 = tour({ id: "t1", name: "Tournée 1", slot: "10:00" });
  const t2 = tour({ id: "t2", name: "Tournée 2", slot: "13:00" });
  const t3 = tour({ id: "t3", name: "Tournée 3", slot: "15:00" });
  const extra = tour({ id: "t9", name: "Tournée spéciale", slot: "18:00" });
  const date = "2026-09-15";
  const at = (hhmm: string) => parisDateTime(date, hhmm);

  it("shows the four tournées at the counter, real ones merged in", () => {
    const slots = scheduleSlots([extra, t2], true);
    expect(slots.map((s) => [s.name, s.slot, s.tour?.id ?? null, s.index])).toEqual([
      ["Tournée 1", "10:00", null, 0],
      ["Tournée 2", "13:00", "t2", 1],
      ["Tournée 3", "15:00", null, 2],
      ["Tournée 4", "17:30", null, 3],
      ["Tournée spéciale", "18:00", "t9", 4],
    ]);
  });

  it("shows the livreur only the tours they were given", () => {
    expect(scheduleSlots([extra, t2], false).map((s) => s.key)).toEqual(["t2", "t9"]);
  });

  it("puts forward the tour in progress, else a late one with parts left, else the next departure", () => {
    const slots = scheduleSlots([t1, t2, t3], true);
    expect(focusSlot(slots, date, new Map(), at("12:10"))?.name).toBe("Tournée 2");
    expect(focusSlot(slots, date, new Map([["t1", 2]]), at("12:10"))?.name).toBe("Tournée 1");
    const running = scheduleSlots([t1, { ...t3, status: "EN_COURS" }], true);
    expect(focusSlot(running, date, new Map([["t1", 2]]), at("12:10"))?.name).toBe("Tournée 3");
    expect(focusSlot(slots, date, new Map(), at("20:00"))?.name).toBe("Tournée 4");
    expect(focusSlot(slots, "2026-09-16", new Map(), at("12:10"))?.name).toBe("Tournée 1");
  });

  it("says when the tour leaves", () => {
    const [slot] = scheduleSlots([t2], false);
    expect(departureText(slot, date, at("12:10"))).toBe("Départ dans 50 min");
    expect(departureText(slot, date, at("10:54"))).toBe("Départ dans 2 h 06");
    expect(departureText(slot, date, at("13:20"))).toBe("Départ prévu il y a 20 min");
    const [running] = scheduleSlots([{ ...t2, status: "EN_COURS", startedAt: "2026-09-15T11:05:00Z" }], false);
    expect(departureText(running, date, at("13:20"))).toBe("En cours depuis 13:05");
  });
});

describe("counter grid", () => {
  const slots = scheduleSlots([tour({ id: "t1", name: "Tournée 1", slot: "10:00" })], true);
  const lines = [
    line({ id: "a" }),
    line({ id: "b" }),
    line({ id: "c", supplierId: "s-cal", supplier: "CAL", vendeurId: "u2", vendeur: "Amine", designation: "Filtre à huile" }),
    line({ id: "x", tourId: "other", vendeurId: "u3", vendeur: "Karim" }),
  ];

  it("groups by tournée, vendeur and supplier with the totals", () => {
    const grid = buildTourGrid(slots, lines);
    expect(grid.total).toBe(3);
    expect(grid.suppliers).toEqual([
      { id: "s-az", name: "AZ", count: 2 },
      { id: "s-cal", name: "CAL", count: 1 },
    ]);
    const [first, second] = grid.slots;
    expect(first.rows.map((r) => [r.vendeur, r.count])).toEqual([
      ["Amine", 1],
      ["Karim", 2],
    ]);
    expect(first.rows[1].cells.get("s-az")?.map((l) => l.id)).toEqual(["a", "b"]);
    expect(first.stats.total).toBe(3);
    expect(second.rows).toEqual([]);
  });

  it("filters by vendeur, supplier and a search without accents", () => {
    const ids = (f: Parameters<typeof filterTourLines>[1]) => filterTourLines(lines, f).map((l) => l.id);
    expect(ids({ vendeur: "u1", supplierId: "", query: "" })).toEqual(["a", "b"]);
    expect(ids({ vendeur: "", supplierId: "s-cal", query: "" })).toEqual(["c"]);
    expect(ids({ vendeur: "", supplierId: "", query: "FILTRE A HUILE" })).toEqual(["c"]);
  });

  it("keeps each vendeur's colour from the team order", () => {
    const colors = vendeurColors(["u2", "u1"], [...lines, line({ id: "z", vendeurId: null, vendeur: "Garage Martin" })]);
    expect(colors.get("u2")).toBe(VENDEUR_COLORS[0]);
    expect(colors.get("u1")).toBe(VENDEUR_COLORS[1]);
    expect(colors.get("Garage Martin")).toBe(VENDEUR_COLORS[2]);
    expect(colors.get("u3")).toBe(VENDEUR_COLORS[3]);
  });
});

describe("livreur view", () => {
  it("makes one stop per supplier with the parts left", () => {
    const stops = supplierStops([
      line({ id: "1", supplierId: "s-cal", supplier: "CAL", reference: "PG10210" }),
      line({ id: "2", reference: "K1125", pickupStatus: "PICKED_UP" }),
      line({ id: "3", reference: "A300" }),
    ]);
    expect(stops.map((s) => [s.supplier, s.left, s.lines.map((l) => l.reference)])).toEqual([
      ["AZ", 1, ["A300", "K1125"]],
      ["CAL", 1, ["PG10210"]],
    ]);
  });

  it("shows what was ticked offline on top of the last board", () => {
    const board = {
      date: "2026-09-15",
      defaults: {},
      upcoming: [],
      tours: [tour({ id: "t1", name: "Tournée 1" })],
      lines: [line({ id: "a" }), line({ id: "b" })],
    };
    const shown = applyQueuedTourActions(board, [
      { kind: "pickup", lineId: "a", pickupStatus: "PICKED_UP" },
      { kind: "pickup", lineId: "a", pickupStatus: null },
      { kind: "pickup", lineId: "b", pickupStatus: "UNAVAILABLE" },
      { kind: "tour", tourId: "t1", tourStatus: "EN_COURS" },
      { kind: "deliver" },
    ]);
    expect(shown.lines.map((l) => l.pickupStatus)).toEqual([null, "UNAVAILABLE"]);
    expect(shown.tours[0].status).toBe("EN_COURS");
    expect(applyQueuedTourActions(board, [{ kind: "deliver" }])).toBe(board);
  });

  it("translates the server refusals", () => {
    expect(tourErrorMessage("This tour is assigned to another livreur.")).toBe("Cette tournée est confiée à un autre livreur.");
    expect(tourErrorMessage("This part has already been received at the magasin.")).toMatch(/déjà reçue/);
    expect(tourErrorMessage("boom")).toBe("boom");
  });
});
