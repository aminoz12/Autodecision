/**
 * Identity of the deployed build, frozen into a static JSON at build time
 * (`force-static`). An open tab compares it to the value it read at load:
 * when they differ, a newer deploy is live and the tab offers to reload
 * (NewVersionNotice) — without this, a POS tab left open all day keeps
 * running the old bundle.
 */
export const dynamic = "force-static";

const BUILD =
  process.env.COMMIT_REF ?? // Netlify
  process.env.VERCEL_GIT_COMMIT_SHA ?? // Vercel (move prepared, not live)
  (process.env.NODE_ENV === "production" ? String(Date.now()) : "dev");

export function GET() {
  return Response.json({ build: BUILD });
}
