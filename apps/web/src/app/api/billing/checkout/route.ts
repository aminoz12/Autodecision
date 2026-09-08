import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl, getStripe, priceIdFor, stripeConfigured, type PlanInterval } from "@/lib/stripe";

/**
 * POST /api/billing/checkout  { interval?: "monthly" | "yearly" }
 * Starts a Stripe Checkout (subscription) for the caller's organization.
 * Only an ADMIN of the magasin can subscribe. Answers 503 when Stripe is not
 * configured so the UI can fall back to "contact us".
 */
export async function POST(request: Request) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: "Paiement en ligne non configuré." }, { status: 503 });
  }
  const stripe = getStripe();
  if (!stripe) {
    return NextResponse.json({ error: "Paiement en ligne non configuré." }, { status: 503 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("organization_id, role, client_id, livreur_id, display_name")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile?.organization_id || profile.role !== "ADMIN" || profile.client_id || profile.livreur_id) {
    return NextResponse.json({ error: "Seul un administrateur du magasin peut souscrire l'abonnement." }, { status: 403 });
  }
  const orgId = String(profile.organization_id);

  const { data: org, error: orgErr } = await admin
    .from("organizations")
    .select("id, name, stripe_customer_id, stripe_subscription_id, subscription_status, billing_email")
    .eq("id", orgId)
    .single();
  if (orgErr || !org) return NextResponse.json({ error: "Magasin introuvable." }, { status: 404 });

  let interval: PlanInterval = "monthly";
  try {
    const body = (await request.json()) as { interval?: string } | null;
    if (body?.interval === "yearly") interval = "yearly";
  } catch {
    // no body → monthly
  }
  const price = priceIdFor(interval);
  if (!price) return NextResponse.json({ error: "Formule indisponible." }, { status: 400 });

  try {
    // One Stripe customer per organization, created on first checkout.
    let customerId = (org.stripe_customer_id as string | null) ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: String(org.name ?? ""),
        email: (org.billing_email as string | null) ?? user.email ?? undefined,
        metadata: { org_id: orgId },
      });
      customerId = customer.id;
      await admin
        .from("organizations")
        .update({ stripe_customer_id: customerId, billing_email: org.billing_email ?? user.email ?? null })
        .eq("id", orgId);
    }

    // Already subscribed → send them to the portal instead of a second subscription.
    if (org.stripe_subscription_id && String(org.subscription_status ?? "").toLowerCase() === "active") {
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${appUrl(request)}/dashboard/parametres`,
      });
      return NextResponse.json({ url: portal.url, portal: true });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: orgId,
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      locale: "fr",
      success_url: `${appUrl(request)}/dashboard/parametres?billing=success`,
      cancel_url: `${appUrl(request)}/tarifs?billing=cancel`,
      metadata: { org_id: orgId },
      subscription_data: { metadata: { org_id: orgId } },
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur Stripe.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
