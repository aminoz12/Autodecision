/**
 * The digits that identify a phone number: « 06 27 08 55 05 »,
 * « +33 6 27 08 55 05 » and « 0033627085505 » are the same number and give
 * the same key, « 0627085505 ». Mirrors `phone_key()` in the database
 * (migration 20261103020000), which backs the unique index on clients.
 */
export function phoneKey(v: string | null | undefined): string {
  const d = String(v ?? "").replace(/\D/g, "");
  return /^(00)?33[1-9]\d{8}$/.test(d) ? `0${d.slice(-9)}` : d;
}
