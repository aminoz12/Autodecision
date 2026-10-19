import { describe, expect, it } from "vitest";
import { parseTourStops, splitTour, type TourStop } from "./delivery";

function stop(p: Partial<TourStop> & { id: string }): TourStop {
  return {
    ref: `REQ-${p.id}`, client: "Garage du Centre", phone: null, address: "1 rue X", city: "Nanterre", isGarage: true,
    workflow: "TO_COLLECT", dateEnvoi: null, deliveredAt: null, failedAt: null, failedReason: null, attempts: 0, note: null,
    ready: false, livreurId: null, pieces: [],
    ...p,
  };
}

describe("Espace livreur — garages prêts au comptoir (2026-10-19)", () => {
  it("lists ready garage orders apart from the deliveries in progress, sorted by ref", () => {
    const now = new Date("2026-10-19T10:00:00");
    const s = splitTour(
      [
        stop({ id: "B", ready: true }),
        stop({ id: "A", ready: true, workflow: "PENDING" }),
        stop({ id: "T", ready: true, workflow: "IN_TRANSIT", dateEnvoi: "2026-10-19T08:00:00Z" }),
        stop({ id: "D", ready: false, workflow: "DELIVERED", deliveredAt: "2026-10-19T09:00:00Z" }),
        stop({ id: "N", ready: false }),
      ],
      now,
    );
    expect(s.toTake.map((x) => x.id)).toEqual(["A", "B"]);
    expect(s.toDeliver.map((x) => x.id)).toEqual(["T"]);
    expect(s.deliveredToday.map((x) => x.id)).toEqual(["D"]);
  });

  it("a garage refused today and still ready shows in both lists (retry possible)", () => {
    const now = new Date("2026-10-19T15:00:00");
    const s = splitTour([stop({ id: "F", ready: true, failedAt: "2026-10-19T11:00:00", failedReason: "Fermé", attempts: 1 })], now);
    expect(s.failedToday.map((x) => x.id)).toEqual(["F"]);
    expect(s.toTake.map((x) => x.id)).toEqual(["F"]);
  });

  it("parses the ready flag and the livreur from livreur_tour()", () => {
    const [a, b] = parseTourStops([
      { id: "1", ref: "R1", workflow: "TO_COLLECT", ready: true, livreur_id: null, pieces: [] },
      { id: "2", ref: "R2", workflow: "IN_TRANSIT", livreur_id: "lv1", pieces: [] },
    ]);
    expect(a).toMatchObject({ ready: true, livreurId: null });
    expect(b).toMatchObject({ ready: false, livreurId: "lv1" });
  });
});
