import { createClient } from "@supabase/supabase-js";
import { getSupabaseUrl } from "./env";

/**
 * Server-only Supabase client with the service-role key. NEVER import this
 * from client components — it bypasses RLS. The key must be set as
 * SUPABASE_SERVICE_ROLE_KEY (no NEXT_PUBLIC prefix) so it stays server-side.
 */
export function createAdminClient() {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY manquant (variable serveur). Ajoutez-la dans apps/web/.env.local (sans NEXT_PUBLIC) et dans Vercel.",
    );
  }
  return createClient(getSupabaseUrl(), key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
