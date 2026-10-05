import type { SupabaseClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ */
/*  Tablette « Suivi des commandes » — codes à 4 chiffres et « qui     */
/*  pointe » (migration 20261005020000).                               */
/* ------------------------------------------------------------------ */

export type StaffEntry = {
  userId: string;
  name: string;
  /** ADMIN / CAISSIER / LIVREUR. */
  role: string;
  /** A tablet code is set: the person can be chosen on the tablet. */
  hasPin: boolean;
};

const MIGRATION = "La tablette demande la migration 20261005020000 (npx supabase db push).";

function needsMigration(message: string, fn: string): boolean {
  return new RegExp(`${fn}|schema cache`, "i").test(message);
}

/** Everyone of the magasin (garagistes excepted): names for « pointé par », and who can point on the tablet. */
export async function loadStaff(supabase: SupabaseClient): Promise<StaffEntry[]> {
  const { data, error } = await supabase.rpc("tablet_staff");
  if (error) throw new Error(needsMigration(error.message, "tablet_staff") ? MIGRATION : error.message);
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    userId: String(r.user_id),
    name: String(r.name ?? ""),
    role: String(r.role ?? ""),
    hasPin: r.has_pin === true,
  }));
}

/** Names by user id, for « Pointé par … ». Empty when the database is not ready. */
export async function loadStaffNames(supabase: SupabaseClient): Promise<Map<string, string>> {
  try {
    return new Map((await loadStaff(supabase)).map((s) => [s.userId, s.name]));
  } catch {
    return new Map();
  }
}

/** The people who can point on the tablet: counter staff with a code. */
export function tabletPeople(staff: StaffEntry[]): StaffEntry[] {
  return staff.filter((s) => s.hasPin && (s.role === "ADMIN" || s.role === "CAISSIER"));
}

export async function setStaffPin(supabase: SupabaseClient, userId: string, pin: string): Promise<void> {
  const { error } = await supabase.rpc("set_staff_pin", { p_user_id: userId, p_pin: pin });
  if (error) throw new Error(needsMigration(error.message, "set_staff_pin") ? MIGRATION : error.message);
}

export async function clearStaffPin(supabase: SupabaseClient, userId: string): Promise<void> {
  const { error } = await supabase.rpc("clear_staff_pin", { p_user_id: userId });
  if (error) throw new Error(needsMigration(error.message, "clear_staff_pin") ? MIGRATION : error.message);
}

export type Identity = { token: string; userId: string; name: string };

/** Name + code → a token for the requests that follow; a wrong code comes back as an error message. */
export async function identify(
  supabase: SupabaseClient,
  userId: string,
  pin: string,
): Promise<{ ok: true; identity: Identity } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("tablet_identify", { p_user_id: userId, p_pin: pin });
  if (error) return { ok: false, error: needsMigration(error.message, "tablet_identify") ? MIGRATION : error.message };
  const r = (data ?? {}) as Record<string, unknown>;
  if (r.ok !== true) return { ok: false, error: String(r.error ?? "Code refusé.") };
  return { ok: true, identity: { token: String(r.token), userId: String(r.user_id), name: String(r.name ?? "") } };
}

/** The token stops naming anyone (tablet locked). Errors ignored: it expires anyway. */
export async function release(supabase: SupabaseClient, token: string): Promise<void> {
  await supabase.rpc("tablet_release", { p_token: token });
}
