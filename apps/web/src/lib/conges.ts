/* ------------------------------------------------------------------ */
/*  Congés — jours ouvrés français, libellés, formats.                  */
/*  Même calcul que public.fr_business_days côté base : lundi–vendredi  */
/*  hors jours fériés (Pâques comprise). Les dates sont des « YYYY-MM-  */
/*  DD » manipulées en UTC pour ignorer les changements d'heure.        */
/* ------------------------------------------------------------------ */

export type LeaveType = "CONGE_PAYE" | "RECUPERATION" | "SANS_SOLDE" | "MALADIE" | "AUTRE";
export type LeaveStatus = "PENDING" | "APPROVED" | "REFUSED" | "CANCELLED";

export const LEAVE_TYPES: { id: LeaveType; label: string }[] = [
  { id: "CONGE_PAYE", label: "Congé payé" },
  { id: "RECUPERATION", label: "Récupération" },
  { id: "SANS_SOLDE", label: "Congé sans solde" },
  { id: "MALADIE", label: "Arrêt maladie" },
  { id: "AUTRE", label: "Autre absence" },
];

export function leaveTypeLabel(type: string): string {
  return LEAVE_TYPES.find((t) => t.id === type)?.label ?? "Absence";
}

export function leaveStatusLabel(status: string): { label: string; cls: "green" | "amber" | "red" | "gray" } {
  switch (status) {
    case "APPROVED":
      return { label: "Validé", cls: "green" };
    case "REFUSED":
      return { label: "Refusé", cls: "red" };
    case "CANCELLED":
      return { label: "Annulé", cls: "gray" };
    default:
      return { label: "En attente", cls: "amber" };
  }
}

const DAY_MS = 86_400_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** « YYYY-MM-DD » of a local date (what <input type="date"> expects). */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseUtc(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : t;
}

function utcYmd(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Easter Sunday (Meeus/Jones/Butcher), as a UTC timestamp. */
export function easterSunday(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return Date.UTC(year, Math.floor(n / 31) - 1, (n % 31) + 1);
}

/** French public holidays of a year, as « YYYY-MM-DD », with their names. */
export function frenchHolidays(year: number): { date: string; name: string }[] {
  const easter = easterSunday(year);
  return [
    { date: `${year}-01-01`, name: "Jour de l'an" },
    { date: utcYmd(easter + DAY_MS), name: "Lundi de Pâques" },
    { date: `${year}-05-01`, name: "Fête du Travail" },
    { date: `${year}-05-08`, name: "Victoire 1945" },
    { date: utcYmd(easter + 39 * DAY_MS), name: "Ascension" },
    { date: utcYmd(easter + 50 * DAY_MS), name: "Lundi de Pentecôte" },
    { date: `${year}-07-14`, name: "Fête nationale" },
    { date: `${year}-08-15`, name: "Assomption" },
    { date: `${year}-11-01`, name: "Toussaint" },
    { date: `${year}-11-11`, name: "Armistice" },
    { date: `${year}-12-25`, name: "Noël" },
  ].sort((a, b) => a.date.localeCompare(b.date));
}

export type BusinessDays = {
  /** Working days counted (Monday–Friday, holidays excluded). */
  days: number;
  /** Public holidays that fell on a weekday inside the period, so the message can name them. */
  holidays: { date: string; name: string }[];
};

/** Working days between two « YYYY-MM-DD » dates, both included. Invalid or reversed dates count 0. */
export function businessDays(from: string, to: string): BusinessDays {
  const start = parseUtc(from);
  const end = parseUtc(to);
  if (start === null || end === null || end < start) return { days: 0, holidays: [] };
  const y1 = new Date(start).getUTCFullYear();
  const y2 = new Date(end).getUTCFullYear();
  const holidayByDate = new Map<string, string>();
  for (let y = y1; y <= y2; y++) {
    for (const h of frenchHolidays(y)) holidayByDate.set(h.date, h.name);
  }
  let days = 0;
  const holidays: { date: string; name: string }[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const key = utcYmd(t);
    const name = holidayByDate.get(key);
    if (name) {
      holidays.push({ date: key, name });
      continue;
    }
    days += 1;
  }
  return { days, holidays };
}

const FR_FULL: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };

function fmtUtc(t: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(t).toLocaleDateString("fr-FR", { ...opts, timeZone: "UTC" });
}

/** « lun. 19 → ven. 30 oct. 2026 », « lun. 4 mai 2026 », « lun. 28 déc. 2026 → ven. 8 janv. 2027 ». */
export function fmtLeavePeriod(from: string, to: string): string {
  const a = parseUtc(from);
  const b = parseUtc(to);
  if (a === null || b === null) return `${from} → ${to}`;
  const full = fmtUtc(b, FR_FULL);
  if (a === b) return fmtUtc(a, FR_FULL);
  const da = new Date(a);
  const db = new Date(b);
  if (da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth()) {
    return `${fmtUtc(a, { weekday: "short", day: "numeric" })} → ${full}`;
  }
  if (da.getUTCFullYear() === db.getUTCFullYear()) {
    return `${fmtUtc(a, { weekday: "short", day: "numeric", month: "short" })} → ${full}`;
  }
  return `${fmtUtc(a, FR_FULL)} → ${full}`;
}

/** « 25 déc. » for the holiday notes. */
export function fmtShortDay(iso: string): string {
  const t = parseUtc(iso);
  return t === null ? iso : fmtUtc(t, { day: "numeric", month: "short" });
}

export function plural(n: number, word: string): string {
  const v = Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
  return `${v} ${word}${n > 1 ? "s" : ""}`;
}

/**
 * The sentence under the dates of the request form: how many working days
 * are counted, which holidays are skipped, and what will be left on the
 * paid-leave balance.
 */
export function leavePreview(
  type: LeaveType,
  from: string,
  to: string,
  remaining: number | null,
): { text: string; tone: "info" | "warn" | "muted" } {
  if (!from || !to) return { text: "Choisissez les dates de votre absence.", tone: "muted" };
  const { days, holidays } = businessDays(from, to);
  if (days === 0) {
    return { text: "Aucun jour ouvré sur cette période (week-ends et jours fériés ne comptent pas).", tone: "warn" };
  }
  let text = `${plural(days, "jour")} ouvré${days > 1 ? "s" : ""} décompté${days > 1 ? "s" : ""}`;
  if (holidays.length > 0) {
    const names = holidays.map((h) => `le ${fmtShortDay(h.date)}`).join(", ");
    text += ` (${names}, férié${holidays.length > 1 ? "s" : ""}, ne compte${holidays.length > 1 ? "nt" : ""} pas)`;
  }
  text += ".";
  if (type === "CONGE_PAYE" && remaining !== null) {
    const left = remaining - days;
    if (left < 0) {
      return { text: `${text} Solde insuffisant : il vous reste ${plural(remaining, "jour")} de congés payés.`, tone: "warn" };
    }
    text += ` Il vous restera ${plural(left, "jour")}.`;
  }
  return { text, tone: "info" };
}
