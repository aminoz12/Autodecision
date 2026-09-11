import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The magasins an owner (ADMIN) can open with one login (server-only, service role).
 *   GET   → magasins the caller is a member of (organization_members)
 *   POST  → create a magasin { name, city?, phone?, copySettings? } owned by the caller
 *   PATCH → switch the session to a magasin { organizationId } the caller is a member of
 *
 * profiles.organization_id is « the magasin currently open »: every RLS rule
 * reads it, so switching is a single update. Caissiers, livreurs and
 * garagistes belong to one magasin and never reach this route.
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

const ORG_COLUMNS = "id, name, city, phone, plan, subscription_status, trial_ends_at, created_at";

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
  return { admin, userId: user.id, orgId: String(profile.organization_id) };
}

function missingTable(message: string | undefined): boolean {
  return /organization_members/.test(message ?? "") && /relation|schema cache|does not exist/i.test(message ?? "");
}

/** Ids of the magasins the user is a member of; null when the migration is not applied. */
async function memberOrgIds(admin: ReturnType<typeof createAdminClient>, userId: string): Promise<string[] | null> {
  const { data, error } = await admin.from("organization_members").select("organization_id").eq("user_id", userId);
  if (error) {
    if (missingTable(error.message)) return null;
    throw new Error(error.message);
  }
  return (data ?? []).map((r) => String((r as { organization_id: unknown }).organization_id));
}

function slugFor(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "magasin"}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function GET() {
  try {
    const ctx = await requireOrgAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, userId, orgId } = ctx;

    const ids = (await memberOrgIds(admin, userId)) ?? [];
    if (!ids.includes(orgId)) ids.push(orgId);
    const { data, error } = await admin
      .from("organizations")
      .select(ORG_COLUMNS)
      .in("id", ids)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    const magasins = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ""),
      city: (r.city as string | null) ?? null,
      phone: (r.phone as string | null) ?? null,
      plan: String(r.plan ?? ""),
      status: String(r.subscription_status ?? ""),
      trialEndsAt: (r.trial_ends_at as string | null) ?? null,
      createdAt: String(r.created_at ?? ""),
      isCurrent: String(r.id) === orgId,
    }));
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
    const { admin, userId, orgId } = ctx;

    let body: { name?: string; city?: string; phone?: string; copySettings?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Corps de requête invalide." }, { status: 400 });
    }
    const name = (body.name ?? "").trim();
    if (!name) return NextResponse.json({ error: "Le nom du magasin est requis." }, { status: 400 });

    // Settings inherited from the magasin currently open (TVA, legal identity…).
    const row: Record<string, unknown> = {
      name,
      slug: slugFor(name),
      plan: "TRIAL",
      subscription_status: "trialing",
      trial_ends_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      city: (body.city ?? "").trim() || null,
      phone: (body.phone ?? "").trim() || null,
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
          if (v != null && v !== "") row[key] = v;
        }
      }
    }
    // Group link (kept for the superadmin console); ignored when the column is absent.
    let created = await admin
      .from("organizations")
      .insert({ ...row, parent_organization_id: orgId })
      .select("id")
      .single();
    if (created.error && /parent_organization_id/.test(created.error.message)) {
      created = await admin.from("organizations").insert(row).select("id").single();
    }
    if (created.error || !created.data) throw new Error(created.error?.message ?? "Création impossible.");
    const newOrgId = String(created.data.id);

    // The owner opens the new magasin with the same login.
    const { error: memberErr } = await admin
      .from("organization_members")
      .upsert({ user_id: userId, organization_id: newOrgId }, { onConflict: "user_id,organization_id" });
    let warning: string | undefined;
    if (memberErr) {
      if (!missingTable(memberErr.message)) throw new Error(memberErr.message);
      warning = "Magasin créé, mais l'accès multi-magasins demande la migration « organization_members ».";
    }

    if (body.copySettings !== false) {
      const { data: suppliers } = await admin
        .from("suppliers")
        .select("name, code, own_delivery, lead_days")
        .eq("organization_id", orgId);
      if (suppliers && suppliers.length > 0) {
        await admin
          .from("suppliers")
          .insert(suppliers.map((s) => ({ ...(s as Record<string, unknown>), organization_id: newOrgId })));
      }
    }

    return NextResponse.json({ ok: true, orgId: newOrgId, warning });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireOrgAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin, userId, orgId } = ctx;

    let body: { organizationId?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Corps de requête invalide." }, { status: 400 });
    }
    const target = (body.organizationId ?? "").trim();
    if (!target) return NextResponse.json({ error: "Magasin requis." }, { status: 400 });
    if (target === orgId) return NextResponse.json({ ok: true, organizationId: orgId });

    const ids = await memberOrgIds(admin, userId);
    if (ids === null) {
      return NextResponse.json(
        { error: "Le changement de magasin demande la migration « organization_members »." },
        { status: 503 },
      );
    }
    if (!ids.includes(target)) {
      return NextResponse.json({ error: "Vous n'êtes pas administrateur de ce magasin." }, { status: 403 });
    }
    const { error } = await admin
      .from("profiles")
      .update({ organization_id: target })
      .eq("user_id", userId)
      .eq("role", "ADMIN")
      .is("client_id", null)
      .is("livreur_id", null);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true, organizationId: target });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur serveur.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
