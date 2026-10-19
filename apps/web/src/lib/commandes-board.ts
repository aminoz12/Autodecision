import type { BoardLine, SmsState } from "@/lib/data/commandes";
import type { TicketData, TicketLine } from "@/components/print/OrderTicket";

/*
 * « Suivi des commandes » — the lists shown on the counter's page
 * (dashboard/commandes) and on the stock tablet (/tablette): one set of rules.
 */

/** Who a line is for: walk-in client, client PRO (a professional served at the counter), garage, or the magasin stock. */
export type LineKind = "CLIENT" | "PRO" | "GARAGE" | "STOCK";

/** Badge words, shared by the counter page and the tablet (chips carry their own longer labels). */
export const LINE_KIND_LABEL: Record<LineKind, string> = { CLIENT: "Client", PRO: "Client PRO", GARAGE: "Garage", STOCK: "Stock" };

export function lineKind(l: BoardLine): LineKind {
  if (l.fromStock) return "STOCK";
  if (l.isGarage) return "GARAGE";
  // A client PRO collects at the counter like a walk-in client but is shown
  // apart, in its own colour (user, 2026-10-19).
  return l.isPro ? "PRO" : "CLIENT";
}

/**
 * « À pointer » = awaited lines: client lines + stock lines already re-ordered
 * from a supplier. Stock lines NOT yet re-ordered live on the Stock page
 * (« À recommander »), so they're excluded here.
 */
export function pendingLines(board: BoardLine[]): BoardLine[] {
  return board.filter((l) => l.status !== "RECEIVED" && !(l.fromStock && !l.supplierName));
}

export function backorderLines(board: BoardLine[]): BoardLine[] {
  return board.filter((l) => l.status === "BACKORDER");
}

/** Tournées of the pending lines (derived tournées have no tour_id but a real name), « Tournée … » first. */
export function toursOf(lines: BoardLine[]): { name: string; count: number }[] {
  const map = new Map<string, { name: string; count: number }>();
  for (const l of lines) {
    const key = l.tourName ?? "Hors tournée";
    const cur = map.get(key);
    if (cur) cur.count += 1;
    else map.set(key, { name: key, count: 1 });
  }
  return [...map.values()].sort((a, b) => {
    const ra = a.name.startsWith("Tournée") ? 0 : 1;
    const rb = b.name.startsWith("Tournée") ? 0 : 1;
    return ra - rb || a.name.localeCompare(b.name);
  });
}

export type DeliveryOrder = {
  orderId: string;
  ref: string;
  date: string | null;
  clientName: string;
  clientPhone: string | null;
  isGarage: boolean;
  vehicle: string | null;
  plate: string | null;
  tourName: string | null;
  dateEnvoi: string | null;
  livreurId: string | null;
  livreurName: string | null;
  /** The livreur who collected the parts at the suppliers delivers them too. */
  tourLivreurId: string | null;
  clientId: string | null;
  address: string | null;
  city: string | null;
  failedReason: string | null;
  attempts: number;
  pieces: number;
  total: number;
  received: number;
  expected: number;
  missing: number;
  stage: "AWAITING" | "READY" | "TRANSIT";
};

/**
 * « Commande à livrer » — garage orders and orders flagged « Envoyer au
 * livreur »: one row per order with its reception progress, then the
 * dispatch to a livreur (→ en cours de livraison) and the delivery.
 */
export function deliveryOrdersOf(board: BoardLine[]): DeliveryOrder[] {
  const byOrder = new Map<string, BoardLine[]>();
  for (const l of board) {
    if (l.isRestock) continue;
    // Garages are delivered; clients are prepared in « Commande à préparer » —
    // unless the order is already out with a livreur: it must stay closable.
    if (!l.isGarage && l.workflow !== "IN_TRANSIT") continue;
    if (l.workflow === "DELIVERED") continue;
    const arr = byOrder.get(l.orderId);
    if (arr) arr.push(l);
    else byOrder.set(l.orderId, [l]);
  }
  return [...byOrder.entries()]
    .map(([orderId, lines]) => {
      const first = lines[0];
      const awaited = lines.filter((l) => l.status === "PENDING" || l.status === "BACKORDER" || l.status === "PARTIAL");
      const received = lines.filter((l) => l.status === "RECEIVED").length;
      const expected = lines.filter((l) => l.status !== "NOT_RECEIVED").length;
      const inTransit = first.workflow === "IN_TRANSIT";
      const stage: DeliveryOrder["stage"] = inTransit ? "TRANSIT" : awaited.length > 0 ? "AWAITING" : "READY";
      return {
        orderId,
        ref: first.orderRef,
        date: first.orderDate,
        clientName: first.clientName,
        clientPhone: first.clientPhone,
        isGarage: first.isGarage,
        vehicle: first.vehicle,
        plate: first.plate,
        tourName: first.tourName,
        dateEnvoi: first.dateEnvoi,
        livreurId: first.livreurId,
        livreurName: first.livreurName,
        tourLivreurId: lines.find((l) => l.tourLivreurId)?.tourLivreurId ?? null,
        clientId: first.clientId,
        address: first.clientAddress,
        city: first.clientCity,
        failedReason: first.deliveryFailedReason,
        attempts: first.deliveryAttempts,
        pieces: lines.reduce((s, l) => s + l.quantity, 0),
        total: lines.length,
        received,
        expected,
        missing: awaited.length,
        stage,
      };
    })
    .sort((a, b) => {
      const rank = { READY: 0, AWAITING: 1, TRANSIT: 2 };
      return rank[a.stage] - rank[b.stage] || String(b.date ?? "").localeCompare(String(a.date ?? ""));
    });
}

