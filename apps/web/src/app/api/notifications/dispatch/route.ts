import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSmsQueue, processSupplierReminders, type QueueResult } from "@/lib/sms-queue";

export const dynamic = "force-dynamic";

/**
 * Email fan-out for notifications + hourly scheduled reminders.
 *
 * Called either by a cron (header `x-cron-secret: $CRON_SECRET`) or
 * opportunistically by the in-app bell of any signed-in user (rate limited
 * to one real run per minute per instance). Provider: Resend, env-gated —
 * without RESEND_API_KEY / EMAIL_FROM the emails are marked NO_PROVIDER so
 * the outbox does not grow forever and the in-app notification still works.
 *
 * The same run empties the after-sales SMS queue (commande prête, retard,
 * relances de retrait, consigne, satisfaction… — lib/sms-queue.ts) and the
 * supplier warranty reminders.
 */
const BATCH = 25;
let lastRunAt = 0;
let lastScheduledAt = 0;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export async function POST(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && request.headers.get("x-cron-secret") === cronSecret;
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
  const origin = new URL(request.url).origin;
  let scheduled: number | null = null;
  try {
    if (isCron || Date.now() - lastScheduledAt > 3_600_000) {
      const { data: job } = await admin.from("system_jobs").select("last_run_at").eq("name", "scheduled_notifications").maybeSingle();
      const last = job?.last_run_at ? new Date(job.last_run_at as string).getTime() : 0;
      if (isCron || Date.now() - last > 3_600_000) {
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
    // Links in the messages (avis, STOP) must be the public address, not an internal one.
    const publicOrigin = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "") || origin;
    sms = await processSmsQueue(admin, { origin: publicOrigin });
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
