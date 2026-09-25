/**
 * SERVER ONLY (reads the Twilio secrets) — import from route handlers, never
 * from a client component.
 *
 * One place that talks to Twilio, shared by /api/send-sms (manual « commande
 * prête ») and the after-sales queue (lib/sms-queue.ts).
 *
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM  — SMS (a number, or a
 *     Messaging Service SID starting with "MG").
 *   TWILIO_WHATSAPP_FROM — optional WhatsApp sender ("+14155238886"). Without
 *     it a WHATSAPP message goes out as a plain SMS. Business-initiated
 *     WhatsApp messages must match a template approved in the Twilio console.
 *
 * Without the Twilio variables nothing leaves the building: { simulated: true }.
 */
export type SendResult =
  | { ok: true; simulated: boolean; channel: "SMS" | "WHATSAPP" }
  | { ok: false; status: number; detail: string };

export function smsProviderConfigured(): boolean {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
}

export async function sendTextMessage(input: {
  /** E.164, e.g. +33612345678. */
  to: string;
  body: string;
  channel?: "SMS" | "WHATSAPP";
  /** Public (signed) image URL — WhatsApp only. */
  mediaUrl?: string | null;
}): Promise<SendResult> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  const whatsappFrom = (process.env.TWILIO_WHATSAPP_FROM ?? "").trim();
  if (!sid || !token || !from) return { ok: true, simulated: true, channel: "SMS" };

  const viaWhatsapp = input.channel === "WHATSAPP" && whatsappFrom !== "";
  const params = new URLSearchParams({ Body: input.body });
  if (viaWhatsapp) {
    params.set("To", `whatsapp:${input.to}`);
    params.set("From", whatsappFrom.startsWith("whatsapp:") ? whatsappFrom : `whatsapp:${whatsappFrom}`);
    if (input.mediaUrl) params.set("MediaUrl", input.mediaUrl);
  } else {
    params.set("To", input.to);
    // A Messaging Service (MG...) picks the sender itself; otherwise a number / sender ID.
    if (from.startsWith("MG")) params.set("MessagingServiceSid", from);
    else params.set("From", from);
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (res.ok) return { ok: true, simulated: false, channel: viaWhatsapp ? "WHATSAPP" : "SMS" };

  const raw = await res.text().catch(() => "");
  let detail = "";
  try {
    const parsed = JSON.parse(raw) as { message?: string; code?: number };
    detail = [parsed.code ? `code ${parsed.code}` : "", parsed.message ?? ""].filter(Boolean).join(", ");
  } catch {
    detail = raw.slice(0, 200);
  }
  console.error("sms-provider: refused", res.status, raw);
  return { ok: false, status: res.status, detail };
}
