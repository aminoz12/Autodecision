"use client";

import {
  AlertTriangle,
  Banknote,
  Box,
  Building2,
  Check,
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
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { loadStaffNames } from "@/lib/data/tablet";
import {
  backorderLines,
  deliveryOrdersOf,
  lineKind,
  lineMatches,
  pendingLines,
  prepareOrdersOf,
  toursOf,
  type LineKind,
} from "@/lib/commandes-board";
import { fmtDay, fmtDayTime, LinesTable, STATUT, type LinesTableContext } from "@/components/orders/LinesTable";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { Toast } from "@/components/ui/Toast";
import { ShelfCell, type Shelf } from "@/components/sav/ShelfCell";
import { flushClientMessages, loadOrderShelves } from "@/lib/data/sav";
import { parisDate } from "@/lib/data/tournees";
import { createClient } from "@/lib/supabase/client";
import { createWalkInReturn, deductionMessage, loadOrganizationSettings, markLineReceived } from "@/lib/data/saas";
import { buildClientSms, formatE164, toE164, type SmsSettings } from "@/lib/sms";
import { updateClientAddress } from "@/lib/data/delivery";
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
  setLineHandedOver,
  setLineReceptionStatus,
  type BoardLine,
  type ReceptionStatus,
  type SmsState,
} from "@/lib/data/commandes";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const TOUR_COLORS = ["#3B82F6", "#EF4444", "#F59E0B", "#10B981", "#7C3AED"];

