import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Send one SMS to the client of an order (server-only).
 *
 * The destination number is resolved from the ORDER, never taken from the
 * request: a compromised cashier session cannot turn this route into a relay
 * to arbitrary (premium-rate) numbers. Every send is recorded in
 * sms_notifications with the sender, and two quotas apply: 10 per minute per
 * user, 300 per day per organization.
 *
 * Provider: Twilio-compatible env vars — TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, TWILIO_FROM. Without them the SMS is SIMULATED
 * (returned as { simulated: true }) so the workflow keeps working and the
 * magasin knows nothing left the building.
 */
const PER_USER_PER_MINUTE = 10;
const PER_ORG_PER_DAY = 300;

function digits(v: string | null | undefined): string {
  return (v ?? "").replace(/[^\d+]/g, "");
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
    }
    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("organization_id, client_id, livreur_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!profile || profile.client_id || profile.livreur_id) {
      return NextResponse.json({ error: "Accès réservé au personnel du magasin." }, { status: 403 });
    }
    const orgId = profile.organization_id as string;

    let body: { orderId?: string; message?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const orderId = (body.orderId ?? "").trim();
    const message = (body.message ?? "").trim().slice(0, 640);
    if (!orderId || !message) {
      return NextResponse.json({ error: "Commande et message requis." }, { status: 400 });
    }

    // The order must belong to the caller's organization; the phone comes from it.
    const { data: order } = await admin
      .from("orders")
      .select("id, organization_id, client_id, client_phone, clients(phone)")
      .eq("id", orderId)
      .maybeSingle();
    if (!order || order.organization_id !== orgId) {
      return NextResponse.json({ error: "Commande introuvable." }, { status: 404 });
    }
    const clientRow = Array.isArray(order.clients) ? order.clients[0] : order.clients;
    const phone =
      digits(order.client_phone).length >= 6
        ? digits(order.client_phone)
        : digits((clientRow as { phone?: string | null } | null)?.phone);
    if (phone.length < 6) {
      return NextResponse.json({ error: "Ce client n'a pas de numéro de téléphone." }, { status: 400 });
    }

    // Quotas.
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
    const [{ count: perUser }, { count: perOrg }] = await Promise.all([
      admin
        .from("sms_notifications")
        .select("id", { count: "exact", head: true })
        .eq("sent_by", user.id)
        .gte("created_at", minuteAgo),
      admin
        .from("sms_notifications")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .eq("status", "ENVOYE")
        .gte("created_at", dayAgo),
    ]);
    if ((perUser ?? 0) >= PER_USER_PER_MINUTE) {
      return NextResponse.json({ error: "Trop d'envois en une minute. Réessayez dans un instant." }, { status: 429 });
    }
    if ((perOrg ?? 0) >= PER_ORG_PER_DAY) {
      return NextResponse.json({ error: "Quota quotidien de SMS atteint pour ce magasin." }, { status: 429 });
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    let simulated = true;
    if (sid && token && from) {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: phone, From: from, Body: message }).toString(),
      });
      if (!res.ok) {
        console.error("send-sms: provider refused", res.status, await res.text().catch(() => ""));
        return NextResponse.json({ error: `Envoi SMS refusé par le fournisseur (${res.status}).` }, { status: 502 });
      }
      simulated = false;
    }

    // Record the send (server-side, with the actor) — this is also the quota ledger.
    const { error: insErr } = await admin.from("sms_notifications").insert({
      organization_id: orgId,
      order_id: order.id,
      client_id: order.client_id,
      phone,
      message,
      status: "ENVOYE",
      sent_at: new Date().toISOString(),
      sent_by: user.id,
    });
    if (insErr) {
      console.error("send-sms: could not record", insErr.message);
    }
    return NextResponse.json({ ok: true, simulated });
  } catch (err) {
    console.error("send-sms:", err);
    return NextResponse.json({ error: "Erreur serveur lors de l'envoi du SMS." }, { status: 500 });
  }
}
