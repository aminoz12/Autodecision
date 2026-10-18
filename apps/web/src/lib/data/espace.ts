import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";
import type { LeaveStatus, LeaveType } from "@/lib/conges";

/* ------------------------------------------------------------------ */
/*  Mon espace — stats personnelles et congés (migration 20261018).    */
/*  Tout passe par des RPC : un livreur ne lit aucune table, un        */
/*  caissier ne voit que ses propres chiffres, l'admin tout le magasin. */
/* ------------------------------------------------------------------ */

export type LeaveBalance = {
  year: number;
  allowance: number;
  taken: number;
  planned: number;
  pending: number;
  remaining: number;
};

export type LeaveRequest = {
  id: string;
  type: LeaveType;
  dateFrom: string;
  dateTo: string;
  days: number;
  comment: string | null;
  status: LeaveStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
};

export type LeaveSpace = { balance: LeaveBalance; requests: LeaveRequest[] };

export type CounterStats = {
  from: string;
  to: string;
  orders: number;
  ca: number;
  panierMoyen: number;
  remises: number;
  prevOrders: number;
  prevCa: number;
  devisTotal: number;
  devisAccepted: number;
  linesPointed: number;
  linesHanded: number;
  rank: number;
  sellers: number;
  teamCa: number;
  days: { day: string; ca: number; orders: number }[];
};

export type LivreurStats = {
  from: string;
  to: string;
  delivered: number;
  prevDelivered: number;
  failed: number;
  pickups: number;
  tours: number;
  days: { day: string; delivered: number }[];
};

export type PendingLeave = {
  id: string;
  userId: string;
  name: string;
  role: string;
  type: LeaveType;
  dateFrom: string;
  dateTo: string;
  days: number;
  comment: string | null;
  createdAt: string;
  /** Paid-leave days left for that person once this request is counted (CONGE_PAYE only). */
  remaining: number | null;
  overlaps: { name: string; dateFrom: string; dateTo: string; status: LeaveStatus }[];
};

export type StaffBalance = { userId: string; name: string; role: string; balance: LeaveBalance };

export type Absence = {
  id: string;
  userId: string;
  name: string;
  role: string;
  type: LeaveType;
  dateFrom: string;
  dateTo: string;
  days: number;
  status: LeaveStatus;
};

export type AdminLeaveBoard = {
  year: number;
  today: string;
  pending: PendingLeave[];
  balances: StaffBalance[];
  absences: Absence[];
};

type J = Record<string, unknown>;

function str(v: unknown): string {
  return v == null ? "" : String(v);
}
function nstr(v: unknown): string | null {
  return v == null || v === "" ? null : String(v);
}
function asList(v: unknown): J[] {
  return Array.isArray(v) ? (v as J[]) : [];
}

function mapBalance(j: unknown): LeaveBalance {
  const b = (j ?? {}) as J;
  return {
    year: toNumber(b.year),
    allowance: toNumber(b.allowance),
    taken: toNumber(b.taken),
    planned: toNumber(b.planned),
    pending: toNumber(b.pending),
    remaining: toNumber(b.remaining),
  };
}

function mapRequest(r: J): LeaveRequest {
  return {
    id: str(r.id),
    type: str(r.type) as LeaveType,
    dateFrom: str(r.date_from),
    dateTo: str(r.date_to),
    days: toNumber(r.days),
    comment: nstr(r.comment),
    status: str(r.status) as LeaveStatus,
    createdAt: str(r.created_at),
    decidedAt: nstr(r.decided_at),
    decidedBy: nstr(r.decided_by),
    decisionNote: nstr(r.decision_note),
  };
}

