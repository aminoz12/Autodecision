import type { UserProfile } from "@/lib/types/api";
import { isBuiltinSuperAdmin } from "@/lib/superadmin";

/**
 * The one link each account belongs to:
 *   superadmin → /superadmin   magasin ADMIN → /admin
 *   CAISSIER → /dashboard (alias /caissier)   LIVREUR → /livreur
 *   garagiste → /garagiste
 * Every space guard redirects a foreign account here instead of showing
 * a dead end. (Client-side comfort only — real enforcement is RLS + APIs.)
 */
export function homeSpace(
  profile: Pick<UserProfile, "role" | "client_id"> | null | undefined,
  email?: string | null,
): string {
  if (!profile) return isBuiltinSuperAdmin(email) ? "/superadmin" : "/login";
  if (profile.client_id) return "/garagiste";
  if (profile.role === "LIVREUR") return "/livreur";
  if (profile.role === "ADMIN") return "/admin";
  return "/dashboard";
}