function fmtMoney(v: number): string {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

/** What the client gets for a returned part (DEDUCTION = « Déduire de l'encours », migration 20261005010000). */
type ReturnCompensation = "REMBOURSEMENT" | "AVOIR" | "DEDUCTION";

const KINDS: { id: LineKind; label: string; icon: LucideIcon }[] = [
  { id: "CLIENT", label: "Client", icon: User },
  { id: "GARAGE", label: "Garages", icon: Building2 },
  { id: "STOCK", label: "Retour en stock", icon: Box },
];

/** One row of « Commande à préparer », as handed to the SMS modal. */
type SmsOrderRow = {
  orderId: string;
  ref: string;
  clientId: string | null;
  clientName: string;
  clientPhone: string | null;
  complet: boolean;
  received: number;
  total: number;
  state: SmsState;
};

const NO_SMS_SETTINGS: SmsSettings = { magasin: "", horaires: null, readyTemplate: null, partialTemplate: null };

export default function ReceptionCommandesPage() {
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;

  const [board, setBoard] = useState<BoardLine[]>([]);
  const [sms, setSms] = useState<Map<string, SmsState>>(new Map());
  /** Who pointed what (« par Sofia · … »), migration 20261005020000. */
  const [staffNames, setStaffNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const [tab, setTab] = useState(() => {
    if (typeof window === "undefined") return "arecevoir";
    const raw = new URLSearchParams(window.location.search).get("tab");
    // Deep links (notifications, after-sales KPIs) say "apreparer"; the tab id stayed "sms".
    const wanted = raw === "apreparer" ? "sms" : raw;
    return wanted && ["arecevoir", "sms", "alivrer", "reliquats", "historique"].includes(wanted)
      ? wanted
      : "arecevoir";
  });
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
    clientId: string | null;
    address: string | null;
    city: string | null;
  } | null>(null);
  const [dispatchLivreur, setDispatchLivreur] = useState("");
  /** Delivery address, editable in the dispatch modal (saved on the client). */
  const [dispatchAddress, setDispatchAddress] = useState("");
  const [dispatchCity, setDispatchCity] = useState("");
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /* ---- SMS « commande prête » modal ---- */
  const [smsSettings, setSmsSettings] = useState<SmsSettings>(NO_SMS_SETTINGS);
  const [smsOrder, setSmsOrder] = useState<SmsOrderRow | null>(null);
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [b, s, l, org, names] = await Promise.all([
        loadReceptionBoard(supabase, orgId),
        loadSmsStates(supabase, orgId),
        loadLivreurs(supabase, orgId, { activeOnly: true }),
        // Wording of the client SMS; the defaults apply if the profile can't be read.
        loadOrganizationSettings(supabase, orgId).catch(() => null),
        loadStaffNames(supabase),
      ]);
      setBoard(b);
      setStaffNames(names);
      setSms(s);
      setLivreurs(l);
      if (org) {
        setSmsSettings({
          magasin: org.name,
          horaires: org.smsHoraires,
          readyTemplate: org.smsReadyTemplate,
          partialTemplate: org.smsPartialTemplate,
        });
      }
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
  const pending = useMemo(() => pendingLines(board), [board]);
  const backorders = useMemo(() => backorderLines(board), [board]);
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
  const historyFiltered = useMemo(() => history.filter((l) => lineMatches(l, historySearch)), [history, historySearch]);

  const [returnLine, setReturnLine] = useState<BoardLine | null>(null);
  const [returnReason, setReturnReason] = useState("");
  /** The compensation the cashier clicked; null = not touched yet, the default below applies. */
  const [returnChoice, setReturnChoice] = useState<ReturnCompensation | null>(null);
  /** What is still due on the order of the returned line (null until loaded). */
  const [returnOrderDue, setReturnOrderDue] = useState<number | null>(null);
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(null);
  const [returnNotice, setReturnNotice] = useState<string | null>(null);

  /**
   * A stock line that has a supplier goes back to that supplier. A part sold
   * from the shelf with no supplier on the line is a client return like any other
   * (it used to be sent as a supplier return and was always refused).
   */
  const supplierReturn = !!returnLine?.fromStock && !!returnLine?.supplierId;

  /**
   * A garage, or a client whose order is not fully paid, gets the return taken off
   * what he owes: refunding cash would hand back money that never came in. The
   * order balance arrives after the modal opens and only moves the default — a
   * choice the cashier already made is kept.
   */
  const returnCompensation: ReturnCompensation =
    returnChoice ??
    (returnLine?.clientId && (returnLine.isGarage || (returnOrderDue ?? 0) > 0)
      ? "DEDUCTION"
      : "REMBOURSEMENT");

  const openReturn = useCallback((line: BoardLine) => {
    setReturnLine(line);
    setReturnReason("");
    setReturnChoice(null);
    setReturnOrderDue(null);
    setReturnError(null);
    setReturnNotice(null);
  }, []);

  // Balance of the order being returned (errors ignored: the hints just stay hidden).
  const returnOrderId = returnLine?.orderId ?? null;
  useEffect(() => {
    if (!returnOrderId) return;
    let alive = true;
    void supabase
      .from("orders")
      .select("solde_restant")
      .eq("id", returnOrderId)
      .maybeSingle()
      .then(({ data }) => {
        const row = data as { solde_restant?: number | string | null } | null;
        if (alive && row) setReturnOrderDue(Math.max(0, Number(row.solde_restant) || 0));
      });
    return () => {
      alive = false;
    };
  }, [supabase, returnOrderId]);

  const submitReturn = useCallback(async () => {
    if (!orgId || !returnLine) return;
    setReturnSubmitting(true);
    setReturnError(null);
    try {
      const { avoirNum, deduction } = await createWalkInReturn(supabase, orgId, {
        orderId: returnLine.orderId,
        clientId: returnLine.clientId,
        reason: returnReason,
        // A stock part goes back to its supplier: no client compensation.
        compensation: supplierReturn ? "FOURNISSEUR" : returnCompensation,
        supplierId: returnLine.supplierId,
        lines: [
          {
            id: returnLine.id,
            reference: returnLine.reference,
            designation: returnLine.designation,
            fromStock: returnLine.fromStock,
            remainingQuantity: returnLine.quantity,
            quantity: returnLine.quantity,
            unitPrice: returnLine.unitPrice,
            lineTotal: returnLine.quantity * returnLine.unitPrice,
            retourImpossible: returnLine.retourImpossible,
            alreadyReturned: returnLine.alreadyReturned,
          },
        ],
      });
      setReturnNotice(
        supplierReturn
          ? `Retour fournisseur enregistré — ${returnLine.reference} à traiter dans Retours.`
          : returnCompensation === "DEDUCTION"
            ? deduction
              ? `Retour enregistré — ${deductionMessage(deduction)}`
              : `Retour enregistré — ${returnLine.reference} déduit de l'encours.`
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
  }, [orgId, returnLine, returnReason, returnCompensation, supplierReturn, supabase, load]);

  // Group by tournée name (derived tournées have no tour_id but a real name).
  const tours = useMemo(() => toursOf(pending), [pending]);

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
  const deliveryOrders = useMemo(() => deliveryOrdersOf(board), [board]);
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
  const smsOrders = useMemo(() => prepareOrdersOf(board, sms), [board, sms]);


  const smsRows = useMemo(
    () =>
      smsFilter === "all"
        ? smsOrders
        : smsOrders.filter((o) => (smsFilter === "complet" ? o.complet : !o.complet)),
    [smsOrders, smsFilter],
  );

  // Après-vente : casier de retrait et date promise (à préparer), date promise
  // seule sur les pièces à recevoir / reliquats. Empty maps, hence nothing
  // shown, before the SAV migration.
  const [shelves, setShelves] = useState<Map<string, Shelf>>(new Map());
  const smsOrderIds = useMemo(() => smsOrders.map((o) => o.orderId).join(","), [smsOrders]);
  const boardOrderIds = useMemo(() => [...new Set(board.map((l) => l.orderId))].join(","), [board]);
  const allOrderIds = useMemo(
    () => [...new Set([...(smsOrderIds ? smsOrderIds.split(",") : []), ...(boardOrderIds ? boardOrderIds.split(",") : [])])].join(","),
    [smsOrderIds, boardOrderIds],
  );
  useEffect(() => {
    if (!orgId || !allOrderIds) return;
    let alive = true;
    void loadOrderShelves(supabase, orgId, allOrderIds.split(","))
      .then((m) => {
        if (alive) setShelves(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [supabase, orgId, allOrderIds]);
  /** « Promis le … » under an order ref on the reception board; red once the date is past and nothing is ready. */
  const promiseNote = (orderId: string) => {
    const s = shelves.get(orderId);
    const date = s?.promiseRevisedDate ?? s?.promisedDate;
    if (!date) return null;
    const late = !s?.readyAt && date < parisDate();
    return (
      <p className={`sav-promise${late ? " sav-promise--late" : ""}`}>
        Promis le {fmtDay(date)}
        {s?.promiseRevisedDate && s.promiseRevisedDate !== s.promisedDate ? " (décalé)" : ""}
      </p>
    );
  };

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

  /** Réception partielle: which line has its quantity input open. */
  const [partial, setPartial] = useState<{ lineId: string; qty: string } | null>(null);

  // Without qty every missing unit is received; with qty only that many and
  // the line stays expected for the rest (statut « Reçu partiel »).
  const actReceive = (line: BoardLine, qty?: number) =>
    withBusy(line.id, async () => {
      if (!orgId) return;
      const missing = Math.max(0, line.quantity - line.received);
      if (qty != null && (qty < 1 || qty > missing)) {
        throw new Error(`Quantité invalide : il reste ${missing} pièce(s) à recevoir.`);
      }
      await markLineReceived(
        supabase,
        orgId,
        {
          id: line.id,
          reference: line.reference,
          designation: line.designation,
          quantity: line.quantity,
          receivedQuantity: line.received,
        },
        qty,
      );
      flushClientMessages(); // « commande prête » queued by the database, if the magasin switched it on
      const now = new Date().toISOString();
      const received = qty == null ? line.quantity : Math.min(line.quantity, line.received + qty);
      setPartial(null);
      setBoard((prev) =>
        prev.map((l) =>
          l.id === line.id
            ? { ...l, status: received >= l.quantity ? "RECEIVED" : "PARTIAL", received, receivedAt: now }
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
      if (status === "BACKORDER") flushClientMessages(); // « retard fournisseur »
      setBoard((prev) =>
        prev.map((l) => (l.id === line.id ? { ...l, status } : l)),
      );
    });

  /** Opens the confirmation modal: recipient, exact text, cost in SMS. */
  const openSms = (o: SmsOrderRow) => {
    setSmsError(null);
    setSmsOrder(o);
  };

  const smsPreview = useMemo(() => {
    if (!smsOrder) return null;
    const built = buildClientSms(
      smsOrder.complet ? "READY" : "PARTIAL",
      // "Client comptoir" is a placeholder, not a name.
      { client: smsOrder.clientId ? smsOrder.clientName : "", commande: smsOrder.ref },
      smsSettings,
    );
    return { to: toE164(smsOrder.clientPhone), ...built };
  }, [smsOrder, smsSettings]);

  const sendSms = async () => {
    if (!smsOrder || !orgId) return;
    setSmsBusy(true);
    setSmsError(null);
    try {
      // The server resolves the number from the order, builds the same text
      // from the magasin settings, sends through Twilio (or simulates when no
      // provider is configured) and records the send.
      const res = await fetch("/api/send-sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: smsOrder.orderId, kind: smsOrder.complet ? "READY" : "PARTIAL" }),
      });
      const sent = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        simulated?: boolean;
        to?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(sent.error ?? "Envoi du SMS impossible.");
      setNotice(
        sent.simulated
          ? `SMS enregistré pour ${smsOrder.clientName} (mode simulation : renseignez TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN et TWILIO_FROM pour l'envoi réel).`
          : `SMS envoyé à ${smsOrder.clientName} (${formatE164(sent.to ?? "")}).`,
      );
      const orderId = smsOrder.orderId;
      setSms((prev) => {
        const next = new Map(prev);
        const cur = next.get(orderId) ?? { sent: false, treated: false };
        next.set(orderId, { ...cur, sent: true });
        return next;
      });
      setSmsOrder(null);
    } catch (e) {
      setSmsError(e instanceof Error ? e.message : String(e));
    } finally {
      setSmsBusy(false);
    }
  };

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
      if (status === "RECEIVED" || status === "BACKORDER") flushClientMessages();
      await load();
    });

  /* ---- dispatch / delivered ---- */
  const openDispatch = (o: (typeof deliveryOrders)[number]) => {
    setDispatchOrder({
      orderId: o.orderId,
      ref: o.ref,
      clientName: o.clientName,
      livreurId: o.livreurId,
      clientId: o.clientId,
      address: o.address,
      city: o.city,
    });
    const active = (id: string | null) => (id && livreurs.some((l) => l.id === id) ? id : null);
    setDispatchLivreur(active(o.livreurId) ?? active(o.tourLivreurId) ?? livreurs[0]?.id ?? "");
    setDispatchAddress(o.address ?? "");
    setDispatchCity(o.city ?? "");
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
      const { clientId, address, city } = dispatchOrder;
      if (
        orgId &&
        clientId &&
        (dispatchAddress.trim() !== (address ?? "") || dispatchCity.trim() !== (city ?? ""))
      ) {
        await updateClientAddress(supabase, orgId, clientId, { address: dispatchAddress, city: dispatchCity });
      }
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

  /* ---- shared by every line table ---- */
  const tableCtx: LinesTableContext = {
    loading,
    busy,
    selected,
    allVisibleSelected,
    toggleSelectAll,
    toggleSelect,
    handedByOrder,
    partial,
    setPartial,
    actReceive,
    actHandOver,
    actStatus,
    promiseNote,
    staffNames,
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="rc-page">
      {/* Header */}
      <header className="rc-header">
        <div>
          <h1 className="rc-title">Suivi des commandes</h1>
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

              <LinesTable ctx={tableCtx} rows={pointerRows} showActions selectable />

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
                              {shelves.has(o.orderId) && (
                                <ShelfCell
                                  orderId={o.orderId}
                                  shelf={shelves.get(o.orderId) as Shelf}
                                  onSaved={(casier) =>
                                    setShelves((prev) => {
                                      const next = new Map(prev);
                                      const cur = next.get(o.orderId);
                                      if (cur) next.set(o.orderId, { ...cur, casier });
                                      return next;
                                    })
                                  }
                                />
                              )}
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
                                  onClick={() => openSms(o)}
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
                              {o.address || o.city ? (
                                <p className="rl-muted">{[o.address, o.city].filter(Boolean).join(", ")}</p>
                              ) : (
                                <span className="rc-addr-missing">Adresse manquante</span>
                              )}
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
                                {o.failedReason && o.attempts > 0 && (
                                  <span className="rc-fail-note">
                                    <AlertTriangle className="h-3.5 w-3.5" />
                                    {o.stage === "TRANSIT" ? `${o.attempts + 1}ᵉ passage — dernier échec` : "Non livrée"} : {o.failedReason}
                                  </span>
                                )}
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
          {tab === "reliquats" && <LinesTable ctx={tableCtx} rows={backorders} showActions />}

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
                ctx={tableCtx}
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
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Adresse de livraison</span>
                  <input
                    className="od-input"
                    value={dispatchAddress}
                    onChange={(e) => setDispatchAddress(e.target.value)}
                    placeholder="12 rue des Garages"
                    disabled={!dispatchOrder.clientId || dispatchBusy}
                  />
                </div>
                <div className="od-field">
                  <span className="od-label">Ville</span>
                  <input
                    className="od-input"
                    value={dispatchCity}
                    onChange={(e) => setDispatchCity(e.target.value)}
                    placeholder="Nanterre"
                    disabled={!dispatchOrder.clientId || dispatchBusy}
                  />
                </div>
              </div>
              {!dispatchAddress.trim() && (
                <p className="st-cmd-hint rc-addr-hint">
                  Sans adresse, le livreur n&apos;aura pas d&apos;itinéraire et devra appeler le client.
                  {dispatchOrder.clientId ? " Saisissez-la ici : elle est enregistrée sur la fiche." : ""}
                </p>
              )}
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

      {smsOrder && smsPreview && (
        <div className="ga-modal-overlay" onClick={() => !smsBusy && setSmsOrder(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title">
                <MessageSquare className="h-4 w-4" />
                Prévenir le client par SMS
              </span>
              <button
                type="button"
                className="ga-modal-close"
                onClick={() => setSmsOrder(null)}
                aria-label="Fermer"
                disabled={smsBusy}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ga-modal-form">
              {smsError && <div className="nc-error">{smsError}</div>}
              <div className="rt-picked">
                <div>
                  <p className="rt-order-ref">{smsOrder.ref}</p>
                  <p className="rt-order-client">{smsOrder.clientName}</p>
                </div>
                <span className={`rt-badge rt-badge--${smsOrder.complet ? "green" : "amber"}`}>
                  {smsOrder.complet ? "Complet" : `Partiel · ${smsOrder.received}/${smsOrder.total}`}
                </span>
              </div>
              <div className="sms-to">
                <span className="od-label">Destinataire</span>
                {smsPreview.to ? (
                  <strong>{formatE164(smsPreview.to)}</strong>
                ) : (
                  <span className="sms-to-bad">
                    <AlertTriangle className="h-4 w-4" />
                    Numéro invalide : {smsOrder.clientPhone ?? "aucun numéro"}
                  </span>
                )}
              </div>
              <div className="od-field">
                <span className="od-label">Message</span>
                <div className="sms-bubble">{smsPreview.text}</div>
                <span className="sms-meta">
                  {smsPreview.size.chars} caractères · {smsPreview.size.segments} SMS
                  {smsPreview.size.encoding === "UCS-2" ? " (caractères spéciaux : 70 par SMS)" : ""}
                </span>
              </div>
              <p className="st-cmd-hint">
                {smsOrder.state.sent ? "Un SMS a déjà été envoyé pour cette commande ; vous pouvez le renvoyer. " : ""}
                Texte et horaires se règlent dans{" "}
                <Link href="/dashboard/parametres" className="rc-cmd">Paramètres → SMS aux clients</Link>.
              </p>
              <div className="ga-modal-actions">
                <button
                  type="button"
                  className="od-btn od-btn--ghost"
                  onClick={() => setSmsOrder(null)}
                  disabled={smsBusy}
                >
                  Annuler
                </button>
                <button
                  type="button"
                  className="od-btn od-btn--primary"
                  onClick={() => void sendSms()}
                  disabled={smsBusy || !smsPreview.to}
                >
                  {smsBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Send className="h-4 w-4" />}
                  Envoyer le SMS
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
                {supplierReturn ? "Retourner au fournisseur" : "Retourner une pièce"}
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
                    {supplierReturn
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

              {!supplierReturn && (
              <div className="od-field">
                <span className="od-label">Compensation</span>
                <div className="od-toggle-group">
                  <button
                    type="button"
                    className={`od-toggle${returnCompensation === "REMBOURSEMENT" ? " od-toggle--on" : ""}`}
                    onClick={() => setReturnChoice("REMBOURSEMENT")}
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
                    onClick={() => setReturnChoice("AVOIR")}
                  >
                    <FileText className="h-5 w-5" />
                    <span>
                      <strong>Avoir</strong>
                      <em>Bon d&apos;achat valable 1 an</em>
                    </span>
                  </button>
                  {returnLine.clientId && (
                    <button
                      type="button"
                      className={`od-toggle${returnCompensation === "DEDUCTION" ? " od-toggle--on" : ""}`}
                      onClick={() => setReturnChoice("DEDUCTION")}
                    >
                      <Wallet className="h-5 w-5" />
                      <span>
                        <strong>Déduire de l&apos;encours</strong>
                        <em>Retiré de ce que le client doit</em>
                      </span>
                    </button>
                  )}
                </div>
                {returnCompensation === "DEDUCTION" && (
                  <span className="st-cmd-hint">
                    Le montant est retiré de ce que le client doit : cette commande d&apos;abord, puis ses
                    autres commandes à régler. Ce qui dépasse devient un avoir.
                    {returnOrderDue != null &&
                      (returnOrderDue > 0
                        ? ` ${fmtMoney(returnOrderDue)} restent dus sur cette commande.`
                        : " Cette commande est déjà réglée.")}
                  </span>
                )}
                {returnCompensation === "REMBOURSEMENT" && returnOrderDue != null && returnOrderDue > 0 && (
                  <p className="nc-hint" style={{ marginTop: 4 }}>
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>
                      {fmtMoney(returnOrderDue)} restent dus sur cette commande : rembourser rendrait de
                      l&apos;argent qui n&apos;a pas été payé.
                      {returnLine.clientId ? " Préférez « Déduire de l'encours »." : ""}
                    </span>
                  </p>
                )}
              </div>

              )}

              {!supplierReturn && (
                <div className="rt-refund-total">
                  {returnCompensation === "AVOIR"
                    ? "Montant de l'avoir"
                    : returnCompensation === "DEDUCTION"
                      ? "Montant déduit"
                      : "Montant remboursé"}{" "}
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
                    : !supplierReturn && returnCompensation === "AVOIR"
                      ? "Émettre l'avoir"
                      : !supplierReturn && returnCompensation === "DEDUCTION"
                        ? "Déduire de l'encours"
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
