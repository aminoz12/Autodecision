import { describe, expect, it } from "vitest";
import { feeAmount, isElectricalPart, netRefund, returnConditions } from "./return-conditions";

// UTC-midnight days, like parisToday() and the database.
const today = new Date(Date.UTC(2026, 8, 30));
const sold = (daysAgo: number) => new Date(today.getTime() - daysAgo * 86_400_000).toISOString().slice(0, 10);

describe("returnConditions — pièces en stock", () => {
  it("costs 20 % up to 7 days, 30 % up to 14 days and still 30 % up to a month", () => {
    expect(returnConditions({ saleDate: sold(0), origin: "STOCK", today })).toMatchObject({ allowed: true, feePct: 20, days: 0 });
    expect(returnConditions({ saleDate: sold(7), origin: "STOCK", today })).toMatchObject({ allowed: true, feePct: 20 });
    expect(returnConditions({ saleDate: sold(8), origin: "STOCK", today })).toMatchObject({ allowed: true, feePct: 30 });
    expect(returnConditions({ saleDate: sold(14), origin: "STOCK", today })).toMatchObject({ allowed: true, feePct: 30 });
    expect(returnConditions({ saleDate: sold(21), origin: "STOCK", today })).toMatchObject({ allowed: true, feePct: 30 });
    expect(returnConditions({ saleDate: sold(30), origin: "STOCK", today })).toMatchObject({ allowed: true, feePct: 30 });
  });

  it("refuses a return after one month but keeps the highest fee for an exception", () => {
    const c = returnConditions({ saleDate: sold(31), origin: "STOCK", today });
    expect(c.allowed).toBe(false);
    expect(c.feePct).toBe(30);
    expect(c.reason).toContain("aucun retour");
  });
});

describe("returnConditions — pièces sur commande", () => {
  it("costs 20 % up to the 7th day, 40 % up to the 14th, nothing after", () => {
    expect(returnConditions({ saleDate: sold(7), origin: "COMMANDE", today })).toMatchObject({ allowed: true, feePct: 20 });
    expect(returnConditions({ saleDate: sold(14), origin: "COMMANDE", today })).toMatchObject({ allowed: true, feePct: 40 });
    expect(returnConditions({ saleDate: sold(15), origin: "COMMANDE", today })).toMatchObject({ allowed: false, feePct: 40 });
  });
});

describe("returnConditions — exceptions", () => {
  it("never takes an electrical part back, by family or by designation", () => {
    expect(isElectricalPart("Capteur ABS VALEO")).toBe(true);
    expect(isElectricalPart("Plaquette de frein", "BATTERIE")).toBe(true);
    expect(isElectricalPart("Plaquette de frein BOSCH")).toBe(false);
    expect(isElectricalPart("Absorbeur de chocs")).toBe(false);
    const c = returnConditions({ saleDate: sold(2), origin: "STOCK", designation: "Bobine d'allumage NGK", today });
    expect(c.electrical).toBe(true);
    expect(c.allowed).toBe(false);
    expect(c.feePct).toBe(20);
  });

  it("drops the fees when the magasin, the catalogue or the supplier is at fault", () => {
    for (const motifCode of ["ERREUR_VENDEUR", "MAUVAISE_IDENTIFICATION", "NON_CONFORME"]) {
      const c = returnConditions({ saleDate: sold(40), origin: "COMMANDE", designation: "Capteur ABS", motifCode, today });
      expect(c).toMatchObject({ allowed: true, feePct: 0, waived: true });
    }
  });

  it("applies the schedule to a client mistake, a defective part and a cancellation", () => {
    for (const motifCode of ["ERREUR_CLIENT", "DEFECTUEUSE", "ANNULATION"]) {
      expect(returnConditions({ saleDate: sold(10), origin: "COMMANDE", motifCode, today })).toMatchObject({ allowed: true, feePct: 40, waived: false });
    }
  });

  it("does not guess when the sale date is unknown", () => {
    expect(returnConditions({ saleDate: null, origin: "STOCK", today })).toMatchObject({ allowed: true, feePct: 0, days: null });
  });
});

describe("netRefund / feeAmount", () => {
  it("keeps the fee and gives back the rest, cents exact", () => {
    expect(netRefund(100, 20)).toBe(80);
    expect(netRefund(149.9, 30)).toBe(104.93);
    expect(feeAmount(149.9, 30)).toBe(44.97);
    expect(netRefund(59.99, 0)).toBe(59.99);
    expect(netRefund(-5, 20)).toBe(0);
  });
});
