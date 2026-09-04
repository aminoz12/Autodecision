/* ------------------------------------------------------------------ */
/*  Admin space — client wrappers around the server-only /api/team     */
/*  route (service role). Every call requires an ADMIN session.        */
/* ------------------------------------------------------------------ */

export type StaffMember = {
  userId: string;
  name: string;
  role: "ADMIN" | "CAISSIER" | string;
  email: string | null;
  lastSignIn: string | null;
  createdAt: string;
  isSelf: boolean;
};

export type GarageAccount = {
  userId: string;
  clientId: string;
  garage: string;
  email: string | null;
  lastSignIn: string | null;
};

export type TeamPayload = { staff: StaffMember[]; garageAccounts: GarageAccount[] };

async function call<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch("/api/team", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? "Erreur serveur.");
  return json;
}

export function loadTeam(): Promise<TeamPayload> {
  return call<TeamPayload>("GET");
}

export function createStaffMember(input: {
  name: string;
  email: string;
  password: string;
  role: "ADMIN" | "CAISSIER";
}): Promise<{ ok: true; email: string }> {
  return call("POST", input);
}

export function changeStaffRole(userId: string, role: "ADMIN" | "CAISSIER"): Promise<{ ok: true }> {
  return call("PATCH", { userId, role });
}

export function deleteAccess(userId: string): Promise<{ ok: true }> {
  return call("DELETE", { userId });
}

/** Create (or reset) a garagiste login — existing server route. */
export async function createGarageAccess(input: {
  garageId: string;
  email: string;
  password: string;
}): Promise<{ ok: true; email: string; reset?: boolean }> {
  const res = await fetch("/api/garage-access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const json = (await res.json().catch(() => ({}))) as {
    ok?: true;
    email?: string;
    reset?: boolean;
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? "Erreur serveur.");
  return json as { ok: true; email: string; reset?: boolean };
}

/** A decent one-click password: 3 groups of 4 unambiguous characters. */
export function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const group = () =>
    Array.from(crypto.getRandomValues(new Uint32Array(4)))
      .map((n) => chars[n % chars.length])
      .join("");
  return `${group()}-${group()}-${group()}`;
}
