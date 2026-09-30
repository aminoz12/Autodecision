import { describe, expect, it } from "vitest";
import { lineReglement, lineReturnState, returnStateOf, returnableQuantity } from "./garage-line-state";

const row = (o: Partial<{ lineId: string; status: string; legDone: boolean; quantity: number; createdAt: string }>) => ({
  lineId: "L1",
  status: "A_TRAITER",
  legDone: false,
  quantity: 1,
  createdAt: "2026-09-30T10:00:00Z",
  ...o,
});

describe("returnStateOf — le flux garage", () => {
  it("walks demandé → à récupérer → récupéré → retourné", () => {
    expect(returnStateOf({ status: "A_TRAITER", legDone: false })).toBe("REQUESTED");
    expect(returnStateOf({ status: "A_RECUPERER", legDone: false })).toBe("TO_COLLECT");
    expect(returnStateOf({ status: "A_RECUPERER", legDone: true })).toBe("COLLECTED");
    expect(returnStateOf({ status: "ACCEPTE", legDone: true })).toBe("RETURNED");
    expect(returnStateOf({ status: "AVOIR", legDone: true })).toBe("RETURNED");
    expect(returnStateOf({ status: "REFUSE", legDone: false })).toBe("REFUSED");
  });
});

describe("lineReturnState", () => {
  it("is « aucun retour » without a row for the line", () => {
    expect(lineReturnState([row({ lineId: "L2" })], "L1")).toEqual({ state: "NONE", current: null });
  });
  it("prefers the most recent live request over an older refused one", () => {
    const refused = row({ status: "REFUSE", createdAt: "2026-09-01T10:00:00Z" });
    const live = row({ status: "A_RECUPERER", createdAt: "2026-09-30T10:00:00Z" });
    const r = lineReturnState([refused, live], "L1");
    expect(r.state).toBe("TO_COLLECT");
    expect(r.current).toBe(live);
  });
  it("shows the refusal when nothing else exists", () => {
    expect(lineReturnState([row({ status: "REFUSE" })], "L1").state).toBe("REFUSED");
  });
});

describe("returnableQuantity", () => {
  it("subtracts every non-refused request", () => {
    const rows = [row({ quantity: 1 }), row({ quantity: 1, status: "REFUSE" }), row({ quantity: 2, status: "ACCEPTE" })];
    expect(returnableQuantity(rows, "L1", 4)).toBe(1);
    expect(returnableQuantity(rows, "L1", 3)).toBe(0);
  });
});

describe("lineReglement", () => {
  it("derives « payé » from a settled order and keeps an explicit label", () => {
    expect(lineReglement(null, 0)).toBe("PAYE");
    expect(lineReglement(null, 12.5)).toBe("A_PAYER");
    expect(lineReglement("PAYE", 12.5)).toBe("PAYE");
    expect(lineReglement("OFFERT", 0)).toBe("OFFERT");
  });
});
