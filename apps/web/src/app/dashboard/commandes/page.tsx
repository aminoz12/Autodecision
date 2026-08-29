"use client";

import {
  Ban,
  Banknote,
  Box,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  ClipboardCheck,
  FileText,
  Hourglass,
  Info,
  ListChecks,
  Loader2,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Truck,
  User,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { createWalkInReturn, markLineReceived } from "@/lib/data/saas";
import {
  dispatchOrderToLivreur,
  loadLivreurs,
  markOrderDelivered,
  type Livreur,
} from "@/lib/data/livreurs";
import {
  loadReceptionBoard,
  loadSmsStates,
  markOrderSmsTreated,
  recordSmsSent,
  setLineHandedOver,
  setLineReceptionStatus,
  type BoardLine,
  type ReceptionStatus,
  type SmsState,
} from "@/lib/data/commandes";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const STATUT: Record<
  ReceptionStatus,
  { label: string; cls: string; icon: LucideIcon }
> = {
  PENDING: { label: "En attente", cls: "attente", icon: Clock },
  RECEIVED: { label: "Reçu", cls: "recu", icon: CheckCircle2 },
  BACKORDER: { label: "Reliquat", cls: "reliquat", icon: Hourglass },
  NOT_RECEIVED: { label: "Non reçu", cls: "nonrecu", icon: XCircle },
};

const TOUR_COLORS = ["#3B82F6", "#EF4444", "#F59E0B", "#10B981", "#7C3AED"];

function fmtMoney(v: number): string {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function fmtDay(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function fmtDayTime(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  const day = d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `${day} à ${time}`;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

/** Who a line is for: walk-in client, garage, or the magasin stock. */
type LineKind = "CLIENT" | "GARAGE" | "STOCK";

function lineKind(l: BoardLine): LineKind {
  if (l.fromStock) return "STOCK";
  return l.isGarage ? "GARAGE" : "CLIENT";
}

const KINDS: { id: LineKind; label: string; icon: LucideIcon }[] = [
  { id: "CLIENT", label: "Client", icon: User },
  { id: "GARAGE", label: "Garages", icon: Building2 },
  { id: "STOCK", label: "Retour en stock", icon: Box },
];

export default function ReceptionCommandesPage() {
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;

  const [board, setBoard] = useState<BoardLine[]>([]);
  const [sms, setSms] = useState<Map<string, SmsState>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [tab, setTab] = useState("arecevoir");
  const [tourFilter, setTourFilter] = useState<string | null>(null);
  /** Client / Garages / Retour en stock filter under the tournées. */
  const [kindFilter, setKindFilter] = useState<LineKind | null>(null);
  /** Lines ticked for a grouped action (Reçu / Reliquat / Non reçu). */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [smsFilter, setSmsFilter] = useState<"all" | "complet" | "partiel">("all");
  const [livraisonFilter, setLivraisonFilter] = useState<"all" | "ready" | "transit">("all");

  /* ---- livreurs + dispatch modal ---- */
  const [livreurs, setLivreurs] = useState<Livreur[]>([]);
  const [dispatchOrder, setDispatchOrder] = useState<{
    orderId: string;
    ref: string;
    clientName: string;
    livreurId: string | null;
  } | null>(null);
  const [dispatchLivreur, setDispatchLivreur] = useState("");
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [b, s, l] = await Promise.all([
        loadReceptionBoard(supabase, orgId),
        loadSmsStates(supabase, orgId),
        loadLivreurs(supabase, orgId, { activeOnly: true }),
      ]);
      setBoard(b);
      setSms(s);
      setLivreurs(l);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* ---- derived sets ---- */
  // "À pointer" = awaited lines: client lines + stock lines already re-ordered
  // from a supplier. Stock lines NOT yet re-ordered live on the Stock page
  // ("À recommander"), so they're excluded here.
  const pending = useMemo(
    () =>
      board.filter(
        (l) =>
          l.status !== "RECEIVED" && !(l.fromStock && !l.supplierName),
      ),
    [board],
  );
  const backorders = useMemo(
    () => board.filter((l) => l.status === "BACKORDER"),
    [board],
  );
  const history = useMemo(
    () =>
      board
        .filter((l) => l.status === "RECEIVED")
        .sort((a, b) =>
          String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")),
        ),
    [board],
  );

  /* ---- Historique: search + walk-in return from a received line ---- */
  const [historySearch, setHistorySearch] = useState("");
  const historyFiltered = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return history;
    const terms = q.split(/\s+/);
    return history.filter((l) => {
      const hay = [
        l.reference,
        l.referenceCommande ?? "",
        l.designation,
        l.orderRef,
        l.clientName,
        l.clientPhone ?? "",
        l.plate ?? "",
        l.vehicle ?? "",
        l.supplierName ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [history, historySearch]);

  const [returnLine, setReturnLine] = useState<BoardLine | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [returnCompensation, setReturnCompensation] = useState<"REMBOURSEMENT" | "AVOIR">(
    "REMBOURSEMENT",
  );
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returnNotice, setReturnNotice] = useState<string | null>(null);

  const openReturn = useCallback((line: BoardLine) => {
    setReturnLine(line);
    setReturnReason("");
    setReturnCompensation("REMBOURSEMENT");
    setReturnError(null);
    setReturnNotice(null);
  }, []);

  const submitReturn = useCallback(async () => {
    if (!orgId || !returnLine) return;
    setReturnSubmitting(true);
    setReturnError(null);
    try {
      const { avoirNum } = await createWalkInReturn(supabase, orgId, {
        orderId: returnLine.orderId,
        clientId: returnLine.clientId,
        reason: returnReason,
        // A stock part goes back to its supplier: no client compensation.
        compensation: returnLine.fromStock ? "FOURNISSEUR" : returnCompensation,
        supplierId: returnLine.supplierId,
        lines: [
          {
            id: returnLine.id,
            reference: returnLine.reference,
            designation: returnLine.designation,
            quantity: returnLine.quantity,
            unitPrice: returnLine.unitPrice,
            lineTotal: returnLine.quantity * returnLine.unitPrice,
            retourImpossible: returnLine.retourImpossible,
            alreadyReturned: returnLine.alreadyReturned,
          },
        ],
      });
      setReturnNotice(
        returnLine.fromStock
          ? `Retour fournisseur enregistré — ${returnLine.reference} à traiter dans Retours.`
          : avoirNum
            ? `Retour enregistré — avoir ${avoirNum} créé (valable 1 an).`
            : `Retour enregistré — ${returnLine.reference} remboursé.`,
      );
      setReturnLine(null);
      await load();
    } catch (e) {
      setReturnError(e instanceof Error ? e.message : String(e));
    } finally {
      setReturnSubmitting(false);
    }
  }, [orgId, returnLine, returnReason, returnCompensation, supabase, load]);

  // Group by tournée name (derived tournées have no tour_id but a real name).
  const tours = useMemo(() => {
    const map = new Map<string, { name: string; count: number }>();
    for (const l of pending) {
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
  }, [pending]);

  const tourRows = useMemo(
    () =>
      tourFilter === null
        ? pending
        : pending.filter((l) => (l.tourName ?? "Hors tournée") === tourFilter),
    [pending, tourFilter],
  );
  const kindCounts = useMemo(() => {
    const c: Record<LineKind, number> = { CLIENT: 0, GARAGE: 0, STOCK: 0 };
    for (const l of tourRows) c[lineKind(l)] += 1;
    return c;
  }, [tourRows]);
  const pointerRows = useMemo(
    () =>
      kindFilter === null ? tourRows : tourRows.filter((l) => lineKind(l) === kindFilter),
    [tourRows, kindFilter],
  );

  /* ---- selection for grouped actions (only visible rows count) ---- */
  const selectedRows = useMemo(
    () => pointerRows.filter((l) => selected.has(l.id)),
    [pointerRows, selected],
  );
  const allVisibleSelected =
    pointerRows.length > 0 && pointerRows.every((l) => selected.has(l.id));
  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      if (pointerRows.every((l) => prev.has(l.id))) {
        const next = new Set(prev);
        for (const l of pointerRows) next.delete(l.id);
        return next;
      }
      const next = new Set(prev);
      for (const l of pointerRows) next.add(l.id);
      return next;
    });
  }, [pointerRows]);
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * "Commande à livrer" — garage orders and orders flagged "Envoyer au
   * livreur": one row per order with its reception progress, then the
   * dispatch to a livreur (→ en cours de livraison) and the delivery.
   */
  const deliveryOrders = useMemo(() => {
    const byOrder = new Map<string, BoardLine[]>();
    for (const l of board) {
      if (l.isRestock) continue;
      if (!l.isGarage) continue; // garages only — clients are prepared in "Commande à préparer"
      if (l.workflow === "DELIVERED") continue;
      const arr = byOrder.get(l.orderId);
      if (arr) arr.push(l);
      else byOrder.set(l.orderId, [l]);
    }
    return [...byOrder.entries()]
      .map(([orderId, lines]) => {
        const first = lines[0];
        const awaited = lines.filter((l) => l.status === "PENDING" || l.status === "BACKORDER");
        const received = lines.filter((l) => l.status === "RECEIVED").length;
        const expected = lines.filter((l) => l.status !== "NOT_RECEIVED").length;
        const inTransit = first.workflow === "IN_TRANSIT";
        const stage: "AWAITING" | "READY" | "TRANSIT" = inTransit
          ? "TRANSIT"
          : awaited.length > 0
            ? "AWAITING"
            : "READY";
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
  }, [board]);
  const deliveryRows = useMemo(
    () =>
      livraisonFilter === "all"
        ? deliveryOrders
        : deliveryOrders.filter((o) =>
            livraisonFilter === "ready" ? o.stage === "READY" : o.stage === "TRANSIT",
          ),
    [deliveryOrders, livraisonFilter],
  );

  /**
   * "Commande à préparer" — walk-in CLIENT orders whose parts arrived: the
   * client is told by SMS and the order is prepared at the counter.
   * Stock-replenishment lines never notify a client, and garage / delivery
   * orders live in "Commande à livrer" instead.
   */
  const smsOrders = useMemo(() => {
    const byOrder = new Map<string, BoardLine[]>();
    for (const l of board) {
      if (l.fromStock || l.isRestock || l.isGarage) continue;
      const arr = byOrder.get(l.orderId);
      if (arr) arr.push(l);
      else byOrder.set(l.orderId, [l]);
    }
    const rows = [...byOrder.entries()]
      .map(([orderId, lines]) => {
        const receivedLines = lines.filter((l) => l.status === "RECEIVED");
        const last = receivedLines
          .slice()
          .sort((a, b) =>
            String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")),
          )[0];
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
    return rows;
  }, [board, sms]);


  const smsRows = useMemo(
    () =>
      smsFilter === "all"
        ? smsOrders
        : smsOrders.filter((o) => (smsFilter === "complet" ? o.complet : !o.complet)),
    [smsOrders, smsFilter],
  );

  /* ---- actions ---- */
  const withBusy = useCallback(async (key: string, fn: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, []);

  const actReceive = (line: BoardLine) =>
    withBusy(line.id, async () => {
      if (!orgId) return;
      await markLineReceived(supabase, orgId, {
        id: line.id,
        reference: line.reference,
        designation: line.designation,
        quantity: line.quantity,
        receivedQuantity: line.received,
      });
      const now = new Date().toISOString();
      setBoard((prev) =>
        prev.map((l) =>
          l.id === line.id
            ? { ...l, status: "RECEIVED", received: l.quantity, receivedAt: now }
            : l,
        ),
      );
    });

  // Hand over to the client everything currently available on this line
  // (on the shelf for stock lines, received units otherwise). Custom
  // quantities are set from the order detail page.
  const actHandOver = (line: BoardLine) =>
    withBusy(line.id, async () => {
      if (!orgId) return;
      const available = line.fromStock ? line.quantity : Math.min(line.quantity, line.received);
      const qty = Math.max(line.handedOver, available);
      if (qty <= line.handedOver) return;
      await setLineHandedOver(supabase, orgId, line.id, qty);
      setBoard((prev) =>
        prev.map((l) => (l.id === line.id ? { ...l, handedOver: qty } : l)),
      );
    });

  // Per order: units already taken by the client vs. ordered (all lines).
  const handedByOrder = useMemo(() => {
    const map = new Map<string, { handed: number; total: number }>();
    for (const l of board) {
      const cur = map.get(l.orderId) ?? { handed: 0, total: 0 };
      cur.handed += l.handedOver;
      cur.total += l.quantity;
      map.set(l.orderId, cur);
    }
    return map;
  }, [board]);

  const actStatus = (line: BoardLine, status: "BACKORDER" | "NOT_RECEIVED") =>
    withBusy(line.id, async () => {
      if (!orgId) return;
      await setLineReceptionStatus(supabase, orgId, line.id, status);
      setBoard((prev) =>
        prev.map((l) => (l.id === line.id ? { ...l, status } : l)),
      );
    });

  const actSms = (o: (typeof smsOrders)[number]) =>
    withBusy(`sms-${o.orderId}`, async () => {
      if (!orgId) return;
      await recordSmsSent(supabase, orgId, {
        orderId: o.orderId,
        clientId: o.clientId,
        phone: o.clientPhone,
      });
      setSms((prev) => {
        const next = new Map(prev);
        const cur = next.get(o.orderId) ?? { sent: false, treated: false };
        next.set(o.orderId, { ...cur, sent: true });
        return next;
      });
    });

  const actTreated = (o: (typeof smsOrders)[number]) =>
    withBusy(`done-${o.orderId}`, async () => {
      if (!orgId) return;
      await markOrderSmsTreated(supabase, orgId, o.orderId);
      setSms((prev) => {
        const next = new Map(prev);
        const cur = next.get(o.orderId) ?? { sent: false, treated: false };
        next.set(o.orderId, { ...cur, treated: true });
        return next;
      });
    });


  /* ---- grouped action on the ticked lines ---- */
  const actBulk = (status: ReceptionStatus) =>
    withBusy("bulk", async () => {
      if (!orgId || selectedRows.length === 0) return;
      const failures: string[] = [];
      for (const line of selectedRows) {
        try {
          if (status === "RECEIVED") {
            await markLineReceived(supabase, orgId, {
              id: line.id,
              reference: line.reference,
              designation: line.designation,
              quantity: line.quantity,
              receivedQuantity: line.received,
            });
          } else if (status === "BACKORDER" || status === "NOT_RECEIVED") {
            if (line.status !== status) {
              await setLineReceptionStatus(supabase, orgId, line.id, status);
            }
          }
        } catch (e) {
          failures.push(`${line.reference} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      const done = selectedRows.length - failures.length;
      setNotice(
        `${done} pièce${done > 1 ? "s" : ""} marquée${done > 1 ? "s" : ""} « ${STATUT[status].label} ».`,
      );
      if (failures.length > 0) setError(`Échec pour : ${failures.join(", ")}`);
      await load();
    });

  /* ---- dispatch / delivered ---- */
  const openDispatch = (o: (typeof deliveryOrders)[number]) => {
    setDispatchOrder({
      orderId: o.orderId,
      ref: o.ref,
      clientName: o.clientName,
      livreurId: o.livreurId,
    });
    setDispatchLivreur(o.livreurId ?? livreurs[0]?.id ?? "");
    setDispatchError(null);
  };

  const submitDispatch = async () => {
    if (!dispatchOrder) return;
    if (!dispatchLivreur) {
      setDispatchError("Choisissez un livreur.");
      return;
    }
    setDispatchBusy(true);
    setDispatchError(null);
    try {
      await dispatchOrderToLivreur(supabase, dispatchOrder.orderId, dispatchLivreur);
      const name = livreurs.find((l) => l.id === dispatchLivreur)?.name ?? "livreur";
      setNotice(`${dispatchOrder.ref} envoyée à ${name} — en cours de livraison.`);
      setDispatchOrder(null);
      await load();
    } catch (e) {
      setDispatchError(e instanceof Error ? e.message : String(e));
    } finally {
      setDispatchBusy(false);
    }
  };

  const actDelivered = (o: (typeof deliveryOrders)[number]) =>
    withBusy(`deliver-${o.orderId}`, async () => {
      await markOrderDelivered(supabase, o.orderId);
      setNotice(`${o.ref} livrée.`);
      await load();
    });

  /* ---- tabs ---- */
  const notReceived = board.filter((l) => l.status === "NOT_RECEIVED").length;
  const readyToShip = deliveryOrders.filter((o) => o.stage === "READY").length;
  const TABS: {
    id: string;
    label: string;
    sub: string;
    icon: LucideIcon;
    count?: number;
    /** Decision color of the counter when > 0. */
    tone?: "amber" | "green" | "violet" | "orange" | "red";
    /** Small red alert next to the label. */
    alert?: string;
  }[] = [
    { id: "arecevoir", label: "Pièces à recevoir", sub: "Livraisons à réceptionner", icon: ClipboardCheck, count: pending.length, tone: "amber", alert: notReceived > 0 ? `${notReceived} non reçu${notReceived > 1 ? "s" : ""}` : undefined },
    { id: "sms", label: "Commande à préparer", sub: "Pièces reçues, clients à prévenir", icon: PackageCheck, count: smsOrders.length, tone: "green" },
    { id: "alivrer", label: "Commande à livrer", sub: "Garages — envoi au livreur", icon: Truck, count: deliveryOrders.length, tone: "violet", alert: readyToShip > 0 ? `${readyToShip} prête${readyToShip > 1 ? "s" : ""}` : undefined },
    { id: "reliquats", label: "Reliquats", sub: "En attente de livraison", icon: Clock, count: backorders.length, tone: "orange" },
    { id: "historique", label: "Historique", sub: "Réceptions passées", icon: FileText },
  ];

  /* ---------------------------------------------------------------- */
  /*  Shared line table                                                */
  /* ---------------------------------------------------------------- */

  function LinesTable({
    rows,
    showActions,
    onReturn,
    showHandOver = true,
    selectable = false,
  }: {
    rows: BoardLine[];
    showActions: boolean;
    onReturn?: (line: BoardLine) => void;
    /** "Remis client" column (hidden on the Historique tab). */
    showHandOver?: boolean;
    /** Checkbox column for grouped actions. */
    selectable?: boolean;
  }) {
    const showReceivedAt = !showActions;
    const colCount =
      6 + (showHandOver ? 1 : 0) + (showReceivedAt ? 1 : 0) + (showActions ? 1 : 0) + (onReturn ? 1 : 0) + (selectable ? 1 : 0);
    return (
      <section className="od-card rc-table-card">
        <div className="rc-table-wrap">
          <table className={`rc-table${showActions || onReturn ? " rc-table--sticky-actions" : ""}`}>
            <thead>
              <tr>
                {selectable && (
                  <th className="rc-th-check">
                    <input
                      type="checkbox"
                      className="rc-check"
                      checked={allVisibleSelected}
                      onChange={toggleSelectAll}
                      aria-label="Tout sélectionner"
                    />
                  </th>
                )}
                <th>Commande</th>
                <th>Client</th>
                <th>Référence / Désignation</th>
                <th>Fournisseur</th>
                <th className="rc-th-center">Reçu / Cmd</th>
                {showHandOver && <th>Remis client</th>}
                <th>Statut</th>
                {showReceivedAt && <th>Reçu le</th>}
                {showActions && <th className="rc-th-center">Actions</th>}
                {onReturn && <th className="rc-th-center">Retour</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const St = STATUT[r.status];
                const StIcon = St.icon;
                const type = r.fromStock ? "stock" : r.isGarage ? "garage" : "client";
                const isBusy = busy.has(r.id) || busy.has("bulk");
                const isSelected = selectable && selected.has(r.id);
                return (
                  <tr
                    key={r.id}
                    className={`rc-row rc-row--${type}${isSelected ? " rc-row--selected" : ""}`}
                  >
                    {selectable && (
                      <td className="rc-th-check">
                        <input
                          type="checkbox"
                          className="rc-check"
                          checked={isSelected}
                          onChange={() => toggleSelect(r.id)}
                          aria-label={`Sélectionner ${r.reference}`}
                        />
                      </td>
                    )}
                    <td>
                      <Link href={`/dashboard/commandes/${r.orderId}`} className="rc-cmd">
                        {r.orderRef}
                      </Link>
                      <p className="rl-muted">{fmtDay(r.orderDate)}</p>
                    </td>
                    <td>
                      <p className="rl-client">
                        {r.clientName}
                        <span className={`rc-type rc-type--${type} rc-type--inline`}>
                          {r.fromStock ? "Stock" : r.isGarage ? "Garage" : "Client"}
                        </span>
                      </p>
                      {r.clientPhone && <p className="rl-muted">{r.clientPhone}</p>}
                      {(() => {
                        const h = handedByOrder.get(r.orderId);
                        if (!h || h.handed === 0) return null;
                        const left = Math.max(0, h.total - h.handed);
                        return (
                          <p className="rl-handed">
                            Client a pris {h.handed}/{h.total} pièce(s)
                            {left > 0 ? ` · reste ${left}` : " · complet"}
                          </p>
                        );
                      })()}
                    </td>
                    <td>
                      <p className="rl-ref">{r.reference}</p>
                      {r.referenceCommande && r.referenceCommande !== r.reference && (
                        <p className="rl-ref-cmd">Réf. cmd. {r.referenceCommande}</p>
                      )}
                      <p className="rl-muted">{r.designation}</p>
                    </td>
                    <td>
                      <span
                        className="rc-brand"
                        style={{ color: r.supplierName ? "#DC2626" : "#1D4ED8" }}
                      >
                        {r.supplierName ?? "Stock magasin"}
                      </span>
                      {r.supplierName && (r.supplierOwnDelivery || r.supplierLeadDays > 0) && (
                        <p className="rc-supplier-mode">
                          {r.supplierOwnDelivery ? <Truck className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                          {r.supplierOwnDelivery ? "Livreur du fournisseur" : "Tournée"}
                          {r.supplierLeadDays > 0 ? ` · J+${r.supplierLeadDays}` : ""}
                        </p>
                      )}
                      {r.expectedAt && r.status !== "RECEIVED" && (
                        <p className="rl-muted">Prévu {fmtDayTime(r.expectedAt)}</p>
                      )}
                    </td>
                    <td className="rc-th-center">
                      <span className={`rc-qty${r.received >= r.quantity ? " rc-qty--full" : r.received > 0 ? " rc-qty--part" : ""}`}>
                        <strong>{r.received}</strong>
                        <em>/ {r.quantity}</em>
                        <i style={{ width: `${Math.min(100, Math.round((r.received / Math.max(1, r.quantity)) * 100))}%` }} />
                      </span>
                    </td>
                    {showHandOver && (
                    <td>
                      {(() => {
                        const left = Math.max(0, r.quantity - r.handedOver);
                        const available = r.fromStock
                          ? r.quantity
                          : Math.min(r.quantity, r.received);
                        const canHand = available > r.handedOver && Boolean(r.clientId);
                        return (
                          <div className="rc-remise">
                            {r.handedOver >= r.quantity ? (
                              <span className="rc-statut rc-statut--recu">
                                <Check className="h-3.5 w-3.5" />
                                Remis {r.handedOver}/{r.quantity}
                              </span>
                            ) : r.handedOver > 0 ? (
                              <span className="rc-statut rc-statut--reliquat">
                                Remis {r.handedOver}/{r.quantity} · reste {left}
                              </span>
                            ) : (
                              <span className="rc-statut rc-statut--attente">Non remis</span>
                            )}
                            {canHand && (
                              <button
                                type="button"
                                className="rc-act rc-act--remise"
                                disabled={isBusy}
                                onClick={() => actHandOver(r)}
                                title="Le client emporte les pièces disponibles"
                              >
                                Remettre {Math.max(0, available - r.handedOver)}
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    )}
                    <td>
                      <span className={`rc-statut rc-statut--${St.cls}`}>
                        <StIcon className="h-3.5 w-3.5" />
                        {St.label}
                      </span>
                    </td>
                    {showReceivedAt && (
                      <td className="rl-muted-strong">{fmtDayTime(r.receivedAt)}</td>
                    )}
                    {showActions && (
                      <td>
                        <div className="rc-actions">
                          <button
                            type="button"
                            className="rc-act rc-act--recu"
                            disabled={isBusy}
                            onClick={() => actReceive(r)}
                          >
                            Reçu{" "}
                            {isBusy ? (
                              <Loader2 className="h-3.5 w-3.5 nc-spin" />
                            ) : (
                              <Check className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="rc-act rc-act--reliquat rc-act--quiet"
                            disabled={isBusy || r.status === "BACKORDER"}
                            onClick={() => actStatus(r, "BACKORDER")}
                          >
                            Reliquat <Hourglass className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            className="rc-act rc-act--nonrecu rc-act--quiet"
                            disabled={isBusy || r.status === "NOT_RECEIVED"}
                            onClick={() => actStatus(r, "NOT_RECEIVED")}
                          >
                            Non reçu <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                    {onReturn && (
                      <td className="rc-th-center">
                        {r.retourImpossible ? (
                          <span className="rt-badge rt-badge--red">
                            <Ban className="h-3.5 w-3.5" /> Retour impossible
                          </span>
                        ) : r.alreadyReturned ? (
                          <span className="rt-badge rt-badge--blue">Déjà retourné</span>
                        ) : (
                          <button
                            type="button"
                            className="rc-act rc-act--retour"
                            onClick={() => onReturn(r)}
                          >
                            Retourner <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={colCount} className="rc-empty-cell">
                    Aucune ligne.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{rows.length} résultat(s)</span>
        </div>
      </section>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="rc-page">
      {/* Header */}
      <header className="rc-header">
        <div>
          <h1 className="rc-title">Suivi des <span className="nc-title-accent">commandes</span></h1>
          <p className="rl-subtitle">Réception des pièces, préparation des commandes clients et livraisons garages.</p>
        </div>
        <div className="rc-header-actions">
          <button
            type="button"
            className="od-btn od-btn--ghost"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 nc-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      {/* Tabs */}
      <div className="rc-tabs">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rc-tab${t.id === tab ? " rc-tab--active" : ""}`}
            >
              <span className="rc-tab-icon">
                <Icon className="h-5 w-5" />
              </span>
              <span className="rc-tab-text">
                <span className="rc-tab-label">
                  {t.label}
                  {t.count !== undefined && (
                    <span className={`rc-tab-count${t.tone && t.count > 0 ? ` rc-tab-count--${t.tone}` : ""}`}>
                      {t.count}
                    </span>
                  )}
                  {t.alert && <span className="rc-tab-alert">{t.alert}</span>}
                </span>
                <span className="rc-tab-sub">{t.sub}</span>
              </span>
            </button>
          );
        })}
      </div>

      {loading && board.length === 0 ? (
        <TableSkeleton rows={7} cols={9} />
      ) : (
        <>
          {/* ---- Pièces à recevoir ---- */}
          {tab === "arecevoir" && (
            <>
              {tours.length > 0 && (
                <div className="rc-tournees">
                  {tours.map((t, i) => {
                    const isTour = t.name.startsWith("Tournée");
                    const color = TOUR_COLORS[i % TOUR_COLORS.length];
                    const active = tourFilter === t.name;
                    return (
                      <button
                        key={t.name}
                        type="button"
                        onClick={() => setTourFilter(active ? null : t.name)}
                        className={`rc-tournee${active ? " rc-tournee--active" : ""}`}
                      >
                        <span
                          className="rc-tournee-icon"
                          style={{ background: `${color}1A`, color }}
                        >
                          <Truck className="h-5 w-5" />
                        </span>
                        <span className="rc-tournee-text">
                          <span className="rc-tournee-label">{t.name}</span>
                          <span className="rc-tournee-sub">
                            {isTour ? "Livraison" : "Livraison externe"}
                          </span>
                        </span>
                        <span className="rc-tournee-count">{t.count}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="rc-kinds">
                {KINDS.map((k) => {
                  const Icon = k.icon;
                  const active = kindFilter === k.id;
                  return (
                    <button
                      key={k.id}
                      type="button"
                      onClick={() => setKindFilter(active ? null : k.id)}
                      className={`rc-kind rc-kind--${k.id.toLowerCase()}${active ? " rc-kind--active" : ""}`}
                    >
                      <Icon className="h-4 w-4" />
                      {k.label}
                      <span className="rc-kind-count">{kindCounts[k.id]}</span>
                    </button>
                  );
                })}
              </div>

              {selectedRows.length > 0 && (
                <div className="rc-bulk">
                  <span className="rc-bulk-label">
                    <ListChecks className="h-4 w-4" />
                    {selectedRows.length} pièce{selectedRows.length > 1 ? "s" : ""} sélectionnée
                    {selectedRows.length > 1 ? "s" : ""} — appliquer la même action :
                  </span>
                  <span className="rc-actions">
                    <button
                      type="button"
                      className="rc-act rc-act--recu"
                      disabled={busy.has("bulk")}
                      onClick={() => actBulk("RECEIVED")}
                    >
                      {busy.has("bulk") ? (
                        <Loader2 className="h-3.5 w-3.5 nc-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Tout reçu
                    </button>
                    <button
                      type="button"
                      className="rc-act rc-act--reliquat"
                      disabled={busy.has("bulk")}
                      onClick={() => actBulk("BACKORDER")}
                    >
                      Reliquat <Hourglass className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rc-act rc-act--nonrecu"
                      disabled={busy.has("bulk")}
                      onClick={() => actBulk("NOT_RECEIVED")}
                    >
                      Non reçu <X className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className="rc-act"
                      disabled={busy.has("bulk")}
                      onClick={() => setSelected(new Set())}
                    >
                      Annuler
                    </button>
                  </span>
                </div>
              )}

              <LinesTable rows={pointerRows} showActions selectable />

              <div className="od-note rc-note">
                <Info className="h-4 w-4" />
                <div className="rc-note-text">
                  <p className="rl-note-strong">
                    Pensez à bien pointer toutes les pièces reçues et à gérer les
                    reliquats pour éviter les oublis.
                  </p>
                  <p className="rl-note-sub">
                    «&nbsp;Reçu&nbsp;» ajoute automatiquement la quantité restante au
                    stock magasin.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ---- Commande SMS ---- */}
          {tab === "sms" && (
            <>
              <div className="rc-sms-filters">
                <button
                  type="button"
                  onClick={() => setSmsFilter("all")}
                  className={`rc-sms-all${smsFilter === "all" ? " rc-sms-all--active" : ""}`}
                >
                  Tous les clients prêts
                  <span className="rc-sms-all-count">{smsOrders.length}</span>
                </button>
                <div className="rc-sms-group">
                  <button
                    type="button"
                    onClick={() => setSmsFilter("complet")}
                    className="rc-sms-seg rc-sms-seg--green"
                  >
                    <span className="rc-sms-seg-top">
                      <span className="rc-sms-seg-dot" />
                      Complet
                      <span className="rc-sms-seg-count">
                        {smsOrders.filter((o) => o.complet).length}
                      </span>
                    </span>
                    <span className="rc-sms-seg-sub">Toutes les pièces reçues</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setSmsFilter("partiel")}
                    className="rc-sms-seg rc-sms-seg--orange"
                  >
                    <span className="rc-sms-seg-top">
                      <span className="rc-sms-seg-dot" />
                      Partiel
                      <span className="rc-sms-seg-count">
                        {smsOrders.filter((o) => !o.complet).length}
                      </span>
                    </span>
                    <span className="rc-sms-seg-sub">Certaines pièces en reliquat</span>
                  </button>
                </div>
              </div>

              <section className="od-card rc-table-card">
                <div className="rc-table-wrap">
                  <table className="rc-table">
                    <thead>
                      <tr>
                        <th>N° CMD / Date</th>
                        <th>Client</th>
                        <th>Véhicule</th>
                        <th>
                          Pièces reçues
                          <span className="rc-th-sub">Reçues / Commandées</span>
                        </th>
                        <th>Statut</th>
                        <th>Dernière pièce reçue</th>
                        <th className="rc-th-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {smsRows.map((o) => {
                        const pct = Math.round((o.received / o.total) * 100);
                        const manque = o.total - o.received;
                        return (
                          <tr key={o.orderId} className="rc-row">
                            <td>
                              <Link
                                href={`/dashboard/commandes/${o.orderId}`}
                                className="rc-cmd"
                              >
                                {o.ref}
                              </Link>
                              <p className="rl-muted">{fmtDay(o.date)}</p>
                            </td>
                            <td>
                              <p className="rl-client">{o.clientName}</p>
                              <p className="rl-muted">{o.clientPhone ?? "—"}</p>
                            </td>
                            <td>
                              <p className="rc-vehicle">{o.vehicle ?? "—"}</p>
                              <p className="rl-muted">{o.plate ?? ""}</p>
                            </td>
                            <td>
                              <div className="rc-prog">
                                <span className="rc-prog-label">
                                  {o.received} / {o.total}
                                </span>
                                <span className="rc-prog-track">
                                  <span
                                    className={`rc-prog-fill rc-prog-fill--${o.complet ? "green" : "orange"}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </span>
                              </div>
                            </td>
                            <td>
                              <div className="rc-statcell">
                                <span
                                  className={`rt-badge rt-badge--${o.complet ? "green" : "amber"}`}
                                >
                                  {o.complet ? "Complet" : "Partiel"}
                                </span>
                                <span className="rc-statcell-sub">
                                  {o.complet
                                    ? "Toutes les pièces reçues"
                                    : `${manque} pièce${manque > 1 ? "s" : ""} en reliquat`}
                                </span>
                              </div>
                            </td>
                            <td>
                              <p className="rc-last">{fmtDayTime(o.lastAt)}</p>
                              <p className="rc-last-sub">{o.lastSupplier ?? ""}</p>
                            </td>
                            <td>
                              <div className="rc-actions">
                                <button
                                  type="button"
                                  className="rc-sms-act rc-sms-act--sms"
                                  disabled={busy.has(`sms-${o.orderId}`)}
                                  onClick={() => actSms(o)}
                                >
                                  <MessageSquare className="h-4 w-4" />
                                  {o.state.sent ? "SMS envoyé" : "SMS"}
                                </button>
                                <button
                                  type="button"
                                  className="rc-sms-act rc-sms-act--traite"
                                  disabled={busy.has(`done-${o.orderId}`)}
                                  onClick={() => actTreated(o)}
                                >
                                  <Check className="h-4 w-4" />
                                  Traité
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!loading && smsRows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="rc-empty-cell">
                            Aucun client à prévenir.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <div className="od-note rc-note">
                <Info className="h-4 w-4" />
                <div className="rc-note-text">
                  <p className="rl-note-strong">
                    Envoyez un SMS au client pour l&apos;informer que ses pièces sont
                    disponibles.
                  </p>
                  <p className="rl-note-sub">
                    Cliquez sur «&nbsp;Traité&nbsp;» une fois le client informé — la
                    commande disparaîtra de cette liste.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ---- Commande à livrer (garages / envoi au livreur) ---- */}
          {tab === "alivrer" && (
            <>
              <div className="rc-sms-filters">
                <button
                  type="button"
                  onClick={() => setLivraisonFilter("all")}
                  className={`rc-sms-all${livraisonFilter === "all" ? " rc-sms-all--active" : ""}`}
                >
                  Toutes les commandes à livrer
                  <span className="rc-sms-all-count">{deliveryOrders.length}</span>
                </button>
                <div className="rc-sms-group">
                  <button
                    type="button"
                    onClick={() => setLivraisonFilter("ready")}
                    className="rc-sms-seg rc-sms-seg--green"
                  >
                    <span className="rc-sms-seg-top">
                      <span className="rc-sms-seg-dot" />
                      Prêtes à envoyer
                      <span className="rc-sms-seg-count">
                        {deliveryOrders.filter((o) => o.stage === "READY").length}
                      </span>
                    </span>
                    <span className="rc-sms-seg-sub">Toutes les pièces au magasin</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLivraisonFilter("transit")}
                    className="rc-sms-seg rc-sms-seg--blue"
                  >
                    <span className="rc-sms-seg-top">
                      <span className="rc-sms-seg-dot" />
                      En cours de livraison
                      <span className="rc-sms-seg-count">
                        {deliveryOrders.filter((o) => o.stage === "TRANSIT").length}
                      </span>
                    </span>
                    <span className="rc-sms-seg-sub">Chez un livreur</span>
                  </button>
                </div>
              </div>

              <section className="od-card rc-table-card">
                <div className="rc-table-wrap">
                  <table className="rc-table">
                    <thead>
                      <tr>
                        <th>N° CMD / Date</th>
                        <th>Garage / Client</th>
                        <th>Véhicule</th>
                        <th>
                          Pièces reçues
                          <span className="rc-th-sub">Reçues / Attendues</span>
                        </th>
                        <th>État</th>
                        <th>Tournée / Livreur</th>
                        <th className="rc-th-center">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveryRows.map((o) => {
                        const pct = o.expected > 0 ? Math.round((o.received / o.expected) * 100) : 0;
                        const busyDeliver = busy.has(`deliver-${o.orderId}`);
                        return (
                          <tr key={o.orderId} className={`rc-row rc-row--${o.isGarage ? "garage" : "client"}`}>
                            <td>
                              <Link href={`/dashboard/commandes/${o.orderId}`} className="rc-cmd">
                                {o.ref}
                              </Link>
                              <p className="rl-muted">{fmtDay(o.date)}</p>
                            </td>
                            <td>
                              <p className="rl-client">
                                {o.clientName}
                                {o.isGarage && (
                                  <span className="rc-type rc-type--garage" style={{ marginLeft: 6 }}>
                                    Garage
                                  </span>
                                )}
                              </p>
                              <p className="rl-muted">{o.clientPhone ?? "—"}</p>
                            </td>
                            <td>
                              <p className="rc-vehicle">{o.vehicle ?? "—"}</p>
                              <p className="rl-muted">{o.plate ?? ""}</p>
                            </td>
                            <td>
                              <div className="rc-prog">
                                <span className="rc-prog-label">
                                  {o.received} / {o.expected}
                                </span>
                                <span className="rc-prog-track">
                                  <span
                                    className={`rc-prog-fill rc-prog-fill--${o.stage === "AWAITING" ? "orange" : "green"}`}
                                    style={{ width: `${pct}%` }}
                                  />
                                </span>
                              </div>
                            </td>
                            <td>
                              <div className="rc-statcell">
                                <span
                                  className={`rt-badge rt-badge--${
                                    o.stage === "TRANSIT" ? "violet" : o.stage === "READY" ? "green" : "amber"
                                  }`}
                                >
                                  {o.stage === "TRANSIT"
                                    ? "En cours de livraison"
                                    : o.stage === "READY"
                                      ? "Prête à envoyer"
                                      : "En attente de réception"}
                                </span>
                                <span className="rc-statcell-sub">
                                  {o.stage === "AWAITING"
                                    ? `${o.missing} pièce${o.missing > 1 ? "s" : ""} pas encore reçue${o.missing > 1 ? "s" : ""}`
                                    : o.stage === "READY"
                                      ? "Le garagiste voit « en préparation »"
                                      : `Départ ${fmtDayTime(o.dateEnvoi)}`}
                                </span>
                              </div>
                            </td>
                            <td>
                              <p className="rc-last">{o.tourName ?? "—"}</p>
                              <p className="rc-last-sub">
                                {o.livreurName ? (
                                  <span className="rc-livreur">
                                    <Truck className="h-3.5 w-3.5" /> {o.livreurName}
                                  </span>
                                ) : (
                                  "Aucun livreur"
                                )}
                              </p>
                            </td>
                            <td>
                              <div className="rc-actions">
                                {o.stage === "TRANSIT" ? (
                                  <>
                                    <button
                                      type="button"
                                      className="rc-sms-act rc-sms-act--traite"
                                      disabled={busyDeliver}
                                      onClick={() => actDelivered(o)}
                                    >
                                      {busyDeliver ? (
                                        <Loader2 className="h-4 w-4 nc-spin" />
                                      ) : (
                                        <Check className="h-4 w-4" />
                                      )}
                                      Livrée
                                    </button>
                                    <button
                                      type="button"
                                      className="rc-act"
                                      onClick={() => openDispatch(o)}
                                      title="Changer de livreur"
                                    >
                                      Changer
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className={`rc-sms-act ${o.stage === "READY" ? "rc-sms-act--sms" : ""}`}
                                    onClick={() => openDispatch(o)}
                                    title={
                                      o.stage === "READY"
                                        ? "Assigner un livreur et partir en livraison"
                                        : "Des pièces manquent encore — envoi partiel possible"
                                    }
                                  >
                                    <Send className="h-4 w-4" />
                                    Envoyer au livreur
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {!loading && deliveryRows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="rc-empty-cell">
                            Aucune commande à livrer.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <div className="od-note rc-note">
                <Info className="h-4 w-4" />
                <div className="rc-note-text">
                  <p className="rl-note-strong">
                    Les commandes garage passent par trois étapes visibles par le garagiste :
                    en attente de réception → en préparation → en cours de livraison.
                  </p>
                  <p className="rl-note-sub">
                    «&nbsp;Envoyer au livreur&nbsp;» assigne un livreur (Livreur 1, 2, 3…) ;
                    «&nbsp;Livrée&nbsp;» clôture la commande. Gérez vos livreurs dans{" "}
                    <Link href="/dashboard/livreurs" className="rc-cmd">Livreurs</Link>.
                  </p>
                </div>
              </div>
            </>
          )}

          {/* ---- Reliquats ---- */}
          {tab === "reliquats" && <LinesTable rows={backorders} showActions />}

          {/* ---- Historique ---- */}
          {tab === "historique" && (
            <>
              <Toast message={returnNotice} onClose={() => setReturnNotice(null)} />
              <div className="rc-hist-toolbar">
                <div className="rt-search">
                  <Search className="h-4 w-4" />
                  <input
                    className="od-input"
                    placeholder="Rechercher une pièce : référence, désignation, n° commande, client, immatriculation…"
                    value={historySearch}
                    onChange={(e) => setHistorySearch(e.target.value)}
                  />
                </div>
                {historySearch && (
                  <button
                    type="button"
                    className="od-btn od-btn--ghost"
                    onClick={() => setHistorySearch("")}
                  >
                    Effacer
                  </button>
                )}
              </div>
              <LinesTable
                rows={historyFiltered}
                showActions={false}
                onReturn={openReturn}
                showHandOver={false}
              />
            </>
          )}

        </>
      )}

      {dispatchOrder && (
        <div
          className="ga-modal-overlay"
          onClick={() => !dispatchBusy && setDispatchOrder(null)}
        >
          <div
            className="ga-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ga-modal-head">
              <span className="ga-modal-title">
                <Truck className="h-4 w-4" />
                Envoyer au livreur
              </span>
              <button
                type="button"
                className="ga-modal-close"
                onClick={() => setDispatchOrder(null)}
                aria-label="Fermer"
                disabled={dispatchBusy}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ga-modal-form">
              {dispatchError && <div className="nc-error">{dispatchError}</div>}
              <div className="rt-picked">
                <div>
                  <p className="rt-order-ref">{dispatchOrder.ref}</p>
                  <p className="rt-order-client">{dispatchOrder.clientName}</p>
                </div>
              </div>
              <div className="od-field">
                <span className="od-label">Livreur <span className="od-req">*</span></span>
                <div className="rc-livreur-pick">
                  {livreurs.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      className={`rc-livreur-opt${dispatchLivreur === l.id ? " rc-livreur-opt--on" : ""}`}
                      onClick={() => setDispatchLivreur(l.id)}
                    >
                      <Truck className="h-4 w-4" />
                      <span>
                        <strong>{l.name}</strong>
                        {l.phone && <em>{l.phone}</em>}
                      </span>
                    </button>
                  ))}
                </div>
                {livreurs.length === 0 && (
                  <span className="st-cmd-hint">
                    Aucun livreur actif. Ajoutez-en un dans{" "}
                    <Link href="/dashboard/livreurs" className="rc-cmd">Livreurs</Link>.
                  </span>
                )}
              </div>
              <div className="ga-modal-actions">
                <button
                  type="button"
                  className="od-btn od-btn--ghost"
                  onClick={() => setDispatchOrder(null)}
                  disabled={dispatchBusy}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  className="od-btn od-btn--primary"
                  onClick={() => void submitDispatch()}
                  disabled={dispatchBusy || !dispatchLivreur}
                >
                  {dispatchBusy ? (
                    <Loader2 className="h-4 w-4 nc-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {dispatchOrder.livreurId ? "Changer de livreur" : "Partir en livraison"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {returnLine && (
        <div
          className="ga-modal-overlay"
          onClick={() => !returnSubmitting && setReturnLine(null)}
        >
          <div
            className="ga-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ga-modal-head">
              <span className="ga-modal-title">
                <RotateCcw className="h-4 w-4" style={{ verticalAlign: "-2px", marginRight: 6 }} />
                {returnLine.fromStock ? "Retourner au fournisseur" : "Retourner une pièce"}
              </span>
              <button
                type="button"
                className="ga-modal-close"
                onClick={() => setReturnLine(null)}
                aria-label="Fermer"
                disabled={returnSubmitting}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="ga-modal-form">
              {returnError && <div className="nc-error">{returnError}</div>}

              <div className="rt-picked">
                <div>
                  <p className="rt-order-ref">
                    {returnLine.orderRef} ·{" "}
                    {returnLine.fromStock
                      ? `Stock magasin → ${returnLine.supplierName ?? "fournisseur"}`
                      : returnLine.clientName}
                  </p>
                  <p className="rt-order-client">
                    <strong>{returnLine.reference}</strong> — {returnLine.designation}
                  </p>
                  <p className="rl-muted">
                    {returnLine.quantity}× {fmtMoney(returnLine.unitPrice)}
                  </p>
                </div>
              </div>

              <div className="od-field">
                <span className="od-label">Motif du retour</span>
                <input
                  className="od-input"
                  placeholder="Pièce non utilisée, erreur de référence…"
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  autoFocus
                />
              </div>

              {!returnLine.fromStock && (
              <div className="od-field">
                <span className="od-label">Compensation</span>
                <div className="od-toggle-group">
                  <button
                    type="button"
                    className={`od-toggle${returnCompensation === "REMBOURSEMENT" ? " od-toggle--on" : ""}`}
                    onClick={() => setReturnCompensation("REMBOURSEMENT")}
                  >
                    <Banknote className="h-5 w-5" />
                    <span>
                      <strong>Remboursement</strong>
                      <em>Le client est remboursé immédiatement</em>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`od-toggle${returnCompensation === "AVOIR" ? " od-toggle--on" : ""}`}
                    onClick={() => setReturnCompensation("AVOIR")}
                  >
                    <FileText className="h-5 w-5" />
                    <span>
                      <strong>Avoir</strong>
                      <em>Bon d&apos;achat valable 1 an</em>
                    </span>
                  </button>
                </div>
              </div>

              )}

              {!returnLine.fromStock && (
                <div className="rt-refund-total">
                  {returnCompensation === "AVOIR" ? "Montant de l'avoir" : "Montant remboursé"}{" "}
                  <strong>{fmtMoney(returnLine.quantity * returnLine.unitPrice)}</strong>
                </div>
              )}

              <div className="ga-modal-actions">
                <button
                  type="button"
                  className="od-btn od-btn--ghost"
                  onClick={() => setReturnLine(null)}
                  disabled={returnSubmitting}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  className="od-btn od-btn--primary"
                  onClick={() => void submitReturn()}
                  disabled={returnSubmitting}
                >
                  {returnSubmitting ? (
                    <Loader2 className="h-4 w-4 nc-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  {returnSubmitting
                    ? "Enregistrement…"
                    : !returnLine.fromStock && returnCompensation === "AVOIR"
                      ? "Émettre l'avoir"
                      : "Valider le retour"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
