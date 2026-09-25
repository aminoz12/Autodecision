/**
 * SERVER ONLY — empties the after-sales message queue.
 *
 * The database (migration 20260920020000) drops rows into sms_notifications
 * with a `kind` and the variables of the message; nothing in them is free
 * text typed by a user. This module turns each due row into the magasin's
 * wording (lib/sms.ts), re-checks that the message still makes sense (the
 * client may have come by in the meantime), and hands it to Twilio.
 *
 * Called by /api/notifications/dispatch (cron + bell) for every magasin and
 * by /api/sav/send-queued for one magasin right after a manual action.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAINTENANCE_RULES } from "@/lib/sav";
import { buildQueuedSms, isQueuedSmsKind, toE164, type QueuedSmsKind, type SmsSettings } from "@/lib/sms";
import { sendTextMessage } from "@/lib/sms-provider";

const PER_ORG_PER_DAY = 300;
/** Messages the client did not ask for: never on a Sunday. */
const NON_ESSENTIAL: QueuedSmsKind[] = ["SATISFACTION", "AVOIR_BALANCE", "AVOIR_DORMANT", "MAINTENANCE"];
const PICKUP_KINDS: QueuedSmsKind[] = ["READY", "PICKUP_3", "PICKUP_7", "PICKUP_15"];

export type QueueResult = { due: number; sent: number; simulated: number; failed: number; skipped: number; held: number };

type QueueRow = {
  id: string;
  organization_id: string;
  order_id: string | null;
  client_id: string | null;
  phone: string | null;
  kind: string;
  channel: string | null;
  vars: Record<string, unknown> | null;
  entity: string | null;
  entity_id: string | null;
};

type OrgWording = SmsSettings & { templates: Record<string, string> | null };

/** Hour (0-23) and weekday (0 = Sunday) in Paris. */
export function parisClock(now: Date = new Date()): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "12") % 24;
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  return { hour, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd) };
}

/** Nobody wants a text from the parts shop at night: 8h–20h, and no prospecting on Sundays. */
export function canSendNow(kind: QueuedSmsKind, now: Date = new Date()): boolean {
  const { hour, weekday } = parisClock(now);
  if (hour < 8 || hour >= 20) return false;
  if (weekday === 0 && NON_ESSENTIAL.includes(kind)) return false;
  return true;
}

async function loadWording(admin: SupabaseClient, orgId: string): Promise<OrgWording> {
  const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
  const [org, sav] = await Promise.all([
    admin.from("organizations").select("name, sms_horaires, sms_ready_template, sms_partial_template").eq("id", orgId).maybeSingle(),
    admin.from("sav_settings").select("templates").eq("organization_id", orgId).maybeSingle(),
  ]);
  const row = (org.data ?? {}) as Record<string, unknown>;
  const templates = (sav.data as { templates?: unknown } | null)?.templates;
  return {
    magasin: String(row.name ?? ""),
    horaires: s(row.sms_horaires),
    readyTemplate: s(row.sms_ready_template),
    partialTemplate: s(row.sms_partial_template),
    templates: templates && typeof templates === "object" ? (templates as Record<string, string>) : null,
  };
}

/** Why a queued message should not go out any more; null = still relevant. */
async function obsoleteReason(admin: SupabaseClient, row: QueueRow, kind: QueuedSmsKind): Promise<string | null> {
  if (PICKUP_KINDS.includes(kind) && row.order_id) {
    const { data } = await admin
      .from("orders")
      .select("picked_up_at, cancelled_at, workflow_status")
      .eq("id", row.order_id)
      .maybeSingle();
    const o = data as { picked_up_at?: string | null; cancelled_at?: string | null; workflow_status?: string } | null;
    if (!o) return "OBSOLETE: commande introuvable";
    if (o.cancelled_at) return "OBSOLETE: commande annulée";
    if (o.picked_up_at || o.workflow_status === "DELIVERED") return "OBSOLETE: déjà retirée";
  }
  if (kind === "CONSIGNE_REMINDER" && row.entity_id) {
    const { data } = await admin.from("consignment_entries").select("status").eq("id", row.entity_id).maybeSingle();
    if ((data as { status?: string } | null)?.status !== "ACTIF") return "OBSOLETE: consigne rendue";
  }
  if ((kind === "AVOIR_BALANCE" || kind === "AVOIR_DORMANT") && row.entity_id) {
    const { data } = await admin.from("credit_notes").select("amount, used_amount, statut").eq("id", row.entity_id).maybeSingle();
    const c = data as { amount?: number; used_amount?: number; statut?: string } | null;
    if (!c || !["EN_COURS", "PARTIEL"].includes(String(c.statut)) || Number(c.amount) - Number(c.used_amount) <= 0) {
      return "OBSOLETE: avoir consommé";
    }
  }
  return null;
}

