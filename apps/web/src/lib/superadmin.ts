/**
 * Built-in SaaS-owner accounts. The server-side allowlist can be extended
 * with the SUPERADMIN_EMAILS env var (see /api/superadmin); this shared list
 * only exists so the client can route the owner to /superadmin — the API
 * remains the authority on access.
 */
export const BUILTIN_SUPER_ADMINS = ["contact@ematricule.fr"];

export function isBuiltinSuperAdmin(email: string | null | undefined): boolean {
  return !!email && BUILTIN_SUPER_ADMINS.includes(email.toLowerCase());
}
