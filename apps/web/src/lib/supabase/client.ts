import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

/**
 * Browser Supabase client. An optional `storageKey` gives an independent
 * session store (separate cookies) — used so a magasin and a garagiste can be
 * logged in simultaneously in the same browser without overwriting each other.
 */
export function createClient(storageKey?: string) {
  // For a custom session store we must opt OUT of the singleton (otherwise the
  // browser returns the first client and ignores our options) and set the
  // cookie name via cookieOptions.name (which @supabase/ssr maps to the auth
  // storageKey). Without a storageKey, keep the default singleton client.
  return createBrowserClient(
    getSupabaseUrl(),
    getSupabaseAnonKey(),
    storageKey
      ? { isSingleton: false, cookieOptions: { name: storageKey } }
      : undefined,
  );
}

/** Dedicated client for the garagiste portal (separate session store). */
export function createGarageClient() {
  return createClient("sb-garagiste-auth");
}
