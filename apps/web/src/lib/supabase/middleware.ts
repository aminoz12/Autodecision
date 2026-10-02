import { createClient, type User } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

/** One call to Supabase may take this long before the page is let through. */
const CHECK_TIMEOUT_MS = 6000;
/** A token this close to its end is left to the browser, which renews it. */
const EXPIRY_MARGIN_S = 60;

export type SessionCheck = {
  user: User | null;
  /**
   * False when nobody can say whether the visitor is signed in — Supabase did
   * not answer, or the token is at its end and the browser is about to renew
   * it. The caller must then let the page load, not send the visitor to login.
   */
  verified: boolean;
};

type StoredSession = { accessToken: string; expiresAt: number };

/** The default session cookie of @supabase/ssr: sb-<project ref>-auth-token. */
function defaultCookieName(): string {
  return `sb-${new URL(getSupabaseUrl()).hostname.split(".")[0]}-auth-token`;
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * The session as the browser stored it (one cookie, or chunks .0 .1 …).
 * "none" = no cookie at all; "unreadable" = a cookie we cannot parse.
 */
function readSession(request: NextRequest, name: string): StoredSession | "none" | "unreadable" {
  let raw = request.cookies.get(name)?.value ?? "";
  if (!raw) {
    for (let i = 0; ; i++) {
      const chunk = request.cookies.get(`${name}.${i}`)?.value;
      if (!chunk) break;
      raw += chunk;
    }
  }
  if (!raw) return "none";
  try {
    const json = raw.startsWith("base64-") ? fromBase64Url(raw.slice(7)) : raw;
    const session = JSON.parse(json) as { access_token?: unknown; expires_at?: unknown };
    if (typeof session.access_token !== "string" || !session.access_token) return "unreadable";
    return { accessToken: session.access_token, expiresAt: Number(session.expires_at) || 0 };
  } catch {
    return "unreadable";
  }
}

/**
 * Who is signed in, from the session cookie — WITHOUT ever renewing the session.
 *
 * Only the browser renews it. A renewal done here races the browser's own: the
 * journal of 2026-10-01 shows « Too many concurrent token refresh requests »
 * signing a caissier out in the middle of an order, and a livreur losing the
 * session on a flaky mobile network (the renewed token never reached the phone,
 * and Supabase revokes a session whose old token is presented again).
 * `cookieName` selects another session store (the garage portal keeps its own).
 */
export async function checkSession(request: NextRequest, cookieName?: string): Promise<SessionCheck> {
  const session = readSession(request, cookieName ?? defaultCookieName());
  if (session === "none") return { user: null, verified: true };
  if (session === "unreadable") return { user: null, verified: false };
  const secondsLeft = session.expiresAt - Math.floor(Date.now() / 1000);
  if (secondsLeft < EXPIRY_MARGIN_S) return { user: null, verified: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const supabase = createClient(getSupabaseUrl(), getSupabaseAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }) },
    });
    // With a token given, getUser asks Supabase about that token and nothing else.
    const { data, error } = await supabase.auth.getUser(session.accessToken);
    if (data.user) return { user: data.user, verified: true };
    const status = error?.status ?? null;
    // Supabase said no (401 / 403): the token is not valid — signed out, account removed.
    const refused = status === 401 || status === 403;
    return { user: null, verified: refused };
  } catch {
    return { user: null, verified: false };
  } finally {
    clearTimeout(timer);
  }
}
