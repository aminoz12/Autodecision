/**
 * Version of the deployed build, frozen into a static JSON at build time
 * (`force-static`) — the SAME value next.config.js bakes into the client
 * bundle as NEXT_PUBLIC_APP_VERSION. An open tab compares the version it
 * runs to this one (NewVersionNotice) and offers to reload when a newer
 * deploy is live — without this, a POS tab left open all day keeps running
 * the old bundle.
 */
export const dynamic = "force-static";

const BUILD =
  (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || "dev";

export function GET() {
  return Response.json({ build: BUILD });
}
