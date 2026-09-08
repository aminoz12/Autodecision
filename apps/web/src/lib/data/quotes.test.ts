import { describe, expect, it, vi, afterEach } from "vitest";
import { effectiveQuoteStatus } from "./quotes";

describe("effectiveQuoteStatus", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("un devis en attente encore valable reste EN_ATTENTE", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 8, 10));
    expect(effectiveQuoteStatus({ status: "EN_ATTENTE", validUntil: "2026-09-30" })).toBe("EN_ATTENTE");
  });

  it("le jour de la date limite est encore valable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 18));
    expect(effectiveQuoteStatus({ status: "EN_ATTENTE", validUntil: "2026-09-30" })).toBe("EN_ATTENTE");
  });

  it("passé la validité, il se lit EXPIRE", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1, 8));
    expect(effectiveQuoteStatus({ status: "EN_ATTENTE", validUntil: "2026-09-30" })).toBe("EXPIRE");
  });

  it("un devis accepté ou refusé n'expire jamais", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 1));
    expect(effectiveQuoteStatus({ status: "ACCEPTE", validUntil: "2026-09-30" })).toBe("ACCEPTE");
    expect(effectiveQuoteStatus({ status: "REFUSE", validUntil: "2026-09-30" })).toBe("REFUSE");
  });

  it("sans date de validité, pas d'expiration", () => {
    expect(effectiveQuoteStatus({ status: "EN_ATTENTE", validUntil: null })).toBe("EN_ATTENTE");
  });
});
