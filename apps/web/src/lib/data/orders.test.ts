import { describe, expect, it } from "vitest";
import { computeTournee } from "./orders";

/** Local time of a fixed day (the tournée grid is expressed in local time). */
function at(h: number, m: number): Date {
  const d = new Date(2026, 8, 8, h, m, 0, 0); // 8 Sept 2026, local
  return d;
}

describe("computeTournee", () => {
  it("09:30 is still tournée 1 (10:00 same day)", () => {
    const t = computeTournee(at(9, 30));
    expect(t.number).toBe(1);
    expect(t.slot).toBe("10:00");
    expect(t.tourDate).toBe("2026-09-08");
  });
  it("09:31 → tournée 2 at 13:00", () => {
    const t = computeTournee(at(9, 31));
    expect(t.number).toBe(2);
    expect(t.slot).toBe("13:00");
  });
  it("12:00 → tournée 2, 12:01 → tournée 3 (15:00)", () => {
    expect(computeTournee(at(12, 0)).number).toBe(2);
    const t = computeTournee(at(12, 1));
    expect(t.number).toBe(3);
    expect(t.slot).toBe("15:00");
  });
  it("14:30 → tournée 3, 14:31 → tournée 4 (17:30)", () => {
    expect(computeTournee(at(14, 30)).number).toBe(3);
    const t = computeTournee(at(14, 31));
    expect(t.number).toBe(4);
    expect(t.slot).toBe("17:30");
  });
  it("17:00 → tournée 4 same day; 17:01 → tournée 1 the NEXT morning", () => {
    expect(computeTournee(at(17, 0)).number).toBe(4);
    const t = computeTournee(at(17, 1));
    expect(t.number).toBe(1);
    expect(t.tourDate).toBe("2026-09-09");
    expect(t.deliveryAt.getHours()).toBe(10);
  });
  it("03:00 → tournée 1 the same day", () => {
    const t = computeTournee(at(3, 0));
    expect(t.number).toBe(1);
    expect(t.tourDate).toBe("2026-09-08");
  });
});
