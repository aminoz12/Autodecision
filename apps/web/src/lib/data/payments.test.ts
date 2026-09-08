import { describe, expect, it } from "vitest";
import { dayBounds, totalsByMode, type Payment } from "./payments";

function pay(p: Partial<Payment> & { amount: number; mode: Payment["mode"] }): Payment {
  return {
    id: Math.random().toString(36).slice(2),
    kind: "ENCAISSEMENT",
    reference: null,
    note: null,
    receivedAt: "2026-09-08T10:00:00Z",
    receivedBy: null,
    receivedByName: null,
    clientId: null,
    clientName: null,
    orderId: null,
    orderRef: null,
    allocations: [],
    ...p,
  };
}

describe("totalsByMode", () => {
  it("sums per mode and subtracts refunds", () => {
    const t = totalsByMode([
      pay({ amount: 40, mode: "ESPECES" }),
      pay({ amount: 60, mode: "CARTE" }),
      pay({ amount: 150, mode: "VIREMENT", kind: "REGLEMENT_COMPTE" }),
      pay({ amount: 25, mode: "ESPECES", kind: "REMBOURSEMENT" }),
    ]);
    expect(t.ESPECES).toBe(15);
    expect(t.CARTE).toBe(60);
    expect(t.VIREMENT).toBe(150);
    expect(t.CHEQUE).toBe(0);
    expect(t.refunds).toBe(25);
    expect(t.total).toBe(225);
    expect(t.count).toBe(4);
  });
  it("handles an empty day", () => {
    const t = totalsByMode([]);
    expect(t.total).toBe(0);
    expect(t.count).toBe(0);
  });
});

describe("dayBounds", () => {
  it("covers exactly one local day", () => {
    const { from, to } = dayBounds("2026-09-08");
    const a = new Date(from);
    const b = new Date(to);
    expect(b.getTime() - a.getTime()).toBe(24 * 3600 * 1000);
    expect(a.getHours()).toBe(0);
    expect(a.getDate()).toBe(8);
  });
});
