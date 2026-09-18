import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Team management for the magasin ADMIN (server-only, service role).
 *   GET    → org members (staff with emails) + garage accounts
 *   POST   → create a staff account { name, email, password, role }
 *   PATCH  → change a staff role { userId, role } or set a new password { userId, password }
 *   DELETE → remove an access { userId } (staff or garagiste)
 * Every method requires the caller to be an ADMIN of their organization.
 */

type AdminContext = {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  callerId: string;
};

async function requireAdmin(): Promise<AdminContext | NextResponse> {
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
  return { admin, orgId: profile.organization_id as string, callerId: user.id };
}

/** Map user_id → email for the org members (service role). */
async function emailsByUserId(admin: AdminContext["admin"], userIds: string[]) {
  const map = new Map<string, { email: string | null; lastSignIn: string | null }>();
  await Promise.all(
    userIds.map(async (id) => {
      const { data } = await admin.auth.admin.getUserById(id);
      map.set(id, {
        email: data?.user?.email ?? null,
        lastSignIn: data?.user?.last_sign_in_at ?? null,
      });
    }),
  );
  return map;
}

export async function GET() {
  try {
    const ctx = await requireAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, orgId, callerId } = ctx;

    const { data: profiles, error } = await admin
      .from("profiles")
      .select("user_id, display_name, role, client_id, livreur_id, created_at")
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);

    const rows = profiles ?? [];
    const emails = await emailsByUserId(
      admin,
      rows.map((p) => String(p.user_id)),
    );

    const staff = rows
      .filter((p) => !p.client_id && !p.livreur_id)
      .map((p) => ({
        userId: String(p.user_id),
        name: String(p.display_name ?? ""),
        role: String(p.role),
        email: emails.get(String(p.user_id))?.email ?? null,
        lastSignIn: emails.get(String(p.user_id))?.lastSignIn ?? null,
        createdAt: String(p.created_at ?? ""),
        isSelf: String(p.user_id) === callerId,
      }))
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "ADMIN" ? -1 : 1));

    // Garage logins of this org (client_id set), joined to the garage name.
    const garageProfiles = rows.filter((p) => p.client_id);
    const { data: garages } = await admin
      .from("clients")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("is_garage", true);
    const garageName = new Map((garages ?? []).map((g) => [String(g.id), String(g.name)]));
    const garageAccounts = garageProfiles.map((p) => ({
      userId: String(p.user_id),
      clientId: String(p.client_id),
      garage: garageName.get(String(p.client_id)) ?? "Garage supprimé",
      email: emails.get(String(p.user_id))?.email ?? null,
      lastSignIn: emails.get(String(p.user_id))?.lastSignIn ?? null,
    }));

    // Livreur logins (profiles.livreur_id), joined to the livreur name.
    const { data: livreurs } = await admin
      .from("livreurs")
      .select("id, name")
      .eq("organization_id", orgId);
    const livreurName = new Map((livreurs ?? []).map((l) => [String(l.id), String(l.name)]));
    const livreurAccounts = rows
      .filter((p) => p.livreur_id)
      .map((p) => ({
        userId: String(p.user_id),
        livreurId: String(p.livreur_id),
        livreur: livreurName.get(String(p.livreur_id)) ?? "Livreur supprimé",
        email: emails.get(String(p.user_id))?.email ?? null,
        lastSignIn: emails.get(String(p.user_id))?.lastSignIn ?? null,
      }));

    return NextResponse.json({ staff, garageAccounts, livreurAccounts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, orgId } = ctx;

    let body: { name?: string; email?: string; password?: string; role?: string; invite?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    const role = body.role === "ADMIN" ? "ADMIN" : "CAISSIER";
    const invite = body.invite === true;
    if (!name || !email || (!invite && password.length < 8)) {
      return NextResponse.json(
        { error: invite ? "Nom et email requis." : "Nom, email et mot de passe (≥ 8 caractères) requis." },
        { status: 400 },
      );
    }

    // Seats: the plan's seat_limit counts counter staff (not garagistes / livreurs).
    const [{ data: org }, { count: staffCount }] = await Promise.all([
      admin.from("organizations").select("seat_limit").eq("id", orgId).maybeSingle(),
      admin
        .from("profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("organization_id", orgId)
        .is("client_id", null)
        .is("livreur_id", null),
    ]);
    const seatLimit = Number(org?.seat_limit ?? 0);
    if (seatLimit > 0 && (staffCount ?? 0) >= seatLimit) {
      return NextResponse.json(
        {
          error: `Limite de ${seatLimit} accès atteinte pour votre abonnement. Supprimez un accès ou passez à un plan supérieur.`,
        },
        { status: 400 },
      );
    }

    if (invite) {
      // Invitation email: the user picks their own password on the landing
      // page. handle_new_user provisions the profile when app_metadata lands.
      const origin = new URL(request.url).origin;
      const { data: invited, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { display_name: name },
        redirectTo: `${origin}/auth/callback?next=/reinitialiser-mot-de-passe`,
      });
      if (invErr || !invited.user) {
        const exists = invErr?.message?.toLowerCase().includes("already");
        return NextResponse.json(
          { error: exists ? "Cet email est déjà utilisé par un autre compte." : (invErr?.message ?? "Invitation impossible.") },
          { status: 400 },
        );
      }
      const { error: metaErr } = await admin.auth.admin.updateUserById(invited.user.id, {
        app_metadata: { organization_id: orgId, staff_role: role },
      });
      if (metaErr) {
        return NextResponse.json({ error: metaErr.message }, { status: 500 });
      }
      await admin
        .from("profiles")
        .upsert(
          { user_id: invited.user.id, organization_id: orgId, role, display_name: name, client_id: null, livreur_id: null },
          { onConflict: "user_id" },
        );
      return NextResponse.json({ ok: true, email, invited: true });
    }

    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: name },
      // Trusted server-side path: handle_new_user reads staff_role and
      // attaches the profile to the caller's organization with that role.
      app_metadata: { organization_id: orgId, staff_role: role },
    });
    if (error) {
      const exists = error.message?.toLowerCase().includes("already");
      return NextResponse.json(
        { error: exists ? "Cet email est déjà utilisé par un autre compte." : error.message },
        { status: 400 },
      );
    }

    // Belt-and-suspenders (trigger ordering).
    if (created.user) {
      await admin
        .from("profiles")
        .update({ organization_id: orgId, role, display_name: name, client_id: null })
        .eq("user_id", created.user.id);
    }
    return NextResponse.json({ ok: true, email });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** The org must always keep at least one ADMIN. */