export type PrepareOrder = {
  orderId: string;
  ref: string;
  date: string | null;
  clientId: string | null;
  clientName: string;
  clientPhone: string | null;
  vehicle: string | null;
  plate: string | null;
  total: number;
  received: number;
  complet: boolean;
  lastAt: string | null;
  lastSupplier: string | null;
  state: SmsState;
};

/**
 * « Commande à préparer » — walk-in CLIENT orders whose parts arrived: the
 * client is told by SMS and the order is prepared at the counter.
 * Stock-replenishment lines never notify a client, and garage / delivery
 * orders live in « Commande à livrer » instead.
 */
export function prepareOrdersOf(board: BoardLine[], sms: Map<string, SmsState>): PrepareOrder[] {
  const byOrder = new Map<string, BoardLine[]>();
  for (const l of board) {
    // Out with a livreur: nothing left to prepare at the counter.
    if (l.fromStock || l.isRestock || l.isGarage || l.workflow === "IN_TRANSIT") continue;
    const arr = byOrder.get(l.orderId);
    if (arr) arr.push(l);
    else byOrder.set(l.orderId, [l]);
  }
  return [...byOrder.entries()]
    .map(([orderId, lines]) => {
      const receivedLines = lines.filter((l) => l.status === "RECEIVED");
      const last = receivedLines
        .slice()
        .sort((a, b) => String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")))[0];
      return {
        orderId,
        ref: lines[0].orderRef,
        date: lines[0].orderDate,
        clientId: lines[0].clientId,
        clientName: lines[0].clientName,
        clientPhone: lines[0].clientPhone,
        vehicle: lines[0].vehicle,
        plate: lines[0].plate,
        total: lines.length,
        received: receivedLines.length,
        complet: receivedLines.length === lines.length,
        lastAt: last?.receivedAt ?? null,
        lastSupplier: last?.supplierName ?? null,
        state: sms.get(orderId) ?? { sent: false, treated: false },
      };
    })
    .filter((o) => o.received > 0 && !o.state.treated)
    .sort((a, b) => String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? "")));
}

