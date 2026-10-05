import { describe, expect, it } from "vitest";
import {
  clampMoney,
  emptyQuickRow,
  isQuickRowFilled,
  netUnit,
  parseMoney,
  quickReglements,
  quickRowProblem,
  quickRowTotal,
  type QuickRow,
} from "./order-form";

const row = (p: Partial<QuickRow>): QuickRow => ({ ...emptyQuickRow, ...p });

describe("parseMoney", () => {
  it("reads a comma or a dot, ignores spaces, rounds to the cent", () => {
    expect(parseMoney("12,50")).toBe(12.5);
    expect(parseMoney(" 1 234.567 ")).toBe(1234.57);
    expect(parseMoney("abc")).toBeNaN();
  });
});

describe("quickReglements", () => {
  it("garage on account only, counter client paid or not, client PRO all three", () => {
    expect(quickReglements("GARAGE")).toEqual(["EN_COMPTE"]);
    expect(quickReglements("COMPTOIR")).toEqual(["PAYEE", "NON_PAYEE"]);
    expect(quickReglements("PRO")).toEqual(["PAYEE", "NON_PAYEE", "EN_COMPTE"]);
  });
});

describe("quickRowTotal", () => {
  it("quantity × (price + consigne), no total without a valid price", () => {
    expect(quickRowTotal(row({ price: "12,50", qty: 2 }))).toBe(25);
    expect(quickRowTotal(row({ price: "80", qty: 1, consigne: true, consignePrice: 15 }))).toBe(95);
    expect(quickRowTotal(row({ price: "80", consigne: false, consignePrice: 15 }))).toBe(80);
    expect(quickRowTotal(row({ price: "" }))).toBe(0);
  });
});

describe("quick row checks", () => {
  it("an untouched row is ignored, a typed one is not", () => {
    expect(isQuickRowFilled(row({}))).toBe(false);
    expect(isQuickRowFilled(row({ clientPhone: "06" }))).toBe(true);
  });

  it("names the first missing field of a counter row", () => {
    const steps: [Partial<QuickRow>, string | null][] = [
      [{}, "la référence"],
      [{ ref: "GDB1322" }, "le nom du client"],
      [{ ref: "GDB1322", clientName: "Paul" }, "le téléphone du client"],
      [{ ref: "GDB1322", clientName: "Paul", clientPhone: "0611" }, "le prix de vente"],
      [{ ref: "GDB1322", clientName: "Paul", clientPhone: "0611", price: "12" }, "le règlement"],
      [{ ref: "GDB1322", clientName: "Paul", clientPhone: "0611", price: "12", reglement: "PAYEE" }, "le mode de paiement"],
      [{ ref: "GDB1322", clientName: "Paul", clientPhone: "0611", price: "12", reglement: "PAYEE", mode: "ESPECES" }, null],
      [{ ref: "GDB1322", clientName: "Paul", clientPhone: "0611", price: "12", reglement: "NON_PAYEE" }, null],
    ];
    for (const [p, expected] of steps) expect(quickRowProblem(row(p))).toBe(expected);
  });

  it("an account row needs the account; a stock row only the supplier", () => {
    expect(quickRowProblem(row({ ref: "X", pourQui: "PRO" }))).toBe("le client PRO");
    expect(quickRowProblem(row({ ref: "X", pourQui: "GARAGE" }))).toBe("le garage");
    expect(quickRowProblem(row({ ref: "X", pourQui: "GARAGE", garageId: "g1", price: "10", reglement: "EN_COMPTE" }))).toBeNull();
    expect(quickRowProblem(row({ ref: "X", pourQui: "STOCK" }))).toBe("le fournisseur");
    expect(quickRowProblem(row({ ref: "X", pourQui: "STOCK", fournisseur: "s1" }))).toBeNull();
  });
});

describe("netUnit / clampMoney", () => {
  it("applies a line discount like the database, bounded to 0–100 %", () => {
    expect(netUnit(100, 15)).toBe(85);
    expect(netUnit(19.99, 33)).toBe(13.39);
    expect(netUnit(50, 120)).toBe(0);
    expect(netUnit(50, undefined)).toBe(50);
  });

  it("never lets the cashier type more than due", () => {
    expect(clampMoney("30,5", 100)).toBe(30.5);
    expect(clampMoney("150", 100)).toBe(100);
    expect(clampMoney("-4", 100)).toBe(0);
    expect(clampMoney("abc", 100)).toBe(0);
  });
});
