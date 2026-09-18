import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Create (or reset) THE login of a livreur. ADMIN-only.
 * Body: { livreurId, email, password }
 * One login per livreur (unique profiles.livreur_id): when the livreur
 * already has one, it is updated in place — new email if it changed, new
 * password only when one is given — never duplicated, never reset by accident. The confirmed auth user carries
 * app_metadata { organization_id, staff_role: 'LIVREUR', livreur_id };
 * handle_new_user writes the profile, and the livreur_tour() RPC serves the
 * session its deliveries.
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("organization_id, role, client_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile || profile.client_id || profile.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Accès réservé à l'administrateur du magasin." },
      { status: 403 },
    );
  }
  const orgId = profile.organization_id as string;

  let body: { livreurId?: string; email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const livreurId = (body.livreurId ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  if (!livreurId || !email) {
    return NextResponse.json({ error: "Email de connexion requis." }, { status: 400 });
  }
  if (password && password.length < 8) {
    return NextResponse.json({ error: "Mot de passe : 8 caractères minimum." }, { status: 400 });
  }

  const { data: livreur } = await admin
    .from("livreurs")
    .select("id, name, organization_id")
    .eq("id", livreurId)
    .maybeSingle();
  if (!livreur || livreur.organization_id !== orgId) {
    return NextResponse.json({ error: "Livreur introuvable." }, { status: 404 });
  }

  const appMeta = { organization_id: orgId, staff_role: "LIVREUR", livreur_id: livreurId };
  const profileRow = { organization_id: orgId, livreur_id: livreurId, role: "LIVREUR", client_id: null };

  const [{ data: current }, { data: emailOwnerId }] = await Promise.all([
    admin.from("profiles").select("user_id").eq("livreur_id", livreurId).limit(1).maybeSingle(),
    admin.rpc("find_user_id_by_email", { p_email: email }),
  ]);
  const emailOwner = emailOwnerId ? String(emailOwnerId) : null;

  // The livreur already has a login: reset it in place.
  if (current) {
    const currentId = String(current.user_id);
    if (emailOwner && emailOwner !== currentId) {
      return NextResponse.json(
        { error: "Cet email est déjà utilisé par un autre compte." },
        { status: 400 },
      );
    }
    const { error: updateError } = await admin.auth.admin.updateUserById(currentId, {
      email,
      ...(password ? { password } : {}),
      email_confirm: true,
      user_metadata: { display_name: livreur.name },
      app_metadata: appMeta,
    });
    if (updateError) {
      return NextResponse.json({ error: updateError.message ?? "Mise à jour impossible." }, { status: 400 });
    }
    await admin.from("profiles").update(profileRow).eq("user_id", currentId);
    return NextResponse.json({ ok: true, email, reset: true, passwordChanged: Boolean(password) });
  }

  if (!password) {
    return NextResponse.json(
      { error: "Un mot de passe (8 caractères minimum) est requis pour créer l'accès." },
      { status: 400 },
    );
  }

  // Never take over an existing account (another livreur, staff, garage, another magasin).
  if (emailOwner) {
    const { data: owner } = await admin
      .from("profiles")
      .select("organization_id, livreur_id")
      .eq("user_id", emailOwner)
      .maybeSingle();
    const otherLivreur = owner && owner.organization_id === orgId && owner.livreur_id;
    return NextResponse.json(
      {
        error: otherLivreur
          ? "Cet email est déjà l'accès d'un autre livreur du magasin : supprimez cet accès d'abord."
          : "Cet email est déjà utilisé par un autre compte.",
      },
      { status: 400 },
    );
  }

  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: livreur.name },
    app_metadata: appMeta,
  });
  if (error) {
    return NextResponse.json({ error: error.message ?? "Création impossible." }, { status: 400 });
  }

  if (created.user) {
    await admin.from("profiles").update(profileRow).eq("user_id", created.user.id);
  }

  return NextResponse.json({ ok: true, email });
}
