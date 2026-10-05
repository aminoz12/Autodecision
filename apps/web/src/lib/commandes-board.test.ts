import { describe, expect, it } from "vitest";
import type { BoardLine } from "@/lib/data/commandes";
import { backorderLines, deliveryOrdersOf, lineMatches, pendingLines, prepareOrdersOf, toursOf } from "./commandes-board";

function line(p: Partial<BoardLine> & { id: string }): BoardLine {
  return {
    orderId: "o1", orderRef: "REQ-2026-00001", orderDate: "2026-10-05", clientId: "c1", clientName: "Paul Martin", clientPhone: "0611223344",
    isGarage: false, vehicle: null, plate: null, reference: "GDB1322", referenceCommande: null, designation: "Plaquettes", supplierName: "Autodistribution",
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

  it("à préparer: client orders with parts in, until treated", () => {
    const board = [
      line({ id: "a", orderId: "o1", status: "RECEIVED", receivedAt: "2026-10-05T10:00:00Z" }),
      line({ id: "b", orderId: "o1" }),
      line({ id: "c", orderId: "o2", isGarage: true, status: "RECEIVED" }),
      line({ id: "d", orderId: "o3", status: "RECEIVED" }),
    ];
    const rows = prepareOrdersOf(board, new Map([["o3", { sent: true, treated: true }]]));
    expect(rows.map((o) => [o.orderId, o.received, o.total, o.complet])).toEqual([["o1", 1, 2, false]]);
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
