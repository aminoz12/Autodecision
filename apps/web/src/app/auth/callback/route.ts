import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * Lands the links Supabase Auth sends by email (password recovery, invitation,
 * email confirmation) and turns them into a session cookie, then continues to
 * `next` (same-origin paths only).
 *
 * Supabase → Authentication → URL configuration must list
 * `<site>/auth/callback` in the redirect URLs.
 */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  const next = safeNext(url.searchParams.get("next"));

  const supabase = await createClient();
  let ok = false;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    ok = !error;
  }

  if (ok) {
    return NextResponse.redirect(new URL(next, request.url));
  }
  return NextResponse.redirect(new URL("/mot-de-passe-oublie?erreur=lien", request.url));
}
