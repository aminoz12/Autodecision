import type { SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

// One client instance per storage key. @supabase/ssr's built-in singleton only
// caches a single client, so a second key (the garagiste store) must opt out of
// it (isSingleton:false) — which would otherwise create a fresh GoTrueClient on
// every call ("Multiple GoTrueClient instances" warning). We cache per key here.
const clientsByKey = new Map<string, SupabaseClient>();

/**
 * Browser Supabase client. An optional `storageKey` gives an independent
 * session store (separate cookies) so a magasin and a garagiste can be logged
 * in at the same time in one browser without overwriting each other.
 */
export function createClient(storageKey?: string): SupabaseClient {
  // No custom key → use @supabase/ssr's default singleton client.
  if (!storageKey) {
    return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey());
  }

  const cached = clientsByKey.get(storageKey);
  if (cached) return cached;

  const client = createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey(), {
    isSingleton: false,
    cookieOptions: { name: storageKey },
  });
  clientsByKey.set(storageKey, client);
  return client;
}

/** Dedicated client for the garagiste portal (separate session store). */
export function createGarageClient(): SupabaseClient {
  return createClient("sb-garagiste-auth");
}
