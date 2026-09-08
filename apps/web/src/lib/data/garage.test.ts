import { describe, expect, it } from "vitest";
import { buildGarageStatement, type GarageCredit, type GarageOrder } from "./garage";

function order(p: Partial<GarageOrder> & { id: string }): GarageOrder {
  return {
    ref: p.id,
    date: "2026-09-05",
    deliveryAt: null,
    workflow: "DELIVERED",
    devis: false,
    devisStatus: null,
    total: 100,
    paid: 0,
    balance: 100,
    modePaiement: "EN_COMPTE",
    echeance: null,
    lines: [],
    ...p,
  };
}

const now = new Date(2026, 8, 20, 12, 0, 0); // 20 Sept 2026 local

describe("buildGarageStatement", () => {
  it("splits the month's balance from carried-over months and deducts avoirs", () => {
    const orders = [
      order({ id: "A", date: "2026-09-03", total: 1000, balance: 1000, echeance: "2026-10-03" }),
      order({ id: "B", date: "2026-09-10", total: 500, balance: 500, echeance: "2026-09-25" }),
      order({ id: "C", date: "2026-08-12", total: 300, balance: 120, echeance: "2026-09-11" }), // older + overdue
      order({ id: "D", date: "2026-08-01", total: 200, balance: 0, paid: 200 }),               // settled: ignored
      order({ id: "Q", date: "2026-09-15", devis: true, devisStatus: "REQUESTED", total: 0, balance: 0 }),
    ];
    const credits: GarageCredit[] = [
      { id: "av1", num: "AV-2026-00001", createdAt: null, dueAt: null, amount: 250, remaining: 200 },
    ];
    const s = buildGarageStatement(orders, credits, 2, now);
    expect(s.orderCount).toBe(4);
    expect(s.devisCount).toBe(1);
    expect(s.returnCount).toBe(2);
    expect(s.periodStart).toBe("2026-09-01");
    expect(s.periodEnd).toBe("2026-09-30");
    expect(s.currentMonth).toBe(1500);
    expect(s.carriedOver).toBe(120);
    expect(s.credits).toBe(200);
    expect(s.balance).toBe(1420);
    expect(s.overdue).toBe(120);
    expect(s.monthOrders.map((o) => o.id)).toEqual(["A", "B"]);
    expect(s.openOlderOrders.map((o) => o.id)).toEqual(["C"]);
    expect(s.periodLabel).toMatch(/^du 1 au 30 septembre 2026$/);
  });

  it("goes negative when avoirs exceed the open balance (the magasin owes the garage)", () => {
    const s = buildGarageStatement(
      [order({ id: "A", total: 50, balance: 50 })],
      [{ id: "av", num: "AV", createdAt: null, dueAt: null, amount: 80, remaining: 80 }],
      0,
      now,
    );
    expect(s.balance).toBe(-30);
  });

  it("is empty-safe", () => {
    const s = buildGarageStatement([], [], 0, now);
    expect(s.balance).toBe(0);
    expect(s.overdue).toBe(0);
    expect(s.orderCount).toBe(0);
  });
});
