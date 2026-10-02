import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { groupItemsIntoRows, parseMoney, parseOrderRows, parseQuantity, type PdfTextItem } from "./order-pdf";

/**
 * Each fixture is the text layer of a real PDF (a garage devis printed by
 * Chromium, read with pdf.js exactly as the app does) — synthetic data:
 *  - devis-multipage: 70 lines over 2 pages, header repeated on page 2, right-
 *    aligned amounts up to five digits, a page footer, a designation wrapped
 *    over two lines, quantities printed « 1,00 ».
 *  - devis-left-headers: the same with left-aligned column titles over right-
 *    aligned numbers in tight columns (a title says little about where a wide
 *    amount starts).
 *  - devis-long: 180 lines over 4 pages, header NOT repeated, a banner printed
 *    at the top of every page, running « Sous-total à reporter » rows.
 */
type Fixture = {
  pages: number;
  expected: { reference: string; designation: string; quantity: number; prixVente: number }[];
  items: PdfTextItem[];
};
const load = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", `${name}.json`), "utf8")) as Fixture;

describe.each(["devis-multipage", "devis-left-headers", "devis-long"])("garage devis over several pages — %s", (name) => {
  const fixture = load(name);
  const parsed = parseOrderRows(groupItemsIntoRows(fixture.items));

  it("reads every line of the table, across the page breaks", () => {
    expect(fixture.pages).toBeGreaterThan(1);
    expect(parsed.lines.map((l) => l.reference)).toEqual(fixture.expected.map((l) => l.reference));
  });

  it("keeps large amounts in their own column", () => {
    const wrong = parsed.lines
      .map((l, i) => ({ got: l, want: fixture.expected[i] }))
      .filter(({ got, want }) => want && Math.abs(got.prixVente - want.prixVente) > 0.005);
    expect(wrong.map(({ got, want }) => `${want.reference}: ${got.prixVente} ≠ ${want.prixVente}`)).toEqual([]);
  });

  it("reads quantities printed with decimals", () => {
    const wrong = parsed.lines
      .map((l, i) => ({ got: l, want: fixture.expected[i] }))
      .filter(({ got, want }) => want && got.quantity !== want.quantity);
    expect(wrong.map(({ got, want }) => `${want.reference}: ${got.quantity} ≠ ${want.quantity}`)).toEqual([]);
  });

  it("joins a designation wrapped over two lines and takes in no header, banner or footer text", () => {
    expect(parsed.lines.map((l) => l.designation)).toEqual(fixture.expected.map((l) => l.designation));
  });

  it("still reads the client block", () => {
    expect(parsed.clientName).toBe("GARAGE DU CENTRE");
    expect(parsed.clientNumber).toBe("CU18334");
    expect(parsed.plate).toBe("AB-123-CD");
    expect(parsed.devisNumber).toBe("DE16409");
  });
});

describe("numbers", () => {
  it("parses amounts with any thousands separator", () => {
    expect(parseMoney("12 345,67 €")).toBe(12345.67);
    expect(parseMoney("12 345,67")).toBe(12345.67);
    expect(parseMoney("1.234.567,89")).toBe(1234567.89);
    expect(parseMoney("1,234,567.89")).toBe(1234567.89);
    expect(parseMoney("45,00")).toBe(45);
  });

  it("takes the first amount when two columns ran together", () => {
    expect(parseMoney("12 345,67 14 814,80")).toBe(12345.67);
    expect(parseMoney("1 250,00 € 1 500,00 €")).toBe(1250);
  });

  it("reads a quantity whatever its form", () => {
    expect(parseQuantity("1,00")).toBe(1);
    expect(parseQuantity("12,00")).toBe(12);
    expect(parseQuantity("2.000")).toBe(2);
    expect(parseQuantity("1 500")).toBe(1500);
    expect(parseQuantity("x 3")).toBe(3);
    expect(parseQuantity("")).toBe(1);
  });
});

describe("our own bon de commande (one visual line per piece)", () => {
  const parsed = parseOrderRows(
    [
      "Nom du client : Garage Martin",
      "Téléphone : 06 12 34 56 78",
      "Désignation Référence Qté Prix achat Prix vente Total",
      "Disque de frein DF4183 10 1 250,00 € 1 500,00 € 15 000,00 €",
      "Plaquette de frein GDB1322 1 12,00 € 25,00 € 25,00 €",
      "Turbo reconditionné 7701474426 2 10 450,50 € 12 540,60 € 25 081,20 €",
      "Total commande 40 106,20 €",
    ].map((text, i) => ({ y: 800 - i * 14, cells: [{ x: 40, text }] })),
  );

  it("reads large amounts and keeps the quantity apart from the price", () => {
    expect(parsed.lines).toEqual([
      { designation: "Disque de frein", reference: "DF4183", quantity: 10, prixAchat: 1250, prixVente: 1500 },
      { designation: "Plaquette de frein", reference: "GDB1322", quantity: 1, prixAchat: 12, prixVente: 25 },
      { designation: "Turbo reconditionné", reference: "7701474426", quantity: 2, prixAchat: 10450.5, prixVente: 12540.6 },
    ]);
    expect(parsed.clientName).toBe("Garage Martin");
  });
});

describe("the plate of a devis made out to a garage", () => {
  const header = [
    { x: 40, text: "Référence" },
    { x: 120, text: "Désignation" },
    { x: 380, text: "P.U. TTC" },
    { x: 460, text: "Quantité" },
  ];
  const line = [
    { x: 40, text: "GDB1322" },
    { x: 120, text: "Plaquettes de frein AV" },
    { x: 380, text: "45,00" },
    { x: 470, text: "1,00" },
  ];

  it("is read when the vehicle is printed away from the client block", () => {
    const parsed = parseOrderRows([
      { y: 800, cells: [{ x: 40, text: "ESPACE AUTO ESSAI" }, { x: 360, text: "Client N° CU20001" }] },
      { y: 786, cells: [{ x: 40, text: "12 rue des Pièces" }, { x: 360, text: "GARAGE DU CENTRE" }] },
      { y: 772, cells: [{ x: 360, text: "SIRET 123 456 789 00012" }] },
      { y: 740, cells: [{ x: 40, text: "Véhicule : PEUGEOT 308 1.6 HDI" }] },
      { y: 726, cells: [{ x: 40, text: "Immatriculation :" }, { x: 130, text: "gh-456-jk" }] },
      { y: 700, cells: header },
      { y: 686, cells: line },
    ]);
    expect(parsed.clientName).toBe("GARAGE DU CENTRE");
    expect(parsed.plate).toBe("GH-456-JK");
    expect(parsed.vehicle).toBe("PEUGEOT 308 1.6 HDI");
    expect(parsed.lines).toHaveLength(1);
  });

  it("falls back on a plate-shaped text when nothing is labelled", () => {
    const parsed = parseOrderRows([
      { y: 800, cells: [{ x: 360, text: "Client N° CU20001" }] },
      { y: 786, cells: [{ x: 360, text: "GARAGE DU CENTRE" }] },
      { y: 740, cells: [{ x: 40, text: "RENAULT CLIO IV — AB 123 CD — 124 500 km" }] },
      { y: 700, cells: header },
      { y: 686, cells: line },
    ]);
    expect(parsed.plate).toBe("AB123CD");
  });
});
