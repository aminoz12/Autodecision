import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// Deliberately the deprecated `middleware` convention, NOT Next 16's `proxy`:
// proxy.ts runs on the Node.js runtime, which Netlify's Next adapter cannot
// bundle yet ("Could not load edge function ...node-middleware"). middleware.ts
// keeps the edge runtime — the path Netlify fully supports.
export async function middleware(request: NextRequest) {
  const { response, user } = await updateSession(request);

  if (request.nextUrl.pathname.startsWith("/dashboard") && !user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
