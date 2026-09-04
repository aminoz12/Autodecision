import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUILTIN_SUPER_ADMINS } from "@/lib/superadmin";

/**
 * SaaS-owner console (server-only, service role).
 * Access: the signed-in user's email must be in the allowlist below
 * (extend with the SUPERADMIN_EMAILS env var, comma-separated).
 *   GET  → all organizations with admins, volumes and billing status
 *   POST → { action: suspend | activate | extend_trial | reset_admin_password | create_org, ... }
 */

function superAdminEmails(): Set<string> {
  const extra = (process.env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...BUILTIN_SUPER_ADMINS, ...extra]);
}

async function requireSuperAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  }
  if (!user.email || !superAdminEmails().has(user.email.toLowerCase())) {
    return NextResponse.json(
      { error: "Accès réservé au propriétaire du SaaS." },
      { status: 403 },
    );
  }
  return { admin: createAdminClient(), email: user.email };
}

export async function GET() {
  try {
    const ctx = await requireSuperAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin } = ctx;

    const [orgsRes, profilesRes] = await Promise.all([
      admin
        .from("organizations")
        .select("id, name, slug, plan, subscription_status, trial_ends_at, created_at, phone, city")
        .order("created_at", { ascending: true }),
      admin
        .from("profiles")
        .select("user_id, organization_id, display_name, role, client_id, livreur_id"),
    ]);
    if (orgsRes.error) throw new Error(orgsRes.error.message);
    if (profilesRes.error) throw new Error(profilesRes.error.message);

    const profiles = profilesRes.data ?? [];
    const adminProfiles = profiles.filter((p) => p.role === "ADMIN" && !p.client_id && !p.livreur_id);
    const emailById = new Map<string, { email: string | null; lastSignIn: string | null }>();
    await Promise.all(
      adminProfiles.map(async (p) => {
        const { data } = await admin.auth.admin.getUserById(String(p.user_id));
        emailById.set(String(p.user_id), {
          email: data?.user?.email ?? null,
          lastSignIn: data?.user?.last_sign_in_at ?? null,
        });
      }),
    );

    const orgs = await Promise.all(
      (orgsRes.data ?? []).map(async (o) => {
        const orgId = String(o.id);
        const [orders, clients] = await Promise.all([
          admin
            .from("orders")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId)
            .eq("devis", false),
          admin
            .from("clients")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId),
        ]);
        const members = profiles.filter((p) => String(p.organization_id) === orgId);
        return {
          id: orgId,
          name: String(o.name ?? ""),
          slug: (o.slug as string | null) ?? null,
          plan: String(o.plan ?? ""),
          status: String(o.subscription_status ?? ""),
          trialEndsAt: (o.trial_ends_at as string | null) ?? null,
          createdAt: String(o.created_at ?? ""),
          city: (o.city as string | null) ?? null,
          orders: orders.count ?? 0,
          clients: clients.count ?? 0,
          staff: members.filter((p) => !p.client_id && !p.livreur_id).length,
          garages: members.filter((p) => p.client_id).length,
          livreurs: members.filter((p) => p.livreur_id).length,
          admins: members
            .filter((p) => p.role === "ADMIN" && !p.client_id && !p.livreur_id)
            .map((p) => ({
              userId: String(p.user_id),
              name: String(p.display_name ?? ""),
              email: emailById.get(String(p.user_id))?.email ?? null,
              lastSignIn: emailById.get(String(p.user_id))?.lastSignIn ?? null,
            })),
        };
      }),
    );

    return NextResponse.json({ orgs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireSuperAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin } = ctx;

    let body: {
      action?: string;
      orgId?: string;
      days?: number;
      userId?: string;
      password?: string;
      name?: string;
      adminName?: string;
      email?: string;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
    }

    const action = body.action ?? "";

    if (action === "suspend" || action === "activate") {
      const orgId = (body.orgId ?? "").trim();
      if (!orgId) return NextResponse.json({ error: "Organisation requise." }, { status: 400 });
      const { error } = await admin
        .from("organizations")
        .update({
          subscription_status: action === "suspend" ? "canceled" : "active",
          updated_at: new Date().toISOString(),
        })
        .eq("id", orgId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    if (action === "extend_trial") {
      const orgId = (body.orgId ?? "").trim();
      const days = Math.min(365, Math.max(1, Math.floor(body.days ?? 14)));
      if (!orgId) return NextResponse.json({ error: "Organisation requise." }, { status: 400 });
      const ends = new Date(Date.now() + days * 86_400_000).toISOString();
      const { error } = await admin
        .from("organizations")
        .update({ subscription_status: "trialing", trial_ends_at: ends, updated_at: new Date().toISOString() })
        .eq("id", orgId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, trialEndsAt: ends });
    }

    if (action === "reset_admin_password") {
      const userId = (body.userId ?? "").trim();
      const password = body.password ?? "";
      if (!userId || password.length < 6) {
        return NextResponse.json({ error: "Utilisateur et mot de passe (≥ 6) requis." }, { status: 400 });
      }
      const { data: prof } = await admin
        .from("profiles")
        .select("user_id, role, client_id, livreur_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (!prof || prof.role !== "ADMIN" || prof.client_id || prof.livreur_id) {
        return NextResponse.json({ error: "Cet utilisateur n'est pas un administrateur de magasin." }, { status: 404 });
      }
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    if (action === "create_org") {
      const name = (body.name ?? "").trim();
      const adminName = (body.adminName ?? "").trim();
      const email = (body.email ?? "").trim().toLowerCase();
      const password = body.password ?? "";
      if (!name || !adminName || !email || password.length < 6) {
        return NextResponse.json(
          { error: "Nom du magasin, nom de l'admin, email et mot de passe (≥ 6) requis." },
          { status: 400 },
        );
      }
      // The signup trigger creates the organization (TRIAL 14 j) + ADMIN profile.
      const { error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { organization_name: name, display_name: adminName },
      });
      if (error) {
        const exists = error.message?.toLowerCase().includes("already");
        return NextResponse.json(
          { error: exists ? "Cet email est déjà utilisé." : error.message },
          { status: 400 },
        );
      }
      return NextResponse.json({ ok: true, email });
    }

    return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
