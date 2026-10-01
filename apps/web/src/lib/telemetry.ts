import { createClient, createGarageClient } from "@/lib/supabase/client";

/**
 * Journal technique : chaque erreur vue dans le navigateur est envoyée à
 * log_app_event() (migration 20261001040000) et lue dans /superadmin/journal.
 * Rien ici ne doit jamais casser l'application : tout est silencieux.
 */

export type EventLevel = "error" | "warn" | "info";

export type AppEventInput = {
  level?: EventLevel;
  /** render | client | promise | db | schema | rule | auth | api | network */
  source: string;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown> | null;
};

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

const LOG_RPC = "log_app_event";
/** The same event is sent at most once every 10 s, and a page load sends at most 40. */
const REPEAT_MS = 10_000;
const MAX_PER_LOAD = 40;
const lastSent = new Map<string, number>();
let sentCount = 0;

export function reportEvent(input: AppEventInput): void {
  if (typeof window === "undefined") return;
  try {
    const message = (input.message || "(sans message)").slice(0, 2000);
    const key = `${input.source}:${message}`.slice(0, 300);
    const now = Date.now();
    if ((lastSent.get(key) ?? 0) > now - REPEAT_MS || sentCount >= MAX_PER_LOAD) return;
    lastSent.set(key, now);
    sentCount += 1;
    // The garage portal keeps its own session: the event carries the right user.
    const client = window.location.pathname.startsWith("/garagiste") ? createGarageClient() : createClient();
    void client
      .rpc(LOG_RPC, {
        p_level: input.level ?? "error",
        p_source: input.source,
        p_message: message,
        p_stack: input.stack ? input.stack.slice(0, 8000) : null,
        p_url: (window.location.pathname + window.location.search).slice(0, 500),
        p_context: input.context ?? null,
        p_user_agent: navigator.userAgent,
        p_app_version: APP_VERSION,
      })
      .then(
        () => {},
        () => {},
      );
  } catch {
    // Never let the reporter become the error.
  }
}

/** Report anything thrown (Error or not). */
export function reportError(source: string, error: unknown, context?: Record<string, unknown> | null): void {
  const e = error instanceof Error ? error : null;
  reportEvent({ source, message: e ? e.message : String(error), stack: e?.stack ?? null, context });
}

/* ------------------------------------------------------------------ */
/*  Failed requests                                                     */
/* ------------------------------------------------------------------ */

export type FailureClass = { level: EventLevel; source: string };

/**
 * How a failed request is filed. `code` is PostgREST's error code:
 *   42703 / 42P01 / 42883 / PGRST2xx → the database lacks a column, table or
 *   function the app expects (a migration is missing) → « schema » ;
 *   P0001 → a business rule refused the action (raise exception) → « rule ».
 */
export function classifyFailure(kind: "supabase" | "api", path: string, status: number, code: string | null): FailureClass {
  if (kind === "api") return { level: status >= 500 ? "error" : "warn", source: "api" };
  if (path.startsWith("/auth/")) return { level: status >= 500 ? "error" : "warn", source: "auth" };
  if (status >= 500) return { level: "error", source: "db" };
  if (code && (/^(42703|42P01|42883)$/.test(code) || /^PGRST2\d\d$/.test(code))) return { level: "warn", source: "schema" };
  if (code === "P0001") return { level: "warn", source: "rule" };
  if (code === "PGRST116" || status === 401) return { level: "warn", source: "db" };
  return { level: "error", source: "db" };
}

/** RPC arguments are kept for diagnosis, without anything that looks like a secret. */
export function redactBody(body: string): string {
  return body
    .replace(/("[^"]*(?:password|passwd|secret|token|mot_de_passe)[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"')
    .slice(0, 800);
}

type Watched = { kind: "supabase" | "api"; method: string; path: string; query: string };

function watched(input: RequestInfo | URL, init: RequestInit | undefined, supabaseOrigin: string | null): Watched | null {
  try {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (supabaseOrigin && url.origin === supabaseOrigin) {
      if (url.pathname.endsWith(`/rpc/${LOG_RPC}`)) return null;
      return { kind: "supabase", method, path: url.pathname.replace(/^\/rest\/v1/, ""), query: url.search.slice(0, 500) };
    }
    if (url.origin === window.location.origin && url.pathname.startsWith("/api/")) {
      return { kind: "api", method, path: url.pathname, query: url.search.slice(0, 300) };
    }
  } catch {
    // Unparseable URL: not ours.
  }
  return null;
}

async function reportFailedResponse(w: Watched, res: Response, init: RequestInit | undefined, ms: number): Promise<void> {
  try {
    const text = (await res.text()).slice(0, 1500);
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    const code = typeof json?.code === "string" ? json.code : null;
    const detail = String(json?.message ?? json?.error_description ?? json?.error ?? json?.msg ?? text ?? "").slice(0, 600);
    const { level, source } = classifyFailure(w.kind, w.path, res.status, code);
    const context: Record<string, unknown> = { status: res.status, method: w.method, ms };
    if (code) context.code = code;
    if (json?.details) context.details = String(json.details).slice(0, 400);
    if (json?.hint) context.hint = String(json.hint).slice(0, 300);
    if (w.query) context.query = w.query;
    // Arguments of a database function only — never the body of /api or /auth calls (passwords).
    if (w.kind === "supabase" && w.path.startsWith("/rpc/") && typeof init?.body === "string") {
      context.args = redactBody(init.body);
    }
    reportEvent({ level, source, message: `${w.method} ${w.path} → ${res.status}${detail ? ` ${detail}` : ""}`, context });
  } catch {
    // Reading the copy failed: nothing to report.
  }
}

type PatchedWindow = Window & { __fetchReporter?: boolean };

/** Watch every call to the database and to /api: a failed one is filed in the journal. */
export function installFetchReporter(): void {
  if (typeof window === "undefined") return;
  const w = window as PatchedWindow;
  if (w.__fetchReporter) return;
  w.__fetchReporter = true;
  let supabaseOrigin: string | null = null;
  try {
    supabaseOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
  } catch {
    supabaseOrigin = null;
  }
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = watched(input, init, supabaseOrigin);
    if (!target) return original(input, init);
    const started = Date.now();
    try {
      const res = await original(input, init);
      if (!res.ok) void reportFailedResponse(target, res.clone(), init, Date.now() - started);
      return res;
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      // Offline (the livreur page works without network) is not an error to file.
      if (!aborted && navigator.onLine) {
        reportEvent({
          source: "network",
          message: `${target.method} ${target.path} — ${e instanceof Error ? e.message : String(e)}`,
          context: { ms: Date.now() - started },
        });
      }
      throw e;
    }
  };
}
