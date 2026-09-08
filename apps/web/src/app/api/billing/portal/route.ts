import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { appUrl, getStripe } from "@/lib/stripe";

/**
 * POST /api/billing/portal — opens the Stripe customer portal (invoices,
 * payment method, cancellation) for the caller's organization. ADMIN only.
 */
export async function POST(request: Request) {
  const stripe = getStripe();
  if (!stripe) return NextResponse.json({ error: "Paiement en ligne non configuré." }, { status: 503 });

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("organization_id, role, client_id, livreur_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile?.organization_id || profile.role !== "ADMIN" || profile.client_id || profile.livreur_id) {
    return NextResponse.json({ error: "Réservé à l'administrateur du magasin." }, { status: 403 });
  }
  const { data: org } = await admin
    .from("organizations")
    .select("stripe_customer_id")
    .eq("id", String(profile.organization_id))
    .maybeSingle();
  const customerId = (org?.stripe_customer_id as string | null) ?? null;
  if (!customerId) {
    return NextResponse.json({ error: "Aucun abonnement Stripe pour ce magasin." }, { status: 404 });
  }
  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl(request)}/dashboard/parametres`,
    });
    return NextResponse.json({ url: portal.url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur Stripe.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
