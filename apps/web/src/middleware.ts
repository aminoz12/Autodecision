import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Deliberately the deprecated `middleware` convention, NOT Next 16's `proxy`:
// proxy.ts runs on the Node.js runtime, which Netlify's Next adapter cannot
// bundle yet ("Could not load edge function ...node-middleware"). middleware.ts
// keeps the edge runtime — the path Netlify fully supports.

/**
 * Protected space prefix → its login door (which itself stays public).
 * `cookie` names the session store of the space when it is not the default one:
 * the garage portal keeps its own, so a garage and a magasin can be signed in
 * side by side in one browser.
 */
const SPACES: Array<{ prefix: string; login: string; cookie?: string }> = [
  { prefix: "/dashboard", login: "/caissier/login" },
  { prefix: "/caissier", login: "/caissier/login" },
  { prefix: "/admin", login: "/admin/login" },
  { prefix: "/superadmin", login: "/superadmin/login" },
  { prefix: "/livreur", login: "/livreur/login" },
  { prefix: "/garagiste/dashboard", login: "/garagiste/login", cookie: "sb-garagiste-auth" },
];

/** Public doors inside a protected space (besides each login page). */
const PUBLIC_DOORS = new Set(["/admin/signup"]);

function inSpace(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * A request the app makes by itself — a link fetched ahead of a click, a
 * navigation inside the app — as opposed to a page being opened. Browsers say
 * which it is (Sec-Fetch-Dest) ; Next hides its own prefetch headers from the
 * middleware. Only a page load is checked here: inside the app, the session is
 * watched by the AuthProvider and the data by the database rules.
 */
function isAppFetch(request: NextRequest): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  return dest !== null && dest !== "document";
}

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // The general /login page is gone: every space has its own door.
  if (path === "/login") {
    return NextResponse.redirect(new URL("/caissier/login", request.url));
  }

  // Only a page of a protected space needs the session: public pages and the
  // login doors never wait on Supabase.
  const space = SPACES.find((s) => inSpace(path, s.prefix));
  if (!space || path === space.login || PUBLIC_DOORS.has(path) || isAppFetch(request)) {
    return NextResponse.next();
  }

  const { response, user, verified } = await updateSession(request, space.cookie);
  // Supabase silent (verified = false): let the page load — its own gate and
  // the database rules still apply — rather than bounce a signed-in user.
  if (verified && !user) {
    return NextResponse.redirect(new URL(space.login, request.url));
  }

  // Role gating stays client-side (gates) + database-side (RLS): the session
  // cookie does not carry the role, and a profile lookup per request would
  // double the latency of every navigation.
  return response;
}

export const config = {
  // Pages only: static files, the service worker and /api (each route checks
  // its own caller) never go through here.
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2|txt)$).*)",
  ],
};
