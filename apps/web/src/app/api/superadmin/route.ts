import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/superadmin-auth";

/**
 * SaaS-owner console (server-only, service role).
 * Access: requireSuperAdmin (lib/superadmin-auth.ts) — platform_owners, bootstrapped
 * by the email allowlist (SUPERADMIN_EMAILS env var, comma-separated).
 *   GET  → all organizations with admins, volumes and billing status
 *   POST → { action: suspend | activate | extend_trial | update_org | reset_admin_password |
 *            reset_password | set_account_blocked | create_org, ... }
 * One magasin in detail: /api/superadmin/magasins/[id].
 */

export async function GET() {
  try {
    const ctx = await requireSuperAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin } = ctx;

    const [orgsRes, profilesRes] = await Promise.all([
      admin
        .from("organizations")
        .select("id, name, slug, plan, subscription_status, trial_ends_at, current_period_end, seat_limit, created_at, phone, city, stripe_customer_id, stripe_subscription_id")
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

    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Errors of the last 7 days per magasin (null before migration 20261001040000).
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const errorRows = await admin.from("app_events").select("organization_id").eq("level", "error").gte("created_at", since7).limit(5000);
    const errorsByOrg = new Map<string, number>();
    for (const r of errorRows.data ?? []) {
      const key = String(r.organization_id ?? "");
      errorsByOrg.set(key, (errorsByOrg.get(key) ?? 0) + 1);
    }
    const orgs = await Promise.all(
      (orgsRes.data ?? []).map(async (o) => {
        const orgId = String(o.id);
        const [orders, clients, recent, last, invoices] = await Promise.all([
          admin
            .from("orders")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId)
            .eq("devis", false),
          admin
            .from("clients")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId),
          // Activity over the last 30 days (orders + CA), cancelled excluded.
          admin
            .from("orders")
            .select("montant_total")
            .eq("organization_id", orgId)
            .eq("devis", false)
            .eq("is_restock", false)
            .is("cancelled_at", null)
            .gte("createdAt", since30)
            .limit(5000),
          admin
            .from("orders")
            .select("createdAt")
            .eq("organization_id", orgId)
            .eq("devis", false)
            .order("createdAt", { ascending: false })
            .limit(1),
          admin
            .from("invoices")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", orgId),
        ]);
        const recentRows = (recent.data ?? []) as { montant_total: unknown }[];
        const ca30 = recentRows.reduce((s, r) => s + (Number(r.montant_total) || 0), 0);
        const members = profiles.filter((p) => String(p.organization_id) === orgId);
        return {
          id: orgId,
          name: String(o.name ?? ""),
          slug: (o.slug as string | null) ?? null,
          plan: String(o.plan ?? ""),
          seatLimit: Number(o.seat_limit ?? 0),
          errors7: errorRows.error ? null : errorsByOrg.get(orgId) ?? 0,
          status: String(o.subscription_status ?? ""),
          trialEndsAt: (o.trial_ends_at as string | null) ?? null,
          createdAt: String(o.created_at ?? ""),
          city: (o.city as string | null) ?? null,
          orders: orders.count ?? 0,
          orders30: recentRows.length,
          ca30: Math.round(ca30 * 100) / 100,
          lastOrderAt: ((last.data?.[0] as { createdAt?: string } | undefined)?.createdAt as string | null) ?? null,
          invoices: invoices.count ?? 0,
          currentPeriodEnd: (o.current_period_end as string | null) ?? null,
          stripe: Boolean(o.stripe_subscription_id),
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

    return NextResponse.json({ orgs, errors7: errorRows.error ? null : (errorRows.data ?? []).length });
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
      plan?: string;
      seatLimit?: number;
      status?: string;
      trialEndsAt?: string | null;
      blocked?: boolean;
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

    if (action === "update_org") {
      const orgId = (body.orgId ?? "").trim();
      if (!orgId) return NextResponse.json({ error: "Organisation requise." }, { status: 400 });
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.name !== undefined) {
        const name = body.name.trim();
        if (!name) return NextResponse.json({ error: "Le nom du magasin est requis." }, { status: 400 });
        patch.name = name;
      }
      if (body.plan !== undefined) {
        if (!["TRIAL", "STARTER", "PRO", "ENTERPRISE"].includes(body.plan)) {
          return NextResponse.json({ error: "Plan inconnu." }, { status: 400 });
        }
        patch.plan = body.plan;
      }
      if (body.seatLimit !== undefined) {
        const seats = Math.floor(Number(body.seatLimit));
        if (!Number.isFinite(seats) || seats < 1 || seats > 1000) {
          return NextResponse.json({ error: "Nombre d'accès : entre 1 et 1000." }, { status: 400 });
        }
        patch.seat_limit = seats;
      }
      if (body.status !== undefined) {
        if (!["active", "trialing", "canceled"].includes(body.status)) {
          return NextResponse.json({ error: "Statut inconnu." }, { status: 400 });
        }
        patch.subscription_status = body.status;
      }
      if (body.trialEndsAt !== undefined) {
        if (body.trialEndsAt === null || body.trialEndsAt === "") {
          patch.trial_ends_at = null;
        } else {
          // A day typed in the form means « until the end of that day ».
          const end = new Date(`${body.trialEndsAt.slice(0, 10)}T23:59:59`);
          if (Number.isNaN(end.getTime())) return NextResponse.json({ error: "Date de fin d'essai invalide." }, { status: 400 });
          patch.trial_ends_at = end.toISOString();
        }
      }
      const { error } = await admin.from("organizations").update(patch).eq("id", orgId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }

    // Any login of a magasin (admin, caissier, garage, livreur) — never an owner account.
    if (action === "reset_password" || action === "set_account_blocked") {
      const userId = (body.userId ?? "").trim();
      if (!userId) return NextResponse.json({ error: "Utilisateur requis." }, { status: 400 });
      const { data: prof } = await admin.from("profiles").select("user_id").eq("user_id", userId).maybeSingle();
      if (!prof) return NextResponse.json({ error: "Ce compte n'appartient à aucun magasin." }, { status: 404 });
      if (action === "reset_password") {
        const password = body.password ?? "";
        if (password.length < 8) return NextResponse.json({ error: "Mot de passe : 8 caractères au moins." }, { status: 400 });
        const { error } = await admin.auth.admin.updateUserById(userId, { password });
        if (error) throw new Error(error.message);
        return NextResponse.json({ ok: true });
      }
      // A blocked login can no longer sign in or renew its session; a session
      // already open ends when its token expires (an hour at most).
      const { error } = await admin.auth.admin.updateUserById(userId, { ban_duration: body.blocked ? "876000h" : "none" });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
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
