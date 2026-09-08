import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe, periodEndOf, planFor, subscriptionStatusFor } from "@/lib/stripe";

/**
 * POST /api/billing/webhook — Stripe events → organizations billing columns.
 * Verified with STRIPE_WEBHOOK_SECRET; runs with the service role.
 *
 *   checkout.session.completed        → customer + subscription ids, status active
 *   customer.subscription.updated     → status, plan, current_period_end
 *   customer.subscription.deleted     → status canceled
 *   invoice.payment_failed            → status past_due (locks the dashboard)
 *   invoice.paid                      → status active
 */
export async function POST(request: Request) {
  const stripe = getStripe();
  const secret = (process.env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  if (!stripe || !secret) {
    return NextResponse.json({ error: "Webhook non configuré." }, { status: 503 });
  }
  const signature = request.headers.get("stripe-signature") ?? "";
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(payload, signature, secret);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Signature invalide.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const admin = createAdminClient();

  /** Find the organization by metadata org_id first, then by customer id. */
  async function orgIdFor(meta: Record<string, string> | null | undefined, customer: string | null): Promise<string | null> {
    const fromMeta = meta?.org_id;
    if (fromMeta) return fromMeta;
    if (!customer) return null;
    const { data } = await admin.from("organizations").select("id").eq("stripe_customer_id", customer).maybeSingle();
    return data?.id ? String(data.id) : null;
  }

  const customerIdOf = (c: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined): string | null =>
    !c ? null : typeof c === "string" ? c : c.id;

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const customer = customerIdOf(session.customer);
        const orgId = session.client_reference_id ?? (await orgIdFor(session.metadata, customer));
        if (!orgId) break;
        const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
        let update: Record<string, unknown> = {
          stripe_customer_id: customer,
          stripe_subscription_id: subscriptionId,
          subscription_status: "active",
          billing_email: session.customer_details?.email ?? undefined,
        };
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const price = sub.items.data[0]?.price?.id ?? null;
          update = {
            ...update,
            subscription_status: subscriptionStatusFor(sub.status),
            plan: planFor(price),
            stripe_price_id: price,
            current_period_end: periodEndOf(sub),
            trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          };
        }
        await admin.from("organizations").update(update).eq("id", orgId);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const orgId = await orgIdFor(sub.metadata, customerIdOf(sub.customer));
        if (!orgId) break;
        const price = sub.items.data[0]?.price?.id ?? null;
        await admin
          .from("organizations")
          .update({
            stripe_subscription_id: sub.id,
            stripe_price_id: price,
            plan: planFor(price),
            subscription_status: subscriptionStatusFor(sub.status),
            current_period_end: periodEndOf(sub),
            trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          })
          .eq("id", orgId);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const orgId = await orgIdFor(sub.metadata, customerIdOf(sub.customer));
        if (!orgId) break;
        await admin
          .from("organizations")
          .update({ subscription_status: "canceled", current_period_end: periodEndOf(sub) })
          .eq("id", orgId);
        break;
      }
      case "invoice.payment_failed":
      case "invoice.paid": {
        const invoice = event.data.object;
        const orgId = await orgIdFor(null, customerIdOf(invoice.customer));
        if (!orgId) break;
        await admin
          .from("organizations")
          .update({ subscription_status: event.type === "invoice.paid" ? "active" : "past_due" })
          .eq("id", orgId);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur de traitement.";
    // 500 makes Stripe retry the event later.
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
