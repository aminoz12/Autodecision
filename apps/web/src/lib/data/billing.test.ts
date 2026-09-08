import { describe, expect, it } from "vitest";
import { computeBillingState, type BillingRow } from "./billing";

const now = new Date("2026-09-08T10:00:00Z");
const base: BillingRow = { status: "trialing", plan: "TRIAL", trialEndsAt: null, currentPeriodEnd: null };

describe("computeBillingState", () => {
  it("counts the days left of a running trial (ceil)", () => {
    const s = computeBillingState({ ...base, trialEndsAt: "2026-09-11T09:00:00Z" }, now);
    expect(s.phase).toBe("trialing");
    expect(s.locked).toBe(false);
    expect(s.trialDaysLeft).toBe(3);
  });

  it("locks an expired trial", () => {
    const s = computeBillingState({ ...base, trialEndsAt: "2026-09-08T09:59:59Z" }, now);
    expect(s.phase).toBe("expired");
    expect(s.locked).toBe(true);
    expect(s.trialDaysLeft).toBe(0);
  });

  it("never locks a trial without an end date", () => {
    const s = computeBillingState({ ...base, trialEndsAt: null }, now);
    expect(s.locked).toBe(false);
    expect(s.trialDaysLeft).toBeNull();
  });

  it("locks the Stripe 'bad' statuses and keeps active open", () => {
    for (const status of ["past_due", "unpaid", "canceled", "cancelled", "incomplete_expired", "expired"]) {
      expect(computeBillingState({ ...base, status }, now).locked).toBe(true);
    }
    const active = computeBillingState({ ...base, status: "active", plan: "PRO" }, now);
    expect(active.phase).toBe("active");
    expect(active.locked).toBe(false);
  });

  it("treats unknown statuses as open (fail-open by design)", () => {
    expect(computeBillingState({ ...base, status: "something_new" }, now).locked).toBe(false);
  });
});
