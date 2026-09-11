import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Deliberately the deprecated `middleware` convention, NOT Next 16's `proxy`:
// proxy.ts runs on the Node.js runtime, which Netlify's Next adapter cannot
// bundle yet ("Could not load edge function ...node-middleware"). middleware.ts
// keeps the edge runtime — the path Netlify fully supports.

/** Protected space prefix → its login door (which itself stays public). */
const SPACES: Array<{ prefix: string; login: string }> = [
  { prefix: "/dashboard", login: "/caissier/login" },
  { prefix: "/caissier", login: "/caissier/login" },
  { prefix: "/admin", login: "/admin/login" },
  { prefix: "/superadmin", login: "/superadmin/login" },
  { prefix: "/livreur", login: "/livreur/login" },
  { prefix: "/garagiste/dashboard", login: "/garagiste" },
];

/** Public doors inside a protected space (besides each login page). */
const PUBLIC_DOORS = new Set(["/admin/signup"]);

function inSpace(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request);

  const path = request.nextUrl.pathname;

  // The general /login page is gone: every space has its own door.
  if (path === "/login") {
    return NextResponse.redirect(new URL("/caissier/login", request.url));
  }
  if (!user) {
    for (const space of SPACES) {
      if (inSpace(path, space.prefix) && path !== space.login && !PUBLIC_DOORS.has(path)) {
        return NextResponse.redirect(new URL(space.login, request.url));
      }
    }
  }

  // Role gating stays client-side (gates) + database-side (RLS): the session
  // cookie does not carry the role, and a profile lookup per request would
  // double the latency of every navigation.
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
