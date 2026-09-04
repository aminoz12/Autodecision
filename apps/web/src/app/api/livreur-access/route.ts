import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Create (or reset) a login for a livreur. ADMIN-only.
 * Body: { livreurId, email, password }
 * The confirmed auth user carries app_metadata { organization_id,
 * staff_role: 'LIVREUR', livreur_id } — handle_new_user writes the profile,
 * and RLS scopes the session to the deliveries assigned to that livreur.
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
  if (!livreurId || !email || password.length < 6) {
    return NextResponse.json(
      { error: "Email et mot de passe (≥ 6 caractères) requis." },
      { status: 400 },
    );
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
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: livreur.name },
    app_metadata: appMeta,
  });

  if (error) {
    const exists = error.message?.toLowerCase().includes("already");
    if (exists) {
      // Idempotent reset when the email already belongs to a livreur of THIS org.
      const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const existing = list?.users?.find((u) => u.email?.toLowerCase() === email);
      if (existing) {
        const { data: ep } = await admin
          .from("profiles")
          .select("organization_id, livreur_id")
          .eq("user_id", existing.id)
          .maybeSingle();
        if (ep && ep.organization_id === orgId && ep.livreur_id) {
          await admin.auth.admin.updateUserById(existing.id, {
            password,
            email_confirm: true,
            user_metadata: { display_name: livreur.name },
            app_metadata: appMeta,
          });
          await admin
            .from("profiles")
            .update({ organization_id: orgId, livreur_id: livreurId, role: "LIVREUR", client_id: null })
            .eq("user_id", existing.id);
          return NextResponse.json({ ok: true, email, reset: true });
        }
      }
      return NextResponse.json(
        { error: "Cet email est déjà utilisé par un autre compte." },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: error.message ?? "Création impossible." }, { status: 400 });
  }

  if (created.user) {
    await admin
      .from("profiles")
      .update({ organization_id: orgId, livreur_id: livreurId, role: "LIVREUR", client_id: null })
      .eq("user_id", created.user.id);
  }

  return NextResponse.json({ ok: true, email });
}
