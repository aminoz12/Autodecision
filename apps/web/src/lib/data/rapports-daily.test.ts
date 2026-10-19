import { describe, expect, it } from "vitest";
import { dailyRevenue } from "./rapports";

const row = (date_commande: string, montant_total: number, extra: Record<string, unknown> = {}) => ({ date_commande, montant_total, ...extra });

describe("dailyRevenue — chiffre d'affaires par jour (Rapports)", () => {
  it("one bar per day over a month, holes filled, cancelled orders left out", () => {
    const r = dailyRevenue(
      [row("2026-10-01", 100), row("2026-10-01", 50), row("2026-10-03", 20), row("2026-10-03", 999, { cancelled_at: "2026-10-04" }), row("2026-11-02", 7)],
      { from: "2026-10-01", to: "2026-10-31" },
    );
    expect(r.mode).toBe("day");
    expect(r.points).toHaveLength(31);
    expect(r.points[0]).toMatchObject({ key: "2026-10-01", label: "1", ca: 150, orders: 2 });
    expect(r.points[1]).toMatchObject({ key: "2026-10-02", ca: 0, orders: 0 });
    expect(r.points[2]).toMatchObject({ key: "2026-10-03", ca: 20, orders: 1 });
    expect(r.activeDays).toBe(2);
    expect(r.avgPerActiveDay).toBe(85);
    expect(r.best?.key).toBe("2026-10-01");
  });

  it("switches to ISO weeks beyond two months", () => {
    const r = dailyRevenue([row("2026-01-05", 10), row("2026-01-11", 5), row("2026-01-12", 1)], { from: "2026-01-01", to: "2026-12-31" });
    expect(r.mode).toBe("week");
    expect(r.points[0].key).toBe("2026-W01");
    expect(r.points.find((p) => p.key === "2026-W02")).toMatchObject({ ca: 15, orders: 2, label: "S2" });
    expect(r.points.find((p) => p.key === "2026-W03")).toMatchObject({ ca: 1, orders: 1 });
    expect(r.points).toHaveLength(53);
    // the best DAY is still a day, not a week
    expect(r.best).toMatchObject({ key: "2026-01-05", ca: 10 });
    expect(r.activeDays).toBe(3);
  });

  it("gives up on a range longer than 400 days or an invalid one", () => {
    expect(dailyRevenue([row("2026-01-05", 10)], { from: "2000-01-01", to: "2027-12-31" }).mode).toBe("none");
    expect(dailyRevenue([], { from: "2026-10-31", to: "2026-10-01" }).mode).toBe("none");
  });

  it("week keys follow ISO rules at the turn of the year", () => {
    const r = dailyRevenue([row("2026-12-31", 3), row("2027-01-01", 4)], { from: "2026-10-01", to: "2027-01-10" });
    // 31 Dec 2026 (Thursday) and 1 Jan 2027 (Friday) are both in ISO week 2026-W53
    expect(r.points.find((p) => p.key === "2026-W53")).toMatchObject({ ca: 7, orders: 2 });
    expect(r.points.some((p) => p.key === "2027-W01")).toBe(true);
  });
});
