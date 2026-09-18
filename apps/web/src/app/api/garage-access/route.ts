import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Create (or update) the login of a garage (garagiste). ADMIN-only.
 * Body: { garageId, email, password? }
 * A new login needs a password chosen by the admin; it stays the garage's
 * permanent password (the garagiste can change it from the portal). When the
 * garage already has a login it is updated in place — new email if it
 * changed, new password only when one is given — never duplicated, never
 * reset by accident. The confirmed auth user carries app_metadata
 * { organization_id, client_id }; handle_new_user writes the profile
 * (CAISSIER enum value + client_id marker = garagiste).
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
  // on the server-side read). Only the magasin ADMIN may hand out access.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("organization_id, role, client_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile || profile.client_id || profile.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Accès refusé (compte non autorisé)." },
      { status: 403 },
    );
  }
  const orgId = profile.organization_id as string;

  // 2) Validate input. The password is required to create a login; for an
  // existing one it is optional (empty = the garage keeps its password).
  let body: { garageId?: string; email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const garageId = (body.garageId ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!garageId || !email) {
    return NextResponse.json({ error: "Email de connexion requis." }, { status: 400 });
  }
  if (password && password.length < 8) {
    return NextResponse.json({ error: "Mot de passe : 8 caractères minimum." }, { status: 400 });
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

  const appMeta = { organization_id: orgId, client_id: garageId };
  const profileRow = { organization_id: orgId, client_id: garageId, role: "CAISSIER" };

  // 4) The garage's current login(s), and who owns the requested email.
  const [{ data: logins }, { data: emailOwnerId }] = await Promise.all([
    admin.from("profiles").select("user_id").eq("organization_id", orgId).eq("client_id", garageId),
    admin.rpc("find_user_id_by_email", { p_email: email }),
  ]);
  const emailOwner = emailOwnerId ? String(emailOwnerId) : null;
  const ids = (logins ?? []).map((l) => String(l.user_id));
  const current = ids.find((id) => id === emailOwner) ?? ids[0] ?? null;

  // The garage already has a login: update it in place.
  if (current) {
    if (emailOwner && emailOwner !== current) {
      return NextResponse.json(
        { error: "Cet email est déjà utilisé par un autre compte." },
        { status: 400 },
      );
    }
    const { error: updateError } = await admin.auth.admin.updateUserById(current, {
      email,
      ...(password ? { password } : {}),
      email_confirm: true,
      user_metadata: { display_name: garage.name },
      app_metadata: appMeta,
    });
    if (updateError) {
      return NextResponse.json({ error: updateError.message ?? "Mise à jour impossible." }, { status: 400 });
    }
    await admin.from("profiles").update(profileRow).eq("user_id", current);
    return NextResponse.json({ ok: true, email, reset: true, passwordChanged: Boolean(password) });
  }

  if (!password) {
    return NextResponse.json(
      { error: "Un mot de passe (8 caractères minimum) est requis pour créer l'accès." },
      { status: 400 },
    );
  }

  // Never take over an existing account (another garage, staff, livreur, another magasin).
  if (emailOwner) {
    const { data: owner } = await admin
      .from("profiles")
      .select("organization_id, client_id")
      .eq("user_id", emailOwner)
      .maybeSingle();
    const otherGarage = owner && owner.organization_id === orgId && owner.client_id;
    return NextResponse.json(
      {
        error: otherGarage
          ? "Cet email est déjà l'accès d'un autre garage du magasin : supprimez cet accès d'abord."
          : "Cet email est déjà utilisé par un autre compte.",
      },
      { status: 400 },
    );
  }

  // 5) Create the confirmed auth user. The trigger creates the profile.
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: garage.name },
    app_metadata: appMeta,
  });
  if (error) {
    return NextResponse.json({ error: error.message ?? "Création impossible." }, { status: 400 });
  }

  // Belt-and-suspenders: ensure the profile is linked (in case the trigger
  // ran before metadata was applied).
  if (created.user) {
    await admin.from("profiles").update(profileRow).eq("user_id", created.user.id);
  }

  return NextResponse.json({ ok: true, email });
}
