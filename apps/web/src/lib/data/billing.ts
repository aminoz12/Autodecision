import type { SupabaseClient } from "@supabase/supabase-js";

export type BillingRow = {
  status: string;
  plan: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
};

export type BillingPhase = "active" | "trialing" | "expired";

export type BillingState = BillingRow & {
  phase: BillingPhase;
  /** Whole days left in the trial (>= 0), null when not trialing. */
  trialDaysLeft: number | null;
  /** When true, the dashboard should be locked behind an upgrade screen. */
  locked: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// subscription_status values that mean "no access until they pay".
const LOCKED_STATUSES = new Set([
  "past_due",
  "unpaid",
  "canceled",
  "cancelled",
  "incomplete_expired",
  "expired",
]);

const TRIAL_STATUSES = new Set(["trialing", "trial"]);

export async function loadBilling(
  supabase: SupabaseClient,
  orgId: string,
): Promise<BillingRow> {
  const { data, error } = await supabase
    .from("organizations")
    .select("subscription_status,plan,trial_ends_at,current_period_end")
    .eq("id", orgId)
    .single();

  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown>;
  return {
    status: String(row.subscription_status ?? "active"),
    plan: String(row.plan ?? "TRIAL"),
    trialEndsAt: (row.trial_ends_at as string | null) ?? null,
    currentPeriodEnd: (row.current_period_end as string | null) ?? null,
  };
}

/**
 * Pure derivation of the billing state. `now` defaults to the current time;
 * pass it explicitly in tests. Conservative by design: unknown statuses and
 * a missing trial date never lock the user out.
 */
export function computeBillingState(
  row: BillingRow,
  now: Date = new Date(),
): BillingState {
  const status = row.status.toLowerCase();

  if (LOCKED_STATUSES.has(status)) {
    return { ...row, phase: "expired", trialDaysLeft: null, locked: true };
  }

  if (TRIAL_STATUSES.has(status)) {
    if (!row.trialEndsAt) {
      // Trialing but no end date recorded — don't lock, no countdown.
      return { ...row, phase: "trialing", trialDaysLeft: null, locked: false };
    }
    const end = new Date(row.trialEndsAt).getTime();
    if (Number.isNaN(end)) {
      return { ...row, phase: "trialing", trialDaysLeft: null, locked: false };
    }
    const diff = end - now.getTime();
    if (diff <= 0) {
      return { ...row, phase: "expired", trialDaysLeft: 0, locked: true };
    }
    return {
      ...row,
      phase: "trialing",
      trialDaysLeft: Math.ceil(diff / DAY_MS),
      locked: false,
    };
  }

  // "active" and anything unrecognised → full access.
  return { ...row, phase: "active", trialDaysLeft: null, locked: false };
}
