/**
 * Shared by the owner console (/superadmin): labels and summaries for the error
 * journal (app_events) and the activity trail (audit_log), and the exports.
 * Pure functions — no Supabase, no browser API — so the API routes, the pages
 * and the tests all use the same code.
 */

export type AppEvent = {
  id: number;
  created_at: string;
  level: "error" | "warn" | "info";
  source: string;
  message: string;
  stack: string | null;
  url: string | null;
  context: Record<string, unknown> | null;
  fingerprint: string;
  organization_id: string | null;
  user_id: string | null;
  user_email: string | null;
  user_role: string | null;
  user_agent: string | null;
  app_version: string | null;
};

export type Activity = {
  id: number;
  created_at: string;
  organization_id: string | null;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

export const LEVEL: Record<AppEvent["level"], { label: string; cls: string }> = {
  error: { label: "Erreur", cls: "red" },
  warn: { label: "Avertissement", cls: "amber" },
  info: { label: "Info", cls: "blue" },
};

export const SOURCE_LABEL: Record<string, string> = {
  render: "Plantage de page",
  client: "Erreur navigateur",
  promise: "Erreur non gérée",
  db: "Base de données",
  schema: "Migration manquante",
  rule: "Action refusée",
  auth: "Connexion",
  api: "Serveur",
  network: "Réseau",
};

export const ACTION: Record<string, { label: string; cls: string }> = {
  INSERT: { label: "Création", cls: "green" },
  UPDATE: { label: "Modification", cls: "blue" },
  DELETE: { label: "Suppression", cls: "red" },
};

export const ENTITY_LABEL: Record<string, string> = {
  orders: "Commande",
  order_lines: "Ligne de commande",
  credit_notes: "Avoir",
  sales_returns: "Retour",
  consignment_entries: "Consigne",
  stock_items: "Stock",
  clients: "Client",
  profiles: "Compte",
  organizations: "Magasin",
  loyalty_transactions: "Fidélité",
  payments: "Règlement",
  payment_allocations: "Affectation de règlement",
  cash_sessions: "Caisse",
  invoices: "Facture",
  sav_cases: "Dossier SAV",
};

/** « Chrome · Windows » from a user-agent string. */
export function browserOf(ua: string | null): string {
  if (!ua) return "—";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navigateur";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

function short(value: unknown): string {
  if (value === null || value === undefined || value === "") return "∅";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** One line telling what changed: the fields of an update, the reference of a creation. */
export function activitySummary(a: Activity): string {
  if (a.action === "UPDATE" && a.after) {
    const keys = Object.keys(a.after);
    const shown = keys.slice(0, 3).map((k) => `${k} : ${short(a.before?.[k])} → ${short(a.after?.[k])}`);
    return shown.join(" · ") + (keys.length > 3 ? ` · +${keys.length - 3}` : "");
  }
  const row = a.after ?? a.before ?? {};
  // A payment has no reference: its amount and mode say what happened.
  if (row.amount != null && row.mode) return `${Number(row.amount).toLocaleString("fr-FR", { minimumFractionDigits: 2 })} € · ${String(row.mode)}`;
  for (const key of ["ref_demande", "ref", "num", "name", "nom_produit", "reference", "display_name"]) {
    if (row[key]) return String(row[key]);
  }
  return a.entity_id ? a.entity_id.slice(0, 8) : "—";
}

/* ------------------------------------------------------------------ */
/*  Grouping                                                            */
/* ------------------------------------------------------------------ */

export type EventGroup = {
  fingerprint: string;
  level: AppEvent["level"];
  source: string;
  message: string;
  count: number;
  first: string;
  last: string;
  users: string[];
  organizations: string[];
  pages: string[];
};

/** The same error raised twenty times is one problem: newest first. */
export function groupEvents(events: AppEvent[]): EventGroup[] {
  const map = new Map<string, EventGroup & { u: Set<string>; o: Set<string>; p: Set<string> }>();
  for (const e of events) {
    let g = map.get(e.fingerprint);
    if (!g) {
      g = { fingerprint: e.fingerprint, level: e.level, source: e.source, message: e.message, count: 0, first: e.created_at, last: e.created_at, users: [], organizations: [], pages: [], u: new Set(), o: new Set(), p: new Set() };
      map.set(e.fingerprint, g);
    }
    g.count += 1;
    if (e.level === "error") g.level = "error";
    if (e.created_at < g.first) g.first = e.created_at;
    if (e.created_at > g.last) {
      g.last = e.created_at;
      g.message = e.message;
    }
    if (e.user_email) g.u.add(e.user_email);
    if (e.organization_id) g.o.add(e.organization_id);
    if (e.url) g.p.add(e.url.split("?")[0]);
  }
  return [...map.values()]
    .map(({ u, o, p, ...g }) => ({ ...g, users: [...u], organizations: [...o], pages: [...p].slice(0, 10) }))
    .sort((a, b) => (a.last < b.last ? 1 : -1));
}

/* ------------------------------------------------------------------ */
/*  Exports                                                             */
/* ------------------------------------------------------------------ */

type Cell = string | number | null | undefined;

/**
 * CSV as French Excel opens it: « ; » separator, CRLF, UTF-8 with BOM. A cell
 * that would start a formula (= + - @) is neutralised with a leading quote.
 */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const cell = (v: Cell): string => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + [headers, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}

export function errorsCsv(events: AppEvent[], orgName: Record<string, string>): string {
  return toCsv(
    ["Date (UTC)", "Niveau", "Type", "Message", "Page", "Utilisateur", "Rôle", "Magasin", "Version", "Navigateur", "Statut HTTP", "Code", "Contexte", "Pile d'appels", "Empreinte"],
    events.map((e) => [
      e.created_at,
      LEVEL[e.level]?.label ?? e.level,
      SOURCE_LABEL[e.source] ?? e.source,
      e.message,
      e.url,
      e.user_email,
      e.user_role,
      e.organization_id ? orgName[e.organization_id] ?? e.organization_id : "",
      e.app_version,
      browserOf(e.user_agent),
      e.context?.status != null ? String(e.context.status) : "",
      e.context?.code != null ? String(e.context.code) : "",
      e.context ? JSON.stringify(e.context) : "",
      e.stack,
      e.fingerprint,
    ]),
  );
}

export function activityCsv(rows: Activity[], orgName: Record<string, string>, actors: Record<string, string>): string {
  return toCsv(
    ["Date (UTC)", "Magasin", "Utilisateur", "Action", "Objet", "Identifiant", "Résumé", "Avant", "Après"],
    rows.map((a) => [
      a.created_at,
      a.organization_id ? orgName[a.organization_id] ?? a.organization_id : "",
      a.actor_id ? actors[a.actor_id] ?? a.actor_id : "Système",
      ACTION[a.action]?.label ?? a.action,
      ENTITY_LABEL[a.entity] ?? a.entity,
      a.entity_id,
      activitySummary(a),
      a.before ? JSON.stringify(a.before) : "",
      a.after ? JSON.stringify(a.after) : "",
    ]),
  );
}

/** The full detail, with the problems grouped first: the file to hand to a developer. */
export function errorsJson(events: AppEvent[], orgName: Record<string, string>, filters: Record<string, string | number | null>): string {
  const name = (id: string | null) => (id ? orgName[id] ?? id : null);
  return JSON.stringify(
    {
      exported_at: new Date().toISOString(),
      filters,
      count: events.length,
      problems: groupEvents(events).map((g) => ({ ...g, organizations: g.organizations.map((id) => orgName[id] ?? id) })),
      events: events.map((e) => ({ ...e, organization: name(e.organization_id), browser: browserOf(e.user_agent) })),
    },
    null,
    2,
  );
}
