/*
 * Doublons de fiches clients (2026-11-03).
 *
 * Chez Espace Auto 92, 17 groupes de doublons en un mois : la même personne
 * retapée au lieu d'être choisie dans la liste, la même société saisie une
 * fois en garage et une fois en client PRO, une fiche créée à chaque essai
 * d'une commande refusée. Avant de créer une fiche, l'application cherche
 * donc une fiche existante : même numéro de téléphone (toutes catégories),
 * ou même nom pour un compte professionnel (garage / client PRO — une
 * société n'existe qu'une fois), ou même nom sans numéro pour un particulier.
 * La base refuse en plus toute fiche avec exactement le même nom et le même
 * numéro (index unique, migration 20261103020000). Les numéros sont comparés
 * par leurs chiffres, +33 ramené à 0 (phoneKey).
 */

import { phoneKey as normPhone } from "@/lib/data/phone-key";

export type AccountKind = "GARAGE" | "PRO" | "PARTICULIER";

export type DuplicateCandidate = {
  id: string;
  name: string;
  phone: string | null;
  kind: AccountKind;
};

export type DuplicateMatch = {
  record: DuplicateCandidate;
  /** What made the match: the phone number, or the name. */
  by: "phone" | "name";
};

/** Letters and digits only, lower-case, accents removed: « Soins Auto Acacia » === « SOINS AUTO  ACACIA ». */
export function normName(v: string | null | undefined): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export const KIND_LABEL: Record<AccountKind, string> = {
  GARAGE: "garage",
  PRO: "client PRO",
  PARTICULIER: "client particulier",
};

/**
 * The existing file a new client would duplicate, or null.
 * - Same phone number (6 digits or more) → always a match, whatever the kind.
 * - Same name → a match when the existing file or the one being created is a
 *   professional account; two particuliers may share a name when a phone is
 *   typed (the number tells them apart), not when the typed phone is empty.
 */
export function findDuplicate(
  records: DuplicateCandidate[],
  input: { name: string; phone?: string | null; kind: AccountKind },
  opts: { excludeId?: string | null } = {},
): DuplicateMatch | null {
  const phone = normPhone(input.phone);
  const name = normName(input.name);
  const pool = opts.excludeId ? records.filter((r) => r.id !== opts.excludeId) : records;
  if (phone.length >= 6) {
    const byPhone = pool.find((r) => normPhone(r.phone) === phone);
    if (byPhone) return { record: byPhone, by: "phone" };
  }
  if (name.length >= 3) {
    const byName = pool.find(
      (r) =>
        normName(r.name) === name &&
        (r.kind !== "PARTICULIER" || input.kind !== "PARTICULIER" || phone.length < 6),
    );
    if (byName) return { record: byName, by: "name" };
  }
  return null;
}

/** The sentence shown to the cashier (hint under the form, or the refusal on save). */
export function duplicateMessage(m: DuplicateMatch): string {
  const who = `« ${m.record.name} » (${KIND_LABEL[m.record.kind]})`;
  return m.by === "phone"
    ? `Ce numéro est déjà celui de ${who}.`
    : `Une fiche ${who} existe déjà sous ce nom.`;
}

/** Postgres unique violation on clients → a sentence for the cashier. */
export function duplicateInsertError(message: string): string | null {
  return /clients_no_duplicate|duplicate key value/i.test(message)
    ? "Cette fiche existe déjà (même nom et même numéro) : choisissez-la dans la liste au lieu d'en créer une nouvelle."
    : null;
}