async function rpc<T>(supabase: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/* ---------------- Employé ---------------- */

export async function loadMyLeaveSpace(supabase: SupabaseClient, year?: number): Promise<LeaveSpace> {
  const j = await rpc<J>(supabase, "my_leave_space", { p_year: year ?? null });
  return { balance: mapBalance(j?.balance), requests: asList(j?.requests).map(mapRequest) };
}

export async function requestLeave(
  supabase: SupabaseClient,
  input: { type: LeaveType; from: string; to: string; comment?: string },
): Promise<string> {
  return rpc<string>(supabase, "request_leave", {
    p_type: input.type,
    p_from: input.from,
    p_to: input.to,
    p_comment: input.comment?.trim() || null,
  });
}

export async function cancelLeave(supabase: SupabaseClient, id: string): Promise<void> {
  await rpc(supabase, "cancel_leave", { p_id: id });
}

export async function loadCounterStats(supabase: SupabaseClient, range: { from: string; to: string }): Promise<CounterStats> {
  const j = await rpc<J>(supabase, "my_counter_stats", { p_from: range.from, p_to: range.to });
  return {
    from: str(j.from),
    to: str(j.to),
    orders: toNumber(j.orders),
    ca: toNumber(j.ca),
    panierMoyen: toNumber(j.panier_moyen),
    remises: toNumber(j.remises),
    prevOrders: toNumber(j.prev_orders),
    prevCa: toNumber(j.prev_ca),
    devisTotal: toNumber(j.devis_total),
    devisAccepted: toNumber(j.devis_accepted),
    linesPointed: toNumber(j.lines_pointed),
    linesHanded: toNumber(j.lines_handed),
    rank: toNumber(j.rank),
    sellers: toNumber(j.sellers),
    teamCa: toNumber(j.team_ca),
    days: asList(j.days).map((d) => ({ day: str(d.day), ca: toNumber(d.ca), orders: toNumber(d.orders) })),
  };
}

export async function loadLivreurStats(supabase: SupabaseClient, range: { from: string; to: string }): Promise<LivreurStats> {
  const j = await rpc<J>(supabase, "my_livreur_stats", { p_from: range.from, p_to: range.to });
  return {
    from: str(j.from),
    to: str(j.to),
    delivered: toNumber(j.delivered),
    prevDelivered: toNumber(j.prev_delivered),
    failed: toNumber(j.failed),
    pickups: toNumber(j.pickups),
    tours: toNumber(j.tours),
    days: asList(j.days).map((d) => ({ day: str(d.day), delivered: toNumber(d.delivered) })),
  };
}

/* ---------------- Administrateur ---------------- */

export async function loadAdminLeaveBoard(supabase: SupabaseClient, year?: number): Promise<AdminLeaveBoard> {
  const j = await rpc<J>(supabase, "admin_leave_board", { p_year: year ?? null });
  return {
    year: toNumber(j.year),
    today: str(j.today),
    pending: asList(j.pending).map((r) => ({
      id: str(r.id),
      userId: str(r.user_id),
      name: str(r.name),
      role: str(r.role),
      type: str(r.type) as LeaveType,
      dateFrom: str(r.date_from),
      dateTo: str(r.date_to),
      days: toNumber(r.days),
      comment: nstr(r.comment),
      createdAt: str(r.created_at),
      remaining: r.remaining == null ? null : toNumber(r.remaining),
      overlaps: asList(r.overlaps).map((o) => ({
        name: str(o.name),
        dateFrom: str(o.date_from),
        dateTo: str(o.date_to),
        status: str(o.status) as LeaveStatus,
      })),
    })),
    balances: asList(j.balances).map((b) => ({
      userId: str(b.user_id),
      name: str(b.name),
      role: str(b.role),
      balance: mapBalance(b.balance),
    })),
    absences: asList(j.absences).map((a) => ({
      id: str(a.id),
      userId: str(a.user_id),
      name: str(a.name),
      role: str(a.role),
      type: str(a.type) as LeaveType,
      dateFrom: str(a.date_from),
      dateTo: str(a.date_to),
      days: toNumber(a.days),
      status: str(a.status) as LeaveStatus,
    })),
  };
}

export async function decideLeave(supabase: SupabaseClient, id: string, approve: boolean, note?: string): Promise<void> {
  await rpc(supabase, "decide_leave", { p_id: id, p_approve: approve, p_note: note?.trim() || null });
}

export async function adminAddAbsence(
  supabase: SupabaseClient,
  input: { userId: string; type: LeaveType; from: string; to: string; note?: string },
): Promise<string> {
  return rpc<string>(supabase, "admin_add_absence", {
    p_user: input.userId,
    p_type: input.type,
    p_from: input.from,
    p_to: input.to,
    p_note: input.note?.trim() || null,
  });
}

export async function setLeaveAllowance(supabase: SupabaseClient, userId: string, year: number, days: number): Promise<void> {
  await rpc(supabase, "set_leave_allowance", { p_user: userId, p_year: year, p_days: days });
}

/* ---------------- Périodes ---------------- */

export type PeriodPreset = "month" | "last_month" | "7d" | "30d" | "year";

export function periodLabel(preset: PeriodPreset): { label: string; vs: string } {
  switch (preset) {
    case "month":
      return { label: "Ce mois", vs: "vs mois dernier" };
    case "last_month":
      return { label: "Mois dernier", vs: "vs mois d'avant" };
    case "7d":
      return { label: "7 jours", vs: "vs 7 jours précédents" };
    case "30d":
      return { label: "30 jours", vs: "vs 30 jours précédents" };
    default:
      return { label: "Cette année", vs: "vs année dernière" };
  }
}

/** « +6,1 % » against the previous period, or null when there is nothing to compare with. */
export function pctChange(current: number, previous: number): string | null {
  if (previous <= 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const rounded = Math.round(pct * 10) / 10;
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(1).replace(".", ",")} %`;
}

/** « 2e », « 1er ». */
export function ordinalFr(n: number): { value: string; suffix: string } {
  if (n <= 0) return { value: "—", suffix: "" };
  return { value: String(n), suffix: n === 1 ? "er" : "e" };
}
