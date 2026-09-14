import { describe, expect, it } from "vitest";
import {
  buildFailureReason,
  DeliveryNetworkError,
  deliveryErrorMessage,
  isNetworkError,
  mapsLink,
  parseTourStops,
  proofPath,
  splitTour,
  type TourStop,
} from "./delivery";

function stop(p: Partial<TourStop> & { id: string }): TourStop {
  return {
    ref: p.id,
    client: "Garage Martin",
    phone: null,
    address: null,
    city: null,
    isGarage: true,
    workflow: "IN_TRANSIT",
    dateEnvoi: null,
    deliveredAt: null,
    failedAt: null,
    failedReason: null,
    attempts: 0,
    note: null,
    pieces: [],
    ...p,
  };
}

const now = new Date(2026, 8, 14, 15, 0, 0); // 14 Sept 2026, 15:00 local
const at = (h: number, day = 14) => new Date(2026, 8, day, h, 0, 0).toISOString();

describe("splitTour", () => {
  it("orders the stops by departure slot, stops without a slot last", () => {
    const { toDeliver } = splitTour(
      [
        stop({ id: "C" }),
        stop({ id: "B", dateEnvoi: at(14) }),
        stop({ id: "A", dateEnvoi: at(9) }),
      ],
      now,
    );
    expect(toDeliver.map((s) => s.id)).toEqual(["A", "B", "C"]);
  });

  it("never hides a delivery in progress, however long the history is", () => {
    const history = Array.from({ length: 120 }, (_, i) =>
      stop({ id: `old-${i}`, workflow: "DELIVERED", deliveredAt: at(10, 1) }),
    );
    const sections = splitTour([...history, stop({ id: "NEW", dateEnvoi: at(12) })], now);
    expect(sections.toDeliver.map((s) => s.id)).toEqual(["NEW"]);
    expect(sections.deliveredToday).toEqual([]);
  });

  it("keeps only today's delivered and failed stops, latest first", () => {
    const sections = splitTour(
      [
        stop({ id: "D1", workflow: "DELIVERED", deliveredAt: at(9) }),
        stop({ id: "D2", workflow: "DELIVERED", deliveredAt: at(11) }),
        stop({ id: "Dyesterday", workflow: "DELIVERED", deliveredAt: at(11, 13) }),
        stop({ id: "F1", workflow: "TO_COLLECT", failedAt: at(10), failedReason: "Client absent" }),
        stop({ id: "Fold", workflow: "TO_COLLECT", failedAt: at(10, 12) }),
      ],
      now,
    );
    expect(sections.deliveredToday.map((s) => s.id)).toEqual(["D2", "D1"]);
    expect(sections.failedToday.map((s) => s.id)).toEqual(["F1"]);
  });
});

describe("parseTourStops", () => {
  it("maps the livreur_tour() JSON and drops malformed rows", () => {
    const stops = parseTourStops([
      {
        id: "o1",
        ref: "REQ-1",
        workflow: "IN_TRANSIT",
        client_name: "Garage Martin",
        client_phone: "0601020304",
        address: "12 rue des Garages",
        city: "Nanterre",
        is_garage: true,
        attempts: 1,
        failed_reason: "Client absent",
        pieces: [{ name: "Filtre", reference: "F-1", quantity: "2", pending: true }],
      },
      { ref: "no id" },
      null,
    ]);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      id: "o1",
      client: "Garage Martin",
      address: "12 rue des Garages",
      attempts: 1,
      pieces: [{ name: "Filtre", reference: "F-1", quantity: 2, pending: true }],
    });
    expect(parseTourStops(null)).toEqual([]);
  });
});

describe("delivery errors", () => {
  it("tells a network failure (retry later) from a server refusal", () => {
    expect(isNetworkError(new DeliveryNetworkError("x"))).toBe(true);
    expect(isNetworkError(new Error("TypeError: Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("Load failed"))).toBe(true);
    expect(isNetworkError(new Error("This order has already been delivered."))).toBe(false);
    expect(isNetworkError(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });

  it("translates the RPC messages the livreur can run into", () => {
    expect(deliveryErrorMessage("This delivery is assigned to another livreur.")).toBe(
      "Cette livraison a été confiée à un autre livreur.",
    );
    expect(deliveryErrorMessage("Only a delivery in progress can fail.")).toMatch(/plus en cours/);
    expect(deliveryErrorMessage("new row violates row-level security policy")).toMatch(/Envoi refusé/);
    expect(deliveryErrorMessage("something else")).toBe("something else");
  });
});

describe("helpers", () => {
  it("builds the failure reason, requiring a detail for « Autre »", () => {
    expect(buildFailureReason("Client absent", "")).toBe("Client absent");
    expect(buildFailureReason("Client absent", " rappelé ")).toBe("Client absent — rappelé");
    expect(buildFailureReason("Autre", "  ")).toBe("");
  });

  it("stores the proof under the order folder checked by mark_order_delivered", () => {
    expect(proofPath("org", "order", "image/png", 42)).toBe("org/order-42.png");
    expect(proofPath("org", "order", "", 42)).toBe("org/order-42.jpg");
  });

  it("links to the itinerary only with an address", () => {
    expect(mapsLink(null, null)).toBeNull();
    expect(mapsLink("12 rue des Garages", "Nanterre")).toContain(encodeURIComponent("12 rue des Garages, Nanterre"));
  });
});
