import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSmsQueue, processSupplierReminders, type QueueResult } from "@/lib/sms-queue";

export const dynamic = "force-dynamic";
// A run sends up to a batch of e-mails and SMS: give it room on Vercel.
export const maxDuration = 60;

/**
 * Email fan-out for notifications + hourly scheduled reminders.
 *
 * Called either by a cron — POST with `x-cron-secret: $CRON_SECRET`, or Vercel
 * Cron (apps/web/vercel.json), which sends GET with `Authorization: Bearer
 * $CRON_SECRET` — or opportunistically by the in-app bell of any signed-in user (rate limited
 * to one real run per minute per instance). Provider: Resend, env-gated —
 * without RESEND_API_KEY / EMAIL_FROM the emails are marked NO_PROVIDER so
 * the outbox does not grow forever and the in-app notification still works.
 *
 * The same run empties the after-sales SMS queue (commande prête, retard,
 * relances de retrait, consigne, satisfaction… — lib/sms-queue.ts) and the
 * supplier warranty reminders.
 */
const BATCH = 25;
/**
 * The scheduled reminders scan every order: about once an hour is enough. The Vercel
 * Cron fires every 10 minutes to empty the queues, and runs the scan only when the
 * last one is older than this (55 min, so a fire close to the hour mark still counts).
 */
const SCHEDULED_EVERY_MS = 55 * 60_000;
let lastRunAt = 0;
let lastScheduledAt = 0;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

function isCronCall(request: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return request.headers.get("x-cron-secret") === cronSecret || request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** Vercel Cron: a GET carrying the secret. Anyone else gets nothing from this door. */
export async function GET(request: Request) {
  if (!isCronCall(request)) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  return POST(request);
}

export async function POST(request: Request) {
  const isCron = isCronCall(request);
  if (!isCron) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
    if (Date.now() - lastRunAt < 60_000) return NextResponse.json({ ok: true, skipped: true });
  }
  lastRunAt = Date.now();

  const admin = createAdminClient();
  // Links in the messages (avis, STOP, « Ouvrir ») must be the public address, not the
  // deployment URL a cron call arrives on.
  const origin = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "") || new URL(request.url).origin;
  let scheduled: number | null = null;
  try {
    if (isCron || Date.now() - lastScheduledAt > 3_600_000) {
      const { data: job } = await admin.from("system_jobs").select("last_run_at").eq("name", "scheduled_notifications").maybeSingle();
      const last = job?.last_run_at ? new Date(job.last_run_at as string).getTime() : 0;
      if (Date.now() - last > SCHEDULED_EVERY_MS) {
        const { data } = await admin.rpc("generate_scheduled_notifications");
        scheduled = typeof data === "number" ? data : Number(data ?? 0);
      }
      lastScheduledAt = Date.now();
    }
  } catch (e) {
    console.error("dispatch: scheduled notifications failed", e);
  }

  // Messages au client déposés par la base (file sms_notifications) + relances fournisseur.
  let sms: QueueResult | null = null;
  let supplierReminders: { sent: number; simulated: number } | null = null;
  try {
    sms = await processSmsQueue(admin, { origin });
    supplierReminders = await processSupplierReminders(admin);
  } catch (e) {
    console.error("dispatch: sms queue failed", e);
  }

  const { data: pending, error } = await admin
    .from("notifications")
    .select("id,title,body,href,email_to,organization_id,organizations(name)")
    .not("email_to", "is", null)
    .is("email_sent_at", null)
    .order("created_at", { ascending: true })
    .limit(BATCH);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  let sent = 0;
  let simulated = 0;
  for (const raw of pending ?? []) {
    const n = raw as { id: string; title: string; body: string | null; href: string | null; email_to: string; organizations?: { name?: string } | { name?: string }[] | null };
    const orgRow = Array.isArray(n.organizations) ? n.organizations[0] : n.organizations;
    const orgName = orgRow?.name ?? "Votre magasin";
    if (!apiKey || !from) {
      await admin.from("notifications").update({ email_sent_at: new Date().toISOString(), email_error: "NO_PROVIDER" }).eq("id", n.id);
      simulated += 1;
      continue;
    }
    const link = n.href ? `${origin}${n.href}` : origin;
    const html =
      `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#1a1f36;line-height:1.5">` +
      `<p style="font-size:12px;color:#697386;margin:0 0 12px">${escapeHtml(orgName)}</p>` +
      `<h2 style="margin:0 0 8px;font-size:18px">${escapeHtml(n.title)}</h2>` +
      (n.body ? `<p style="margin:0 0 16px">${escapeHtml(n.body)}</p>` : "") +
      `<p><a href="${link}" style="background:#635BFF;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;display:inline-block">Ouvrir</a></p>` +
      `<p style="font-size:12px;color:#697386;margin-top:24px">Message automatique envoyé par ${escapeHtml(orgName)} via Autodecision.</p></div>`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [n.email_to], subject: `${orgName} — ${n.title}`, html }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        await admin.from("notifications").update({ email_error: `HTTP ${res.status} ${detail.slice(0, 200)}` }).eq("id", n.id);
        continue;
      }
      await admin.from("notifications").update({ email_sent_at: new Date().toISOString(), email_error: null }).eq("id", n.id);
      sent += 1;
    } catch (e) {
      await admin.from("notifications").update({ email_error: e instanceof Error ? e.message.slice(0, 200) : "send failed" }).eq("id", n.id);
    }
  }

  return NextResponse.json({ ok: true, sent, simulated, pending: (pending ?? []).length, scheduled, sms, supplierReminders });
}
