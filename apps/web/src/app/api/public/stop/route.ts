import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Public « STOP » endpoint of the non-essential messages (relance
 * d'entretien, avoir, satisfaction) — RGPD: every prospecting message carries
 * a way out. The client's 16-character public token is the only key.
 *
 *   POST /api/public/stop { token, resubscribe?: boolean }
 */
const TOKEN = /^[a-f0-9]{16}$/;

export async function POST(request: Request) {
  let body: { token?: string; resubscribe?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  if (!TOKEN.test(token)) return NextResponse.json({ error: "Lien invalide." }, { status: 404 });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("unsubscribe_client", {
    p_token: token,
    p_resubscribe: body.resubscribe === true,
  });
  if (error || !data) return NextResponse.json({ error: "Lien invalide." }, { status: 404 });
  return NextResponse.json(data);
}
