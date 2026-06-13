/** Reads and normalizes public Supabase env (fail fast if misconfigured). */

export function getSupabaseUrl(): string {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL manquant ou invalide dans apps/web/.env.local (ex: https://<ref>.supabase.co). Redémarrez npm run dev après modification.",
    );
  }
  return url;
}

export function getSupabaseAnonKey(): string {
  const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
  if (!key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY manquant dans apps/web/.env.local. Redémarrez npm run dev après modification.",
    );
  }
  return key;
}
