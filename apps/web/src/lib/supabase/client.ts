import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

/**
 * Browser Supabase client. An optional `storageKey` gives an independent
 * session store (separate cookies) — used so a magasin and a garagiste can be
 * logged in simultaneously in the same browser without overwriting each other.
 */
export function createClient(storageKey?: string) {
  return createBrowserClient(
    getSupabaseUrl(),
    getSupabaseAnonKey(),
    storageKey ? { auth: { storageKey } } : undefined,
  );
}

/** Dedicated client for the garagiste portal (separate session store). */
export function createGarageClient() {
  return createClient("sb-garagiste-auth");
}
