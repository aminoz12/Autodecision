import { describe, expect, it } from "vitest";
import {
  RETURN_MOTIFS,
  RETURN_MOTIF_BY_CODE,
  addMonths,
  formatPlate,
  laborAmount,
  lineWarranty,
  motifLabel,
  normalizePlate,
  parseDay,
  partFamily,
  presumptionApplies,
  slaHoursLeft,
  toDayString,
  warrantyText,
  withinReturnPolicy,
} from "@/lib/sav";

const day = (s: string) => parseDay(s) as Date;

describe("partFamily — same buckets as the SQL part_family()", () => {
  it("classifies the counter's usual wording, accents or not", () => {
    expect(partFamily("Plaquettes de frein AV")).toBe("PLAQUETTES");
    expect(partFamily("Disque de frein arrière")).toBe("DISQUES");
    expect(partFamily("Kit distribution + pompe à eau")).toBe("DISTRIBUTION");
    expect(partFamily("Filtre à huile")).toBe("VIDANGE");
    expect(partFamily("Filtre habitacle")).toBe("FILTRATION");
    expect(partFamily("Alternateur 120A")).toBe("DEMARRAGE_CHARGE");
    expect(partFamily("Balais essuie-glace")).toBe("ESSUIE_GLACE");
    expect(partFamily("Pompe à eau")).toBe("REFROIDISSEMENT");
    expect(partFamily("Truc inconnu")).toBe("AUTRE");
    expect(partFamily(null)).toBe("AUTRE");
  });

  it("does not take a clutch disc for a brake disc", () => {
    expect(partFamily("Disque d'embrayage")).toBe("EMBRAYAGE");
  });
});

describe("addMonths", () => {
  it("clamps to the end of the month like Postgres", () => {
    expect(toDayString(addMonths(day("2026-01-31"), 1))).toBe("2026-02-28");
    expect(toDayString(addMonths(day("2024-02-29"), 24))).toBe("2026-02-28");
    expect(toDayString(addMonths(day("2026-05-03"), 24))).toBe("2028-05-03");
  });
});

describe("lineWarranty — le voyant", () => {
  const today = day("2026-09-19");

  it("is green well inside the 24 legal months", () => {
    const w = lineWarranty({ start: "2026-05-03" }, today);
    expect(w?.legalEnd).toBe("2028-05-03");
    expect(w?.commercialEnd).toBeNull();
    expect(w?.light).toBe("green");
    expect(w?.coverage).toBe("LEGALE");
  });

  it("turns orange in the last 90 days, red once expired", () => {
    expect(lineWarranty({ start: "2024-11-01" }, today)?.light).toBe("orange");
    const expired = lineWarranty({ start: "2024-09-01" }, today);
    expect(expired?.light).toBe("red");
    expect(expired?.coverage).toBe("EXPIREE");
    expect(warrantyText(expired as NonNullable<typeof expired>)).toContain("expirée");
  });

  it("keeps the longer of the two counters: a 36-month equipment warranty outlives the legal one", () => {
    const w = lineWarranty({ start: "2024-01-10", warrantyMonths: 36 }, today);
    expect(w?.legalEnd).toBe("2026-01-10");
    expect(w?.commercialEnd).toBe("2027-01-10");
    expect(w?.end).toBe("2027-01-10");
    expect(w?.light).toBe("green");
    expect(w?.coverage).toBe("COMMERCIALE");
  });

  it("adds the 6 months of a replacement under warranty to the legal counter", () => {
    const w = lineWarranty({ start: "2024-06-01", extensionMonths: 6 }, today);
    expect(w?.legalEnd).toBe("2026-12-01");
    expect(w?.light).toBe("orange");
  });

  it("applies the presumption of an original defect during 24 months only", () => {
    const young = lineWarranty({ start: "2025-09-20", warrantyMonths: 60 }, today);
    const old = lineWarranty({ start: "2023-09-01", warrantyMonths: 60 }, today);
    expect(presumptionApplies(young as NonNullable<typeof young>, today)).toBe(true);
    expect(presumptionApplies(old as NonNullable<typeof old>, today)).toBe(false);
  });

  it("returns null without a start date", () => {
    expect(lineWarranty({ start: null }, today)).toBeNull();
  });
});

describe("plates", () => {
  it("normalises whatever the counter typed", () => {
    expect(normalizePlate(" ab-123-cd ")).toBe("AB123CD");
    expect(normalizePlate(null)).toBe("");
    expect(formatPlate("ab123cd")).toBe("AB-123-CD");
    expect(formatPlate("1234 XY 92")).toBe("1234 XY 92");
  });
});

describe("retours : six motifs, six règles", () => {
  it("covers the six reasons of the counter, each with its rule", () => {
    expect(RETURN_MOTIFS).toHaveLength(6);
    expect(RETURN_MOTIF_BY_CODE.DEFECTUEUSE.bascule).toBe("GARANTIE");
    expect(RETURN_MOTIF_BY_CODE.NON_CONFORME.bascule).toBe("LITIGE");
    expect(RETURN_MOTIFS.filter((m) => m.policyApplies).map((m) => m.code)).toEqual(["ERREUR_CLIENT"]);
    expect(motifLabel(null)).toBe("Motif non codé");
    expect(motifLabel("ERREUR_VENDEUR")).toBe("Erreur de référence du vendeur");
  });

  it("checks the shop's commercial return window", () => {
    const today = day("2026-09-19");
    expect(withinReturnPolicy("2026-09-10", 15, today)).toBe(true);
    expect(withinReturnPolicy("2026-08-01", 15, today)).toBe(false);
    expect(withinReturnPolicy(null, 15, today)).toBeNull();
  });
});

describe("litiges", () => {
  it("prices lost labor: hourly rate × flat-rate time", () => {
    expect(laborAmount(65, 2.5)).toBe(162.5);
    expect(laborAmount(null, 2)).toBe(0);
  });

  it("counts the SLA down until the first answer", () => {
    const now = new Date("2026-09-19T10:00:00Z");
    expect(slaHoursLeft("2026-09-20T10:00:00Z", null, now)).toBe(24);
    expect(slaHoursLeft("2026-09-19T04:00:00Z", null, now)).toBe(-6);
    expect(slaHoursLeft("2026-09-19T04:00:00Z", "2026-09-19T03:00:00Z", now)).toBeNull();
  });
});
