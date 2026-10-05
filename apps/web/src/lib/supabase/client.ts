import type { SupabaseClient } from "@supabase/supabase-js";
import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

// One client instance per storage key. @supabase/ssr's built-in singleton only
// caches a single client, so a second key (the garagiste store) must opt out of
// it (isSingleton:false) — which would otherwise create a fresh GoTrueClient on
// every call ("Multiple GoTrueClient instances" warning). We cache per key here.
const clientsByKey = new Map<string, SupabaseClient>();

/**
 * Tablette « Suivi des commandes »: the cashier who typed their code. Sent as
 * x-actor-token on database requests so the actions are recorded in their name
 * (current_actor_id(), migration 20261005020000). null = the signed-in account.
 */
let actorToken: string | null = null;

export function setActorToken(token: string | null) {
  actorToken = token;
}

/** Only the REST API reads the token; auth and storage never see the header. */
const actorFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!actorToken || !url.includes("/rest/v1/")) return fetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set("x-actor-token", actorToken);
  return fetch(input, { ...init, headers });
};

/**
 * Browser Supabase client. An optional `storageKey` gives an independent
 * session store (separate cookies) so a magasin and a garagiste can be logged
 * in at the same time in one browser without overwriting each other.
 */
export function createClient(storageKey?: string): SupabaseClient {
  // No custom key → use @supabase/ssr's default singleton client.
  if (!storageKey) {
    return createBrowserClient(getSupabaseUrl(), getSupabaseAnonKey(), { global: { fetch: actorFetch } });
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
