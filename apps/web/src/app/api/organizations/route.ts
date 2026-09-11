import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Magasins of the caller's group (server-only, service role).
 *   GET  → every magasin sharing the caller's root organization
 *   POST → create a new magasin { name, city?, phone?, adminName, email, password, copySettings? }
 *
 * A magasin created here gets its own organization (own trial, own team,
 * own data) with parent_organization_id = the caller's root, so the owner
 * sees all their magasins from /admin. Only an ADMIN of a magasin can call.
 */

const SETTINGS_TO_COPY = [
  "tva_rate",
  "legal_name",
  "legal_form",
  "siret",
  "tva_intra",
  "rcs",
  "capital",
  "iban",
  "bic",
  "invoice_footer",
  "payment_terms_text",
  "sms_sender",
] as const;

async function requireOrgAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("organization_id, role, client_id, livreur_id, display_name")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!profile?.organization_id || profile.role !== "ADMIN" || profile.client_id || profile.livreur_id) {
    return NextResponse.json({ error: "Réservé à l'administrateur du magasin." }, { status: 403 });
  }
  const orgId = String(profile.organization_id);
  const { data: org } = await admin
    .from("organizations")
    .select("id, name, parent_organization_id")
    .eq("id", orgId)
    .maybeSingle();
  const rootId = String((org?.parent_organization_id as string | null) ?? orgId);
  return { admin, user, orgId, rootId, displayName: String(profile.display_name ?? "") };
}

function isMissingColumn(message: string | undefined): boolean {
  return /parent_organization_id/.test(message ?? "") && /column|schema cache/i.test(message ?? "");
}

export async function GET() {
  try {
    const ctx = await requireOrgAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, orgId, rootId } = ctx;

    let rows: Record<string, unknown>[] = [];
    const grouped = await admin
      .from("organizations")
      .select("id, name, city, phone, plan, subscription_status, trial_ends_at, created_at, parent_organization_id")
      .or(`id.eq.${rootId},parent_organization_id.eq.${rootId}`)
      .order("created_at", { ascending: true });
    if (grouped.error) {
      if (!isMissingColumn(grouped.error.message)) throw new Error(grouped.error.message);
      // Migration not applied yet: only the caller's own magasin is known.
      const own = await admin
        .from("organizations")
        .select("id, name, city, phone, plan, subscription_status, trial_ends_at, created_at")
        .eq("id", orgId);
      if (own.error) throw new Error(own.error.message);
      rows = (own.data ?? []) as Record<string, unknown>[];
    } else {
      rows = (grouped.data ?? []) as Record<string, unknown>[];
    }

    const ids = rows.map((r) => String(r.id));
    const { data: admins } = await admin
      .from("profiles")
      .select("user_id, organization_id, display_name, role, client_id, livreur_id")
      .in("organization_id", ids)
      .eq("role", "ADMIN")
      .is("client_id", null)
      .is("livreur_id", null);
    const adminRows = (admins ?? []) as Record<string, unknown>[];
    const emails = new Map<string, string | null>();
    await Promise.all(
      adminRows.map(async (p) => {
        const { data } = await admin.auth.admin.getUserById(String(p.user_id));
        emails.set(String(p.user_id), data?.user?.email ?? null);
      }),
    );

    const magasins = rows.map((r) => {
      const id = String(r.id);
      return {
        id,
        name: String(r.name ?? ""),
        city: (r.city as string | null) ?? null,
        phone: (r.phone as string | null) ?? null,
        plan: String(r.plan ?? ""),
        status: String(r.subscription_status ?? ""),
        trialEndsAt: (r.trial_ends_at as string | null) ?? null,
        createdAt: String(r.created_at ?? ""),
        isCurrent: id === orgId,
        isRoot: id === rootId,
        admins: adminRows
          .filter((p) => String(p.organization_id) === id)
          .map((p) => ({ name: String(p.display_name ?? ""), email: emails.get(String(p.user_id)) ?? null })),
      };
    });
    return NextResponse.json({ magasins });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireOrgAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, orgId, rootId } = ctx;

    let body: {
      name?: string;
      city?: string;
      phone?: string;
      adminName?: string;
      email?: string;
      password?: string;
      copySettings?: boolean;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Corps de requête invalide." }, { status: 400 });
    }
    const name = (body.name ?? "").trim();
    const adminName = (body.adminName ?? "").trim();
    const email = (body.email ?? "").trim().toLowerCase();
    const password = body.password ?? "";
    if (!name || !adminName || !email || password.length < 8) {
      return NextResponse.json(
        { error: "Nom du magasin, nom de l'administrateur, email et mot de passe (≥ 8 caractères) requis." },
        { status: 400 },
      );
    }

    // The signup trigger creates the organization (trial 14 j) + its ADMIN profile.
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { organization_name: name, display_name: adminName },
    });
    if (createErr || !created.user) {
      const exists = createErr?.message?.toLowerCase().includes("already");
      return NextResponse.json(
        { error: exists ? "Cet email est déjà utilisé : choisissez un autre email pour l'administrateur du nouveau magasin." : createErr?.message ?? "Création impossible." },
        { status: 400 },
      );
    }

    // The profile can land a moment after the insert (metadata update): retry briefly.
    let newOrgId: string | null = null;
    for (let i = 0; i < 6 && !newOrgId; i += 1) {
      const { data: prof } = await admin
        .from("profiles")
        .select("organization_id")
        .eq("user_id", created.user.id)
        .maybeSingle();
      newOrgId = prof?.organization_id ? String(prof.organization_id) : null;
      if (!newOrgId) await new Promise((r) => setTimeout(r, 300));
    }
    if (!newOrgId) {
      return NextResponse.json(
        { ok: true, email, warning: "Compte créé, mais le magasin n'a pas encore été rattaché : rechargez dans quelques secondes." },
      );
    }

    // Link to the group and copy the owner's settings / suppliers.
    const patch: Record<string, unknown> = {
      city: (body.city ?? "").trim() || null,
      phone: (body.phone ?? "").trim() || null,
      updated_at: new Date().toISOString(),
    };
    if (body.copySettings !== false) {
      const { data: source } = await admin
        .from("organizations")
        .select(SETTINGS_TO_COPY.join(","))
        .eq("id", orgId)
        .maybeSingle();
      if (source) {
        for (const key of SETTINGS_TO_COPY) {
          const v = (source as unknown as Record<string, unknown>)[key];
          if (v != null && v !== "") patch[key] = v;
        }
      }
    }
    let linked = true;
    const withParent = await admin
      .from("organizations")
      .update({ ...patch, parent_organization_id: rootId })
      .eq("id", newOrgId);
    if (withParent.error) {
      if (!isMissingColumn(withParent.error.message)) throw new Error(withParent.error.message);
      linked = false;
      const { error } = await admin.from("organizations").update(patch).eq("id", newOrgId);
      if (error) throw new Error(error.message);
    }

    if (body.copySettings !== false) {
      const { data: suppliers } = await admin
        .from("suppliers")
        .select("name, code, own_delivery, lead_days")
        .eq("organization_id", orgId);
      if (suppliers && suppliers.length > 0) {
        await admin.from("suppliers").insert(
          suppliers.map((s) => ({ ...(s as Record<string, unknown>), organization_id: newOrgId })),
        );
      }
    }

    return NextResponse.json({
      ok: true,
      orgId: newOrgId,
      email,
      warning: linked ? undefined : "Magasin créé, mais non rattaché au groupe : appliquez la migration « organization_groups ».",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
