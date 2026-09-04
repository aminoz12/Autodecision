import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Send one SMS through the configured provider (server-only).
 * Provider: Twilio-compatible env vars — TWILIO_ACCOUNT_SID,
 * TWILIO_AUTH_TOKEN, TWILIO_FROM. Without them the SMS is SIMULATED
 * (returned as { simulated: true }) so the workflow keeps working and the
 * magasin knows nothing left the building.
 */
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

    let body: { phone?: string; message?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const phone = (body.phone ?? "").replace(/[^\d+]/g, "");
    const message = (body.message ?? "").trim().slice(0, 640);
    if (phone.length < 6 || !message) {
      return NextResponse.json({ error: "Téléphone et message requis." }, { status: 400 });
    }

    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) {
      // No provider configured: the app records the notification but nothing
      // is actually sent. Configure Twilio env vars to go live.
      return NextResponse.json({ ok: true, simulated: true });
    }

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: phone, From: from, Body: message }).toString(),
    });
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { message?: string } | null;
      return NextResponse.json(
        { error: detail?.message ?? `Envoi SMS refusé (${res.status}).` },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, simulated: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
