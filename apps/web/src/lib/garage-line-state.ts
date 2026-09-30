/*
 * Per-article state on a garage order, as the caissier and the garage read it:
 *   règlement  : À payer · Payé · Offert
 *   retour     : Aucun retour · Retour demandé · À récupérer · Récupéré · Retourné · Retour refusé
 * Pure functions over the return rows and the line, no I/O.
 */

export type LineReturnState = "NONE" | "REQUESTED" | "TO_COLLECT" | "COLLECTED" | "RETURNED" | "REFUSED";

export const LINE_RETURN_LABEL: Record<LineReturnState, { label: string; cls: string }> = {
  NONE: { label: "Aucun retour", cls: "gray" },
  REQUESTED: { label: "Retour demandé", cls: "amber" },
  TO_COLLECT: { label: "À récupérer", cls: "blue" },
  COLLECTED: { label: "Récupéré", cls: "violet" },
  RETURNED: { label: "Retourné", cls: "green" },
  REFUSED: { label: "Retour refusé", cls: "red" },
};

export type LineReturnRow = {
  lineId: string | null;
  /** sales_returns.statut_traitement */
  status: string;
  /** The livreur marked the collect leg done. */
  legDone: boolean;
  quantity: number;
  createdAt?: string | null;
};

/** State of one return row. */
export function returnStateOf(r: { status: string; legDone: boolean }): LineReturnState {
  switch (r.status) {
    case "A_TRAITER":
    case "DEMANDE_ENVOYEE":
      return "REQUESTED";
    case "A_RECUPERER":
      return r.legDone ? "COLLECTED" : "TO_COLLECT";
    case "ACCEPTE":
    case "REMBOURSE":
    case "AVOIR":
      return "RETURNED";
    case "REFUSE":
      return "REFUSED";
    default:
      return "REQUESTED";
  }
}

/**
 * The return that currently describes a line: the most recent one that was
 * not refused; a refused one only when nothing else exists.
 */
export function lineReturnState<T extends LineReturnRow>(returns: T[], lineId: string): { state: LineReturnState; current: T | null } {
  const mine = returns.filter((r) => r.lineId === lineId).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  if (mine.length === 0) return { state: "NONE", current: null };
  const live = mine.find((r) => r.status !== "REFUSE") ?? null;
  if (live) return { state: returnStateOf(live), current: live };
  return { state: "REFUSED", current: mine[0] };
}

/** Units of a line that can still be requested (returns refused do not count). */
export function returnableQuantity(returns: LineReturnRow[], lineId: string, lineQuantity: number): number {
  const requested = returns.filter((r) => r.lineId === lineId && r.status !== "REFUSE").reduce((s, r) => s + Math.max(1, r.quantity), 0);
  return Math.max(0, lineQuantity - requested);
}

export type LineReglement = "A_PAYER" | "PAYE" | "OFFERT";

export const REGLEMENT_LABEL: Record<LineReglement, { label: string; cls: string }> = {
  A_PAYER: { label: "À payer", cls: "amber" },
  PAYE: { label: "Payé", cls: "green" },
  OFFERT: { label: "Offert", cls: "violet" },
};

/**
 * What the counter shows for a line: the label set on the line, else derived
 * from the order (settled order → every line is paid).
 */
export function lineReglement(reglement: string | null | undefined, orderBalance: number): LineReglement {
  if (reglement === "OFFERT") return "OFFERT";
  if (reglement === "PAYE" || orderBalance <= 0.005) return "PAYE";
  return "A_PAYER";
}
