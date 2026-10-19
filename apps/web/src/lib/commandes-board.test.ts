import { describe, expect, it } from "vitest";
import type { BoardLine } from "@/lib/data/commandes";
import {
  backorderLines,
  boardTicketData,
  deliveryOrdersOf,
  lineKind,
  lineMatches,
  orderCompletion,
  partialTicketData,
  pendingLines,
  receiveOrdersOf,
  toursOf,
} from "./commandes-board";

function line(p: Partial<BoardLine> & { id: string }): BoardLine {
  return {
    orderId: "o1", orderRef: "REQ-2026-00001", orderDate: "2026-10-05", clientId: "c1", clientName: "Paul Martin", clientPhone: "0611223344",
    isGarage: false, isPro: false, vehicle: null, plate: null, reference: "GDB1322", referenceCommande: null, designation: "Plaquettes", supplierName: "Autodistribution",
    supplierId: "s1", supplierOwnDelivery: false, supplierLeadDays: 0, fromStock: false, quantity: 1, received: 0, handedOver: 0, status: "PENDING",
    receivedAt: null, expectedAt: null, tourId: null, tourName: "Tournée 1", tourLivreurId: null, putAway: false, unitPrice: 10, retourImpossible: false,
    alreadyReturned: false, isRestock: false, workflow: "PENDING", envoyerAuLivreur: false, livreurId: null, livreurName: null, dateEnvoi: null,
    clientAddress: null, clientCity: null, deliveryFailedReason: null, deliveryFailedAt: null, deliveryAttempts: 0,
    pointedBy: null, pointedAt: null, dispatchedBy: null,
    ...p,
  };
}

describe("Suivi des commandes — shared rules (counter page and stock tablet)", () => {
  it("à recevoir: everything not received, except shelf lines not re-ordered", () => {
    const board = [
      line({ id: "a" }),
      line({ id: "b", status: "RECEIVED" }),
      line({ id: "c", fromStock: true, supplierName: null }),
      line({ id: "d", fromStock: true, status: "BACKORDER" }),
    ];
    expect(pendingLines(board).map((l) => l.id)).toEqual(["a", "d"]);
    expect(backorderLines(board).map((l) => l.id)).toEqual(["d"]);
  });

  it("tournées: « Tournée … » first, then the others", () => {
    const tours = toursOf([line({ id: "a", tourName: null }), line({ id: "b", tourName: "Tournée 2" }), line({ id: "c", tourName: "Livraison fournisseur" })]);
    expect(tours.map((t) => t.name)).toEqual(["Tournée 2", "Hors tournée", "Livraison fournisseur"]);
  });

  it("à livrer: garage orders and orders out with a livreur, ready first", () => {
    const board = [
      line({ id: "a", orderId: "g1", isGarage: true }),
      line({ id: "b", orderId: "g2", isGarage: true, status: "RECEIVED", orderDate: "2026-10-01" }),
      line({ id: "c", orderId: "p1", workflow: "IN_TRANSIT", status: "RECEIVED" }),
      line({ id: "d", orderId: "p2" }),
      line({ id: "e", orderId: "g3", isGarage: true, workflow: "DELIVERED" }),
    ];
    expect(deliveryOrdersOf(board).map((o) => [o.orderId, o.stage])).toEqual([
      ["g2", "READY"],
      ["g1", "AWAITING"],
      ["p1", "TRANSIT"],
    ]);
  });

  it("search: every word must match, accents and case kept simple", () => {
    const l = line({ id: "a", plate: "AB-123-CD", clientName: "Garage du Centre" });
    expect(lineMatches(l, "gdb1322 centre")).toBe(true);
    expect(lineMatches(l, "ab-123")).toBe(true);
    expect(lineMatches(l, "gdb1322 dupont")).toBe(false);
    expect(lineMatches(l, "  ")).toBe(true);
  });
});