/** A photo of the part taken at reception, for the WhatsApp « commande prête ». */
async function readyPhotoUrl(admin: SupabaseClient, orderId: string | null): Promise<string | null> {
  if (!orderId) return null;
  const { data } = await admin
    .from("order_lines")
    .select("reception_photo_path")
    .eq("order_id", orderId)
    .not("reception_photo_path", "is", null)
    .limit(1);
  const path = (data?.[0] as { reception_photo_path?: string } | undefined)?.reception_photo_path;
  if (!path) return null;
  const signed = await admin.storage.from("sav").createSignedUrl(path, 7 * 86_400);
  return signed.data?.signedUrl ?? null;
}

export async function processSmsQueue(
  admin: SupabaseClient,
  opts: { origin: string; orgId?: string; limit?: number; now?: Date },
): Promise<QueueResult> {
  const now = opts.now ?? new Date();
  const result: QueueResult = { due: 0, sent: 0, simulated: 0, failed: 0, skipped: 0, held: 0 };

  let query = admin
    .from("sms_notifications")
    .select("id, organization_id, order_id, client_id, phone, kind, channel, vars, entity, entity_id")
    .not("kind", "is", null)
    .eq("status", "A_ENVOYER")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(opts.limit ?? 40);
  if (opts.orgId) query = query.eq("organization_id", opts.orgId);
  const { data, error } = await query;
  if (error) {
    // Database not migrated yet (no `kind` column): nothing to send.
    if (/kind|scheduled_for|column/i.test(error.message)) return result;
    throw new Error(error.message);
  }

  const rows = (data ?? []) as QueueRow[];
  result.due = rows.length;
  const wording = new Map<string, OrgWording>();
  const sentToday = new Map<string, number>();
  const countryCode = process.env.SMS_DEFAULT_COUNTRY_CODE || "33";
  const origin = opts.origin.replace(/\/$/, "");

  const close = async (id: string, patch: Record<string, unknown>) => {
    const { error: e } = await admin.from("sms_notifications").update(patch).eq("id", id);
    if (e) console.error("sms-queue: could not update", id, e.message);
  };

  for (const row of rows) {
    if (!isQueuedSmsKind(row.kind)) {
      await close(row.id, { status: "ECHEC", error: `UNKNOWN_KIND ${row.kind}`, traite: true });
      result.failed += 1;
      continue;
    }
    const kind = row.kind;
    if (!canSendNow(kind, now)) {
      result.held += 1; // stays queued until the morning / Monday
      continue;
    }

    const stale = await obsoleteReason(admin, row, kind);
    if (stale) {
      await close(row.id, { status: "ECHEC", error: stale, traite: true });
      result.skipped += 1;
      continue;
    }

    const to = toE164(row.phone, countryCode);
    if (!to) {
      await close(row.id, { status: "ECHEC", error: "INVALID_PHONE", traite: true });
      result.failed += 1;
      continue;
    }

    if (!sentToday.has(row.organization_id)) {
      const { count } = await admin
        .from("sms_notifications")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", row.organization_id)
        .eq("status", "ENVOYE")
        .gte("created_at", new Date(now.getTime() - 86_400_000).toISOString());
      sentToday.set(row.organization_id, count ?? 0);
    }
    if ((sentToday.get(row.organization_id) ?? 0) >= PER_ORG_PER_DAY) {
      result.held += 1;
      continue;
    }

    let settings = wording.get(row.organization_id);
    if (!settings) {
      settings = await loadWording(admin, row.organization_id);
      wording.set(row.organization_id, settings);
    }

    const vars: Record<string, unknown> = { ...(row.vars ?? {}) };
    if (kind === "MAINTENANCE") {
      vars.piece = MAINTENANCE_RULES[String(vars.famille ?? "")]?.sms ?? "votre véhicule";
    }
    const token = typeof vars.token === "string" ? vars.token : "";
    const { text } = buildQueuedSms(kind, vars, settings, {
      lien: token ? `${origin}/avis/${token}` : origin,
      stop: token ? `${origin}/stop/${token}` : origin,
    });

    const channel = row.channel === "WHATSAPP" ? "WHATSAPP" : "SMS";
    const mediaUrl = channel === "WHATSAPP" && kind === "READY" ? await readyPhotoUrl(admin, row.order_id) : null;

    try {
      const sent = await sendTextMessage({ to, body: text, channel, mediaUrl });
      if (!sent.ok) {
        await close(row.id, { status: "ECHEC", message: text, phone: to, error: `HTTP ${sent.status} ${sent.detail}`.slice(0, 300) });
        result.failed += 1;
        continue;
      }
      await close(row.id, {
        status: "ENVOYE",
        message: text,
        phone: to,
        channel: sent.channel,
        simulated: sent.simulated,
        sent_at: new Date().toISOString(),
        error: null,
      });
      sentToday.set(row.organization_id, (sentToday.get(row.organization_id) ?? 0) + 1);
      if (sent.simulated) result.simulated += 1;
      else result.sent += 1;
    } catch (e) {
      await close(row.id, { status: "ECHEC", message: text, error: e instanceof Error ? e.message.slice(0, 300) : "send failed" });
      result.failed += 1;
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Relances fournisseur par e-mail (dossiers garantie sans réponse)   */
/* ------------------------------------------------------------------ */

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export async function processSupplierReminders(admin: SupabaseClient): Promise<{ sent: number; simulated: number }> {
  const out = { sent: 0, simulated: 0 };
  const { data, error } = await admin
    .from("sav_case_events")
    .select("id, email_to, meta, organization_id, organizations(name, phone)")
    .eq("kind", "SUPPLIER_REMINDER")
    .not("email_to", "is", null)
    .is("email_sent_at", null)
    .order("created_at", { ascending: true })
    .limit(20);
  if (error) return out; // table absent before the migration

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  for (const raw of data ?? []) {
    const ev = raw as unknown as {
      id: string;
      email_to: string;
      meta: Record<string, unknown> | null;
      organizations?: { name?: string; phone?: string } | { name?: string; phone?: string }[] | null;
    };
    const org = Array.isArray(ev.organizations) ? ev.organizations[0] : ev.organizations;
    const magasin = org?.name ?? "Notre magasin";
    if (!apiKey || !from) {
      await admin.from("sav_case_events").update({ email_sent_at: new Date().toISOString(), email_error: "NO_PROVIDER" }).eq("id", ev.id);
      out.simulated += 1;
      continue;
    }
    const m = ev.meta ?? {};
    const v = (k: string): string => (m[k] == null ? "" : String(m[k]));
    const declared = v("declared_at") ? new Date(v("declared_at")).toLocaleDateString("fr-FR") : "";
    const lines = [
      `Bonjour,`,
      `Nous restons sans réponse sur le dossier de garantie ci-dessous${declared ? `, déclaré le ${declared}` : ""}.`,
      v("case_number") ? `Votre n° de dossier : ${v("case_number")}` : "",
      `Notre référence : ${v("ref")}`,
      `Pièce : ${v("designation")}${v("reference") ? ` (réf. ${v("reference")})` : ""}${v("serial_number") ? ` — n° de série ${v("serial_number")}` : ""}`,
      `Merci de nous indiquer votre décision ou l'avancement de l'expertise.`,
      `Cordialement,`,
      `${magasin}${org?.phone ? ` — ${org.phone}` : ""}`,
    ].filter(Boolean);
    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#1a1f36;line-height:1.55">` +
      lines.map((l) => `<p style="margin:0 0 10px">${escapeHtml(l)}</p>`).join("") +
      `</div>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          to: [ev.email_to],
          subject: `Relance garantie ${v("case_number") || v("ref")} — ${magasin}`,
          html,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        await admin.from("sav_case_events").update({ email_error: `HTTP ${res.status} ${detail.slice(0, 200)}` }).eq("id", ev.id);
        continue;
      }
      await admin.from("sav_case_events").update({ email_sent_at: new Date().toISOString(), email_error: null }).eq("id", ev.id);
      out.sent += 1;
    } catch (e) {
      await admin.from("sav_case_events").update({ email_error: e instanceof Error ? e.message.slice(0, 200) : "send failed" }).eq("id", ev.id);
    }
  }
  return out;
}
