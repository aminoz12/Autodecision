import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Public endpoint behind the link of the « la pièce vous convient ? » SMS.
 * No session: the 16-character token of the survey is the only key. It
 * exposes the magasin's name and review link, nothing about the order.
 *
 *   GET  /api/public/avis?token=…            → { magasin, answer, review_url }
 *   POST /api/public/avis { token, answer: "OUI" | "NON", comment? }
 */
const TOKEN = /^[a-f0-9]{16}$/;

// Light in-memory brake per instance: a token cannot be brute-forced through here.
const hits = new Map<string, { n: number; at: number }>();
function limited(key: string): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.at > 60_000) {
    hits.set(key, { n: 1, at: now });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  h.n += 1;
  return h.n > 30;
}

function clientKey(request: Request): string {
  return (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!TOKEN.test(token)) return NextResponse.json({ error: "Lien invalide." }, { status: 404 });
  if (limited(clientKey(request))) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("satisfaction_context", { p_token: token });
  if (error || !data) return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 404 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  if (limited(clientKey(request))) return NextResponse.json({ error: "Trop de requêtes." }, { status: 429 });
  let body: { token?: string; answer?: string; comment?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const token = String(body.token ?? "");
  const answer = body.answer === "OUI" ? "OUI" : body.answer === "NON" ? "NON" : null;
  if (!TOKEN.test(token) || !answer) return NextResponse.json({ error: "Requête invalide." }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("answer_satisfaction", {
    p_token: token,
    p_answer: answer,
    p_comment: typeof body.comment === "string" ? body.comment.slice(0, 1000) : null,
  });
  if (error || !data) return NextResponse.json({ error: "Lien invalide ou expiré." }, { status: 404 });
  return NextResponse.json(data);
}
