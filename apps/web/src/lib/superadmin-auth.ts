import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { BUILTIN_SUPER_ADMINS } from "@/lib/superadmin";

/** Server-only: who may use the SaaS-owner console (/api/superadmin/*). */

function superAdminEmails(): Set<string> {
  const extra = (process.env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_SUPER_ADMINS, ...extra]);
}

/**
 * The signed-in owner and a service-role client, or the 401/403 response to return.
 * Authority = a row in platform_owners (bound to the user id). The email
 * allowlist only bootstraps: an allowlisted email that signs in is enrolled.
 */
export async function requireSuperAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  const admin = createAdminClient();
  const { data: owner } = await admin
    .from("platform_owners")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!owner) {
    const allowlisted = !!user.email && superAdminEmails().has(user.email.toLowerCase());
    if (!allowlisted) {
      return NextResponse.json(
        { error: "Accès réservé au propriétaire du SaaS." },
        { status: 403 },
      );
    }
    await admin.from("platform_owners").upsert({ user_id: user.id, email: user.email });
  }
  return { admin, email: user.email ?? "" };
}
