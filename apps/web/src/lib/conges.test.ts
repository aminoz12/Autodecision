import { describe, expect, it } from "vitest";
import { businessDays, easterSunday, fmtLeavePeriod, frenchHolidays, leavePreview } from "./conges";

function utc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d);
}

describe("easterSunday", () => {
  it("matches the known dates", () => {
    expect(easterSunday(2024)).toBe(utc(2024, 3, 31));
    expect(easterSunday(2025)).toBe(utc(2025, 4, 20));
    expect(easterSunday(2026)).toBe(utc(2026, 4, 5));
    expect(easterSunday(2027)).toBe(utc(2027, 3, 28));
  });
});

describe("frenchHolidays", () => {
  it("lists the eleven French public holidays of 2026", () => {
    const dates = frenchHolidays(2026).map((h) => h.date);
    expect(dates).toEqual([
      "2026-01-01",
      "2026-04-06",
      "2026-05-01",
      "2026-05-08",
      "2026-05-14",
      "2026-05-25",
      "2026-07-14",
      "2026-08-15",
      "2026-11-01",
      "2026-11-11",
      "2026-12-25",
    ]);
  });
});

describe("businessDays", () => {
  it("skips week-ends and Christmas", () => {
    // Thu 24 → Thu 31 Dec 2026: 24, (25 holiday), 28, 29, 30, 31
    const r = businessDays("2026-12-24", "2026-12-31");
    expect(r.days).toBe(5);
    expect(r.holidays).toEqual([{ date: "2026-12-25", name: "Noël" }]);
  });

  it("skips Easter Monday", () => {
    expect(businessDays("2026-04-06", "2026-04-10").days).toBe(4);
  });

  it("counts a single working day", () => {
    expect(businessDays("2026-05-04", "2026-05-04").days).toBe(1);
  });

  it("counts nothing on a week-end or a holiday falling on a weekday", () => {
    expect(businessDays("2026-10-17", "2026-10-18").days).toBe(0);
    expect(businessDays("2026-07-14", "2026-07-14").days).toBe(0);
  });

  it("spans years", () => {
    // Mon 28 Dec 2026 → Fri 8 Jan 2027: 28, 29, 30, 31, (1 Jan holiday), 4, 5, 6, 7, 8
    expect(businessDays("2026-12-28", "2027-01-08").days).toBe(9);
  });

  it("is zero for reversed or invalid dates", () => {
    expect(businessDays("2026-10-20", "2026-10-19").days).toBe(0);
    expect(businessDays("", "2026-10-19").days).toBe(0);
    expect(businessDays("nope", "2026-10-19").days).toBe(0);
  });
});

describe("fmtLeavePeriod", () => {
  it("shortens the start when the month or the year is shared", () => {
    expect(fmtLeavePeriod("2026-10-19", "2026-10-30")).toBe("lun. 19 → ven. 30 oct. 2026");
    expect(fmtLeavePeriod("2026-05-04", "2026-05-04")).toBe("lun. 4 mai 2026");
    expect(fmtLeavePeriod("2026-10-29", "2026-11-02")).toBe("jeu. 29 oct. → lun. 2 nov. 2026");
    expect(fmtLeavePeriod("2026-12-28", "2027-01-08")).toBe("lun. 28 déc. 2026 → ven. 8 janv. 2027");
  });
});

describe("leavePreview", () => {
  it("names the skipped holiday and the balance left", () => {
    const p = leavePreview("CONGE_PAYE", "2026-12-24", "2026-12-31", 7);
    expect(p.tone).toBe("info");
    expect(p.text).toBe("5 jours ouvrés décomptés (le 25 déc., férié, ne compte pas). Il vous restera 2 jours.");
  });

  it("warns when the balance is too small", () => {
    const p = leavePreview("CONGE_PAYE", "2026-12-24", "2026-12-31", 3);
    expect(p.tone).toBe("warn");
    expect(p.text).toContain("Solde insuffisant");
  });

  it("does not mention the balance for other absence types", () => {
    const p = leavePreview("RECUPERATION", "2026-05-04", "2026-05-04", 3);
    expect(p.text).toBe("1 jour ouvré décompté.");
  });

  it("warns on an empty period", () => {
    expect(leavePreview("CONGE_PAYE", "2026-10-17", "2026-10-18", 10).tone).toBe("warn");
  });
});