async function adminCount(admin: AdminContext["admin"], orgId: string) {
  const { count } = await admin
    .from("profiles")
    .select("user_id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("role", "ADMIN")
    .is("client_id", null);
  return count ?? 0;
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, orgId, callerId } = ctx;

    let body: { userId?: string; role?: string; password?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const userId = (body.userId ?? "").trim();
    const role = body.role === "ADMIN" ? "ADMIN" : body.role === "CAISSIER" ? "CAISSIER" : null;
    const password = typeof body.password === "string" ? body.password : null;
    if (!userId || (!role && password === null)) {
      return NextResponse.json({ error: "Utilisateur et rôle ou mot de passe requis." }, { status: 400 });
    }
    if (password !== null && password.length < 8) {
      return NextResponse.json({ error: "Mot de passe : 8 caractères minimum." }, { status: 400 });
    }

    const { data: target } = await admin
      .from("profiles")
      .select("user_id, organization_id, role, client_id, livreur_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!target || target.organization_id !== orgId || target.client_id || target.livreur_id) {
      return NextResponse.json({ error: "Membre introuvable." }, { status: 404 });
    }

    // A permanent password chosen by the admin (the member forgot theirs):
    // the old one stops working at once; the member can change it later
    // from their own space.
    if (password !== null) {
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ ok: true });
    }
    if (!role) {
      return NextResponse.json({ error: "Rôle requis." }, { status: 400 });
    }
    if (userId === callerId && role !== "ADMIN") {
      return NextResponse.json(
        { error: "Vous ne pouvez pas retirer votre propre rôle d'administrateur." },
        { status: 400 },
      );
    }
    if (target.role === "ADMIN" && role !== "ADMIN" && (await adminCount(admin, orgId)) <= 1) {
      return NextResponse.json(
        { error: "Le magasin doit garder au moins un administrateur." },
        { status: 400 },
      );
    }

    const { error } = await admin
      .from("profiles")
      .update({ role, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, orgId, callerId } = ctx;

    let body: { userId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }
    const userId = (body.userId ?? "").trim();
    if (!userId) {
      return NextResponse.json({ error: "Utilisateur requis." }, { status: 400 });
    }
    if (userId === callerId) {
      return NextResponse.json(
        { error: "Vous ne pouvez pas supprimer votre propre compte." },
        { status: 400 },
      );
    }

    const { data: target } = await admin
      .from("profiles")
      .select("user_id, organization_id, role, client_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!target || target.organization_id !== orgId) {
      return NextResponse.json({ error: "Compte introuvable." }, { status: 404 });
    }
    if (!target.client_id && target.role === "ADMIN" && (await adminCount(admin, orgId)) <= 1) {
      return NextResponse.json(
        { error: "Le magasin doit garder au moins un administrateur." },
        { status: 400 },
      );
    }

    // profiles.user_id cascades from auth.users.
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
