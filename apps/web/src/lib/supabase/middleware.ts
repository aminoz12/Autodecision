import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

/** One call to Supabase may take this long… */
const FETCH_TIMEOUT_MS = 6000;
/** …and the whole check this long (a token refresh retries on its own). */
const CHECK_TIMEOUT_MS = 8000;

/** fetch that gives up: an edge function waiting on a silent server is killed by the host. */
const timedFetch: typeof fetch = (input, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

export type SessionCheck = {
  response: NextResponse;
  user: User | null;
  /**
   * False when Supabase did not answer (timeout, network, 5xx): nobody can say
   * whether the visitor is signed in, so the caller must not send them to login.
   */
  verified: boolean;
};

/**
 * Who is signed in, from the session cookie — refreshed on the way when it expired.
 * `cookieName` selects another session store (the garage portal keeps its own).
 */
export async function updateSession(request: NextRequest, cookieName?: string): Promise<SessionCheck> {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(getSupabaseUrl(), getSupabaseAnonKey(),
    {
      ...(cookieName ? { cookieOptions: { name: cookieName } } : {}),
      global: { fetch: timedFetch },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  try {
    const result = await Promise.race([
      supabase.auth.getUser(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CHECK_TIMEOUT_MS)),
    ]);
    if (!result) return { response: supabaseResponse, user: null, verified: false };
    const { data, error } = result;
    const status = error?.status ?? null;
    const unreachable = !!error && (error.name === "AuthRetryableFetchError" || status === 0 || (status !== null && status >= 500));
    return { response: supabaseResponse, user: data.user, verified: !unreachable };
  } catch {
    return { response: supabaseResponse, user: null, verified: false };
  }
}
