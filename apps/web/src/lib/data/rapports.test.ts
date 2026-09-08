import { describe, expect, it } from "vitest";
import { presetRange, toCsv } from "./rapports";

describe("presetRange", () => {
  const now = new Date(2026, 8, 8); // 8 septembre 2026

  it("ce mois = du 1er au dernier jour du mois", () => {
    expect(presetRange("month", now)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("mois dernier gère le changement d'année", () => {
    expect(presetRange("last_month", new Date(2026, 0, 15))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("30 jours inclut aujourd'hui", () => {
    expect(presetRange("30d", now)).toEqual({ from: "2026-08-10", to: "2026-09-08" });
  });

  it("cette année couvre l'année civile", () => {
    expect(presetRange("year", now)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
  });
});

describe("toCsv", () => {
  const columns = [
    { key: "ref", label: "N° commande" },
    { key: "total", label: "Total" },
    { key: "garage", label: "Garage" },
  ];

  it("écrit un CSV Excel (BOM, point-virgule, virgule décimale)", () => {
    const csv = toCsv([{ ref: "REQ-2026-00001", total: 1234.5, garage: true }], columns);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe("N° commande;Total;Garage\r\nREQ-2026-00001;1234,5;oui");
  });

  it("échappe les valeurs contenant le séparateur ou des guillemets", () => {
    const csv = toCsv([{ ref: 'Garage "Chez Momo"; Paris', total: 0, garage: false }], columns);
    expect(csv.slice(1).split("\r\n")[1]).toBe('"Garage ""Chez Momo""; Paris";0;non');
  });

  it("laisse vide les valeurs absentes", () => {
    const csv = toCsv([{ ref: "A", total: null, garage: undefined }], columns);
    expect(csv.slice(1).split("\r\n")[1]).toBe("A;;");
  });
});
