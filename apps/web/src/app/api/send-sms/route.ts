import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildClientSms, toE164, type SmsKind, type SmsSettings } from "@/lib/sms";
import { sendTextMessage } from "@/lib/sms-provider";

/**
 * Send the « commande prête » SMS to the client of an order (server-only).
 *
 * Nothing in the request is free text: the caller names an order and a kind
 * (READY = toutes les pièces, PARTIAL = reliquat en cours). The phone number
 * comes from the order and the wording from the magasin settings + lib/sms.ts,
 * so a compromised cashier session can neither relay arbitrary messages nor
 * reach arbitrary (premium-rate) numbers. Every attempt is recorded in
 * sms_notifications with the sender (ENVOYE / ECHEC); two quotas apply:
 * 10 per minute per user, 300 sent per day per organization.
 *
 * Provider: Twilio - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM
 * (a phone number, or a Messaging Service SID starting with "MG").
 * SMS_DEFAULT_COUNTRY_CODE (default 33) turns "06 12 34 56 78" into E.164.
 * Without the Twilio variables the SMS is SIMULATED ({ simulated: true }) so
 * the workflow keeps working and the magasin knows nothing left the building.
 */
const PER_USER_PER_MINUTE = 10;
const PER_ORG_PER_DAY = 300;

const SMS_COLUMNS = "name, sms_horaires, sms_ready_template, sms_partial_template";

type Admin = ReturnType<typeof createAdminClient>;

/** Magasin wording; tolerates a database where the SMS columns are not migrated yet. */
async function loadSmsSettings(admin: Admin, orgId: string): Promise<SmsSettings> {
  const full = await admin.from("organizations").select(SMS_COLUMNS).eq("id", orgId).maybeSingle();
  if (!full.error && full.data) {
    const row = full.data as Record<string, unknown>;
    const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
    return {
      magasin: String(row.name ?? ""),
      horaires: s(row.sms_horaires),
      readyTemplate: s(row.sms_ready_template),
      partialTemplate: s(row.sms_partial_template),
    };
  }
  const min = await admin.from("organizations").select("name").eq("id", orgId).maybeSingle();
  return {
    magasin: String((min.data as { name?: string } | null)?.name ?? ""),
    horaires: null,
    readyTemplate: null,
    partialTemplate: null,
  };
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

    let body: { orderId?: string; kind?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const orderId = (body.orderId ?? "").trim();
    const kind: SmsKind = body.kind === "PARTIAL" ? "PARTIAL" : "READY";
    if (!orderId) {
      return NextResponse.json({ error: "Commande requise." }, { status: 400 });
    }

    // The order must belong to the caller's organization; phone and client name come from it.
    const { data: order } = await admin
      .from("orders")
      .select("id, organization_id, client_id, client_phone, ref_demande, clients(name, phone)")
      .eq("id", orderId)
      .maybeSingle();
    if (!order || order.organization_id !== orgId) {
      return NextResponse.json({ error: "Commande introuvable." }, { status: 404 });
    }
    const clientRow = (Array.isArray(order.clients) ? order.clients[0] : order.clients) as
      | { name?: string | null; phone?: string | null }
      | null;
    const countryCode = process.env.SMS_DEFAULT_COUNTRY_CODE || "33";
    const phone = toE164(order.client_phone, countryCode) ?? toE164(clientRow?.phone, countryCode);
    if (!phone) {
      return NextResponse.json(
        { error: "Ce client n'a pas de numéro de téléphone valide (ex. 06 12 34 56 78)." },
        { status: 400 },
      );
    }

    const settings = await loadSmsSettings(admin, orgId);
    const { text: message, size } = buildClientSms(
      kind,
      { client: String(clientRow?.name ?? ""), commande: String(order.ref_demande ?? "") },
      settings,
    );

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

    // Every attempt is written server-side with the actor: it is also the quota ledger.
    const record = async (status: "ENVOYE" | "ECHEC", simulated = false) => {
      const base = {
        organization_id: orgId,
        order_id: order.id,
        client_id: order.client_id,
        phone,
        message,
        status,
        sent_at: status === "ENVOYE" ? new Date().toISOString() : null,
        sent_by: user.id,
      };
      // `kind` lets the after-sales automation see that « commande prête » already went out
      // (migration 20260920020000); a database without the column still gets the ledger row.
      let { error } = await admin.from("sms_notifications").insert({ ...base, kind, simulated });
      if (error && /kind|simulated|column/i.test(error.message)) {
        ({ error } = await admin.from("sms_notifications").insert(base));
      }
      if (error) console.error("send-sms: could not record", error.message);
    };

    const sent = await sendTextMessage({ to: phone, body: message });
    if (!sent.ok) {
      await record("ECHEC");
      return NextResponse.json(
        { error: `Envoi refusé par le fournisseur SMS (${sent.status})${sent.detail ? ` : ${sent.detail}` : "."}` },
        { status: 502 },
      );
    }

    await record("ENVOYE", sent.simulated);
    return NextResponse.json({ ok: true, simulated: sent.simulated, to: phone, message, segments: size.segments });
  } catch (err) {
    console.error("send-sms:", err);
    return NextResponse.json({ error: "Erreur serveur lors de l'envoi du SMS." }, { status: 500 });
  }
}
