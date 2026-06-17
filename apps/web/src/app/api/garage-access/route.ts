import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Create a login for a garage (garagiste). ADMIN-only.
 * Body: { garageId, email, password }
 * Creates a confirmed auth user whose metadata links it to the caller's
 * organization + the garage (client_id) with role GARAGISTE (CAISSIER enum
 * value + client_id marker). The handle_new_user trigger writes the profile.
 */
export async function POST(request: Request) {
  try {
    return await handle(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function handle(request: Request) {
  // 1) Authenticate the caller from their session cookie.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  // Read the caller's profile with the admin client (avoids any RLS surprise
  // on the server-side read). Any magasin staff (ADMIN or CAISSIER) may create
  // garage access — only garagistes (client_id set) are refused.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("organization_id, role, client_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile || profile.client_id) {
    return NextResponse.json(
      { error: "Accès refusé (compte non autorisé)." },
      { status: 403 },
    );
  }
  const orgId = profile.organization_id as string;

  // 2) Validate input.
  let body: { garageId?: string; email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const garageId = (body.garageId ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!garageId || !email || password.length < 6) {
    return NextResponse.json(
      { error: "Email et mot de passe (≥ 6 caractères) requis." },
      { status: 400 },
    );
  }

  // 3) The garage must belong to the caller's org (defense in depth).
  const { data: garage } = await admin
    .from("clients")
    .select("id, name, organization_id, is_garage")
    .eq("id", garageId)
    .maybeSingle();
  if (!garage || garage.organization_id !== orgId || !garage.is_garage) {
    return NextResponse.json({ error: "Garage introuvable." }, { status: 404 });
  }

  // 4) Create the confirmed auth user. The trigger creates the profile.
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      organization_id: orgId,
      client_id: garageId,
      role: "CAISSIER",
      display_name: garage.name,
    },
  });

  if (error) {
    const exists = error.message?.toLowerCase().includes("already");
    // Idempotent: if the email already belongs to a garagiste of THIS org,
    // reset its password instead of failing (lets the magasin re-issue creds).
    if (exists) {
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const existing = list?.users?.find(
        (u) => u.email?.toLowerCase() === email,
      );
      if (existing) {
        const { data: ep } = await admin
          .from("profiles")
          .select("organization_id, client_id")
          .eq("user_id", existing.id)
          .maybeSingle();
        // Only reset if it's already a garagiste of this organization.
        if (ep && ep.organization_id === orgId && ep.client_id) {
          await admin.auth.admin.updateUserById(existing.id, {
            password,
            email_confirm: true,
            user_metadata: {
              organization_id: orgId,
              client_id: garageId,
              role: "CAISSIER",
              display_name: garage.name,
            },
          });
          await admin
            .from("profiles")
            .update({ organization_id: orgId, client_id: garageId })
            .eq("user_id", existing.id);
          return NextResponse.json({ ok: true, email, reset: true });
        }
      }
      return NextResponse.json(
        { error: "Cet email est déjà utilisé par un autre compte." },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: error.message ?? "Création impossible." },
      { status: 400 },
    );
  }

  // Belt-and-suspenders: ensure the profile is linked (in case the trigger
  // ran before metadata was applied).
  if (created.user) {
    await admin
      .from("profiles")
      .update({ organization_id: orgId, client_id: garageId })
      .eq("user_id", created.user.id);
  }

  return NextResponse.json({ ok: true, email });
}
