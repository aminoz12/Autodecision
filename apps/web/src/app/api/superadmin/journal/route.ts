import { NextResponse } from "next/server";
import { requireSuperAdmin } from "@/lib/superadmin-auth";
import { activityCsv, errorsCsv, errorsJson, type Activity, type AppEvent } from "@/lib/superadmin-journal";

/**
 * Journal of the SaaS owner (server-only, service role).
 *   GET    ?tab=errors|activity&days=1|7|30&org=<id>&level=error|warn&q=<text>
 *          → app_events (migration 20261001040000) or audit_log, newest first
 *          &format=csv|json → the same selection as a file to download, in full
 *          detail (up to 5 000 lines instead of what the screen shows)
 *   DELETE ?fingerprint=<md5> | ?all=1  → remove a resolved error / empty the journal
 */

const MISSING = "Le journal des erreurs demande la migration 20261001040000 (npx supabase db push).";
const SCREEN_LIMIT = { errors: 500, activity: 300 };
const EXPORT_LIMIT = 5000;

function isMissing(message: string): boolean {
  return /app_events|PGRST205|42P01|schema cache/i.test(message);
}

/** PostgREST `or` filters break on commas and parentheses: keep plain search text. */
function searchTerm(raw: string | null): string {
  return (raw ?? "").replace(/[,()%*\\]/g, " ").trim().slice(0, 80);
}

function download(body: string, type: string, filename: string): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": `${type}; charset=utf-8`,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  try {
    const ctx = await requireSuperAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin } = ctx;

    const params = new URL(request.url).searchParams;
    const tab = params.get("tab") === "activity" ? "activity" : "errors";
    const days = Math.min(90, Math.max(1, Number(params.get("days")) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const org = params.get("org") || null;
    const q = searchTerm(params.get("q"));
    const format = params.get("format") === "csv" ? "csv" : params.get("format") === "json" ? "json" : null;
    const stamp = new Date().toISOString().slice(0, 10);

    const { data: orgRows } = await admin.from("organizations").select("id, name").order("name", { ascending: true });
    const orgs = (orgRows ?? []).map((o) => ({ id: String(o.id), name: String(o.name ?? "") }));
    const orgName = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

    if (tab === "errors") {
      const level = params.get("level");
      let query = admin
        .from("app_events")
        .select("id, created_at, level, source, message, stack, url, context, fingerprint, organization_id, user_id, user_email, user_role, user_agent, app_version")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(format ? EXPORT_LIMIT : SCREEN_LIMIT.errors);
      if (org) query = query.eq("organization_id", org);
      if (level === "error" || level === "warn") query = query.eq("level", level);
      if (q) query = query.or(`message.ilike.%${q}%,url.ilike.%${q}%,user_email.ilike.%${q}%`);
      const { data, error } = await query;
      if (error) {
        if (isMissing(error.message)) {
          if (format) return NextResponse.json({ error: MISSING }, { status: 503 });
          return NextResponse.json({ tab, orgs, events: [], missing: MISSING });
        }
        throw new Error(error.message);
      }
      const events = (data ?? []) as AppEvent[];
      if (format === "csv") return download(errorsCsv(events, orgName), "text/csv", `erreurs-${stamp}.csv`);
      if (format === "json") {
        const filters = { days, magasin: org ? orgName[org] ?? org : null, level: level || null, search: q || null };
        return download(errorsJson(events, orgName, filters), "application/json", `erreurs-${stamp}.json`);
      }
      return NextResponse.json({ tab, orgs, events, missing: null });
    }

    let query = admin
      .from("audit_log")
      .select("id, created_at, organization_id, actor_id, action, entity, entity_id, before, after")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(format ? EXPORT_LIMIT : SCREEN_LIMIT.activity);
    if (org) query = query.eq("organization_id", org);
    const actor = params.get("actor");
    if (actor) query = query.eq("actor_id", actor);
    if (q) query = query.or(`entity.ilike.%${q}%,entity_id.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const activity = (data ?? []) as Activity[];

    // Who did it: the profile name, else nothing (system jobs have no actor).
    const actorIds = [...new Set(activity.map((r) => r.actor_id).filter(Boolean))] as string[];
    const actors: Record<string, string> = {};
    for (let i = 0; i < actorIds.length; i += 200) {
      const { data: profiles } = await admin.from("profiles").select("user_id, display_name, role, client_id, livreur_id").in("user_id", actorIds.slice(i, i + 200));
      for (const p of profiles ?? []) {
        const role = p.client_id ? "GARAGE" : p.livreur_id ? "LIVREUR" : String(p.role ?? "");
        actors[String(p.user_id)] = `${String(p.display_name ?? "—")} · ${role}`;
      }
    }
    if (format === "csv") return download(activityCsv(activity, orgName, actors), "text/csv", `activite-${stamp}.csv`);
    if (format === "json") {
      const body = JSON.stringify(
        { exported_at: new Date().toISOString(), count: activity.length, activity: activity.map((a) => ({ ...a, organization: a.organization_id ? orgName[a.organization_id] ?? null : null, actor: a.actor_id ? actors[a.actor_id] ?? null : "Système" })) },
        null,
        2,
      );
      return download(body, "application/json", `activite-${stamp}.json`);
    }
    return NextResponse.json({ tab, orgs, activity, actors, missing: null });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Erreur serveur." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireSuperAdmin();
    if (ctx instanceof NextResponse) return ctx;
    const { admin } = ctx;
    const params = new URL(request.url).searchParams;
    const fingerprint = params.get("fingerprint");
    if (fingerprint) {
      const { error } = await admin.from("app_events").delete().eq("fingerprint", fingerprint);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }
    if (params.get("all") === "1") {
      const { error } = await admin.from("app_events").delete().gte("id", 0);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Rien à supprimer." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Erreur serveur." }, { status: 500 });
  }
}
