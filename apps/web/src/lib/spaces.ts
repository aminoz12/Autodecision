import type { UserProfile } from "@/lib/types/api";
import { isBuiltinSuperAdmin } from "@/lib/superadmin";

/**
 * One link per space, one space per account:
 *   superadmin → /superadmin   magasin ADMIN → /admin
 *   CAISSIER → /dashboard (alias /caissier)   LIVREUR → /livreur
 *   garagiste → /garagiste
 * Each space has its OWN login page and only accepts its own accounts —
 * signing in on the wrong door is refused, never redirected.
 * (Client-side comfort only — real enforcement is RLS + APIs.)
 */
export type SpaceKey = "superadmin" | "admin" | "caissier" | "livreur";
export type AccountSpace = SpaceKey | "garagiste";

export const SPACE_HOME: Record<SpaceKey, string> = {
  superadmin: "/superadmin",
  admin: "/admin",
  caissier: "/dashboard",
  livreur: "/livreur",
};

export const SPACE_LOGIN: Record<AccountSpace, string> = {
  superadmin: "/superadmin/login",
  admin: "/admin/login",
  caissier: "/caissier/login",
  livreur: "/livreur/login",
  garagiste: "/garagiste",
};

type ProfileLike = Pick<UserProfile, "role" | "client_id"> | null | undefined;

/** The space an account belongs to, or null when it has no profile at all. */
export function accountSpace(
  profile: ProfileLike,
  email?: string | null,
): AccountSpace | null {
  if (!profile) return isBuiltinSuperAdmin(email) ? "superadmin" : null;
  if (profile.client_id) return "garagiste";
  if (profile.role === "LIVREUR") return "livreur";
  if (profile.role === "ADMIN") return "admin";
  return "caissier";
}

/** Where an account lives. A profile-less account is sent to the counter door. */
export function homeSpace(profile: ProfileLike, email?: string | null): string {
  const space = accountSpace(profile, email);
  if (!space) return SPACE_LOGIN.caissier;
  return space === "garagiste" ? "/garagiste" : SPACE_HOME[space];
}

/** The login page of an account's space — where to land after logout. */
export function loginFor(profile: ProfileLike, email?: string | null): string {
  return SPACE_LOGIN[accountSpace(profile, email) ?? "caissier"];
}
