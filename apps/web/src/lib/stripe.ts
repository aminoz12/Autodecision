import Stripe from "stripe";

/**
 * Stripe is optional: without STRIPE_SECRET_KEY the billing routes answer
 * 503 and the UI shows a "contact us" path instead of a checkout. Server-only.
 *
 *   STRIPE_SECRET_KEY        sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET    whsec_… (POST /api/billing/webhook)
 *   STRIPE_PRICE_MONTHLY     price_… of the monthly subscription
 *   STRIPE_PRICE_YEARLY      price_… of the yearly subscription (optional)
 *   NEXT_PUBLIC_APP_URL      https://app.example.fr (redirects after checkout)
 */

export type PlanInterval = "monthly" | "yearly";

export function stripeConfigured(): boolean {
  return Boolean((process.env.STRIPE_SECRET_KEY ?? "").trim() && (process.env.STRIPE_PRICE_MONTHLY ?? "").trim());
}

let cached: Stripe | null = null;

export function getStripe(): Stripe | null {
  const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
  if (!key) return null;
  if (!cached) cached = new Stripe(key);
  return cached;
}

export function priceIdFor(interval: PlanInterval): string | null {
  const id = (interval === "yearly" ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY) ?? "";
  return id.trim() || null;
}

/** Plan label stored on organizations.plan for a Stripe price id. */
export function planFor(priceId: string | null | undefined): string {
  if (priceId && priceId === (process.env.STRIPE_PRICE_YEARLY ?? "").trim()) return "PRO_ANNUEL";
  return "PRO";
}

/** Absolute app URL for Stripe redirects (env first, then the request origin). */
export function appUrl(request: Request): string {
  const env = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  if (env) return env;
  return new URL(request.url).origin;
}

/**
 * Map a Stripe subscription status to organizations.subscription_status.
 * The app's lock rules (lib/data/billing.ts) read these values.
 */
export function subscriptionStatusFor(status: Stripe.Subscription.Status): string {
  switch (status) {
    case "active":
    case "trialing":
      return status;
    case "past_due":
    case "unpaid":
    case "canceled":
    case "incomplete_expired":
      return status;
    case "incomplete":
    case "paused":
    default:
      return "past_due";
  }
}

/** current_period_end moved to subscription items in recent API versions. */
export function periodEndOf(sub: Stripe.Subscription): string | null {
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const ts = item?.current_period_end ?? legacy;
  return ts ? new Date(ts * 1000).toISOString() : null;
}