/** Free search over a line (several words: every word must match). */
export function lineMatches(l: BoardLine, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [l.reference, l.referenceCommande ?? "", l.designation, l.orderRef, l.clientName, l.clientPhone ?? "", l.plate ?? "", l.vehicle ?? "", l.supplierName ?? ""]
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/* ------------------------------------------------------------------ */
/*  Pointage par commande (2026-10-18)                                 */
/* ------------------------------------------------------------------ */


/** One order of « À recevoir »: its awaited lines, pointed together or one by one. */
export type ReceiveOrder = {
  orderId: string;
  ref: string;
  date: string | null;
  clientId: string | null;
  clientName: string;
  clientPhone: string | null;
  isGarage: boolean;
  isRestock: boolean;
  kind: LineKind;
  plate: string | null;
  vehicle: string | null;
  tourName: string | null;
  suppliers: string[];
  /** Earliest expected arrival among the awaited lines. */
  expectedAt: string | null;
  /** The awaited lines (not RECEIVED, not NOT_RECEIVED): what « Tout reçu » points. */
  lines: BoardLine[];
  /** Units still to come on those lines. */
  missing: number;
  /** Units already in (every line of the order, fully received ones included). */
  receivedUnits: number;
  /** « Commande partielle »: some parts came in, some are still awaited. */
  partial: boolean;
};

export function receiveOrdersOf(pending: BoardLine[], all: BoardLine[] = pending): ReceiveOrder[] {
  const byOrder = new Map<string, BoardLine[]>();
  for (const l of pending) {
    const arr = byOrder.get(l.orderId);
    if (arr) arr.push(l);
    else byOrder.set(l.orderId, [l]);
  }
  // Units already received per order, over the whole board (a line fully
  // received is no longer « pending », yet it makes the order partial).
  const receivedByOrder = new Map<string, number>();
  for (const l of all) {
    if (l.status === "NOT_RECEIVED") continue;
    receivedByOrder.set(l.orderId, (receivedByOrder.get(l.orderId) ?? 0) + Math.min(l.quantity, l.received));
  }
  return [...byOrder.entries()]
    .map(([orderId, lines]) => {
      const first = lines[0];
      const awaited = lines.filter((l) => l.status !== "NOT_RECEIVED");
      const expected = awaited.map((l) => l.expectedAt).filter((v): v is string => !!v).sort()[0] ?? null;
      const missing = awaited.reduce((s, l) => s + Math.max(0, l.quantity - l.received), 0);
      const receivedUnits = receivedByOrder.get(orderId) ?? 0;
      return {
        orderId,
        ref: first.orderRef,
        date: first.orderDate,
        clientId: first.clientId,
        clientName: first.clientName,
        clientPhone: first.clientPhone,
        isGarage: first.isGarage,
        isRestock: first.isRestock,
        kind: lineKind(first),
        plate: first.plate,
        vehicle: first.vehicle,
        tourName: first.tourName,
        suppliers: [...new Set(lines.map((l) => l.supplierName ?? "Stock magasin"))],
        expectedAt: expected,
        lines: awaited,
        missing,
        receivedUnits,
        partial: receivedUnits > 0 && missing > 0,
      };
    })
    .sort((a, b) => {
      const ea = a.expectedAt ?? "9999";
      const eb = b.expectedAt ?? "9999";
      return ea.localeCompare(eb) || String(b.date ?? "").localeCompare(String(a.date ?? "")) || a.ref.localeCompare(b.ref);
    });
}

/**
 * Where an order stands once its lines were pointed: complete when nothing is
 * awaited any more and at least one part came in (« non disponible » lines
 * never hold an order back).
 */
export function orderCompletion(board: BoardLine[], orderId: string): { complete: boolean; lines: BoardLine[] } {
  const lines = board.filter((l) => l.orderId === orderId);
  const awaited = lines.some((l) => l.status === "PENDING" || l.status === "BACKORDER" || l.status === "PARTIAL");
  const received = lines.some((l) => l.status === "RECEIVED");
  return { complete: !awaited && received, lines };
}

/** A ticket (rangement / bon de livraison) built from the board's lines of one order. */
export function boardTicketData(
  lines: BoardLine[],
  extra: { vendeur?: string | null; casier?: string | null; livreur?: string | null },
): TicketData | null {
  const first = lines[0];
  if (!first) return null;
  const kept = lines.filter((l) => l.status !== "NOT_RECEIVED");
  const total = kept.reduce((s, l) => s + l.quantity * l.unitPrice, 0);
  return {
    ref: first.orderRef,
    createdAt: new Date().toISOString(),
    vendeur: extra.vendeur ?? null,
    tourName: first.tourName,
    deliveryAt: first.dateEnvoi,
    clientName: first.clientName,
    clientPhone: first.clientPhone,
    plate: first.plate,
    vehicleModel: first.vehicle,
    kilometrage: null,
    lines: kept.map((l) => ({
      reference: l.reference,
      designation: l.designation,
      quantity: l.quantity,
      prixVente: l.unitPrice,
      retourPossible: !l.retourImpossible,
      taken: l.handedOver >= l.quantity,
    })),
    total,
    avoirApplique: 0,
    paye: 0,
    reste: 0,
    statutPaiement: "",
    casier: extra.casier ?? null,
    livreur: extra.livreur ?? null,
  };
}

/**
 * Ticket « réception partielle » (2026-10-18): over every line of the order,
 * what is in (already received + pointed now in `picks`, line id → units)
 * and what is still awaited. « Non disponible » lines are left out.
 */
export function partialTicketData(
  lines: BoardLine[],
  picks: ReadonlyMap<string, number>,
  extra: { vendeur?: string | null; casier?: string | null },
): TicketData | null {
  const base = boardTicketData(lines, extra);
  if (!base) return null;
  const received: TicketLine[] = [];
  const missing: TicketLine[] = [];
  for (const l of lines) {
    if (l.status === "NOT_RECEIVED") continue;
    const got = Math.min(l.quantity, l.received + (picks.get(l.id) ?? 0));
    const row = { reference: l.reference, designation: l.designation, prixVente: l.unitPrice, retourPossible: !l.retourImpossible, taken: l.handedOver >= l.quantity };
    if (got > 0) received.push({ ...row, quantity: got });
    if (l.quantity - got > 0) missing.push({ ...row, quantity: l.quantity - got });
  }
  return { ...base, lines: received, missing, casierBox: !lines[0].isRestock };
}
