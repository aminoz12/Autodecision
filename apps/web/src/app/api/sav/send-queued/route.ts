import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processSmsQueue } from "@/lib/sms-queue";

export const dynamic = "force-dynamic";

/**
 * Send, right now, the after-sales messages queued for the caller's magasin
 * (counter staff only). Used after a manual action — « prévenir le client de
 * son avoir », « rappeler la consigne » — so the vendeur sees the outcome
 * without waiting for the next cron run. The request carries nothing: texts
 * and recipients come from the queue, which only the database can fill.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });

    const admin = createAdminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("organization_id, client_id, livreur_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!profile || profile.client_id || profile.livreur_id) {
      return NextResponse.json({ error: "Accès réservé au personnel du magasin." }, { status: 403 });
    }

    const origin = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "") || new URL(request.url).origin;
    const result = await processSmsQueue(admin, { origin, orgId: profile.organization_id as string, limit: 20 });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("sav/send-queued:", err);
    return NextResponse.json({ error: "Erreur serveur lors de l'envoi." }, { status: 500 });
  }
}
