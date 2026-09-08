import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Liveness + database reachability, for an uptime monitor.
 *   200 { ok: true, db: "up", latencyMs }   — app and database answer
 *   503 { ok: false, db: "down", error }     — database unreachable / misconfigured
 * Never exposes tenant data: it only counts rows with a head request.
 */
export async function GET() {
  const started = Date.now();
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("organizations").select("id", { count: "exact", head: true });
    if (error) throw new Error(error.message);
    return NextResponse.json({
      ok: true,
      db: "up",
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, db: "down", error: e instanceof Error ? e.message : String(e) },
      { status: 503 },
    );
  }
}