describe("Pointage par commande (2026-10-18)", () => {
  const board = [
    line({ id: "a", orderId: "o1", quantity: 3 }),
    line({ id: "b", orderId: "o1", status: "PARTIAL", quantity: 3, received: 1, expectedAt: "2026-10-19" }),
    line({ id: "c", orderId: "o1", status: "NOT_RECEIVED" }),
    line({ id: "d", orderId: "o2", orderRef: "REQ-2026-00002", isGarage: true, quantity: 2, expectedAt: "2026-10-18" }),
    line({ id: "e", orderId: "o2", orderRef: "REQ-2026-00002", isGarage: true, status: "RECEIVED", received: 1 }),
  ];

  it("à recevoir: one card per order, the parts still missing counted, soonest expected first", () => {
    const cards = receiveOrdersOf(pendingLines(board));
    expect(cards.map((c) => c.ref)).toEqual(["REQ-2026-00002", "REQ-2026-00001"]);
    const o1 = cards[1];
    expect(o1.lines.map((l) => l.id)).toEqual(["a", "b"]); // « Non reçu » is not awaited any more
    expect(o1.missing).toBe(3 + 2);
    expect(cards[0].kind).toBe("GARAGE");
  });

  it("complete: no part awaited and at least one received; « non reçu » lines do not block", () => {
    expect(orderCompletion(board, "o1").complete).toBe(false);
    const done = board.map((l) => (l.orderId === "o1" && l.status !== "NOT_RECEIVED" ? { ...l, status: "RECEIVED" as const, received: l.quantity } : l));
    const o1 = orderCompletion(done, "o1");
    expect(o1.complete).toBe(true);
    expect(o1.lines).toHaveLength(3);
    expect(orderCompletion(board.filter((l) => l.id === "c"), "o1").complete).toBe(false);
  });

  it("ticket: built from the order's lines without the « non reçu » ones, casier kept", () => {
    const t = boardTicketData(board.filter((l) => l.orderId === "o1"), { vendeur: "Sofia", casier: "A3" });
    expect(t?.ref).toBe("REQ-2026-00001");
    expect(t?.lines.map((l) => l.reference)).toEqual(["GDB1322", "GDB1322"]);
    expect(t?.casier).toBe("A3");
    expect(t?.vendeur).toBe("Sofia");
    expect(boardTicketData([], {})).toBeNull();
  });
});

describe("Réception partielle (2026-10-18)", () => {
  it("flags the orders where some units already came in", () => {
    const board = [line({ id: "a", quantity: 4, received: 1, status: "PARTIAL" }), line({ id: "b", orderId: "o2", orderRef: "REQ-2026-00002", quantity: 2 })];
    const orders = receiveOrdersOf(pendingLines(board), board);
    expect(orders.find((o) => o.orderId === "o1")).toMatchObject({ partial: true, receivedUnits: 1, missing: 3 });
    expect(orders.find((o) => o.orderId === "o2")).toMatchObject({ partial: false, receivedUnits: 0, missing: 2 });
  });

  it("counts a line already fully received when the rest of the order is awaited", () => {
    const board = [line({ id: "a", quantity: 1, received: 1, status: "RECEIVED" }), line({ id: "b", reference: "X2", quantity: 2 })];
    const [o] = receiveOrdersOf(pendingLines(board), board);
    expect(o.lines.map((l) => l.id)).toEqual(["b"]);
    expect(o).toMatchObject({ partial: true, receivedUnits: 1, missing: 2 });
  });

  it("is not partial without the whole board (pending lines only)", () => {
    const board = [line({ id: "a", quantity: 1, received: 1, status: "RECEIVED" }), line({ id: "b", reference: "X2", quantity: 2 })];
    const [o] = receiveOrdersOf(pendingLines(board));
    expect(o.partial).toBe(false);
  });

  it("ticket: received units (before + now) on one side, the rest on the other", () => {
    const board = [
      line({ id: "a", quantity: 4, received: 1, status: "PARTIAL" }),
      line({ id: "b", reference: "X2", quantity: 1 }),
      line({ id: "c", reference: "NA", status: "NOT_RECEIVED" }),
    ];
    const t = partialTicketData(board, new Map([["a", 2]]), { vendeur: "Inès" });
    expect(t?.lines).toEqual([expect.objectContaining({ reference: "GDB1322", quantity: 3 })]);
    expect(t?.missing).toEqual([expect.objectContaining({ reference: "GDB1322", quantity: 1 }), expect.objectContaining({ reference: "X2", quantity: 1 })]);
    expect(t?.casierBox).toBe(true);
    expect(t?.vendeur).toBe("Inès");
  });

  it("ticket: a réappro prints no casier box", () => {
    const board = [line({ id: "a", isRestock: true, fromStock: true, quantity: 4, received: 0 })];
    expect(partialTicketData(board, new Map([["a", 3]]), {})?.casierBox).toBe(false);
  });
});

describe("lineKind", () => {
  it("tells a client PRO from a walk-in client, a garage and the stock", () => {
    expect(lineKind(line({ id: "a" }))).toBe("CLIENT");
    expect(lineKind(line({ id: "b", isPro: true }))).toBe("PRO");
    expect(lineKind(line({ id: "c", isGarage: true, isPro: true }))).toBe("GARAGE");
    expect(lineKind(line({ id: "d", isPro: true, fromStock: true }))).toBe("STOCK");
  });
});
