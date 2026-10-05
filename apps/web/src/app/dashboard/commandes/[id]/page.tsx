"use client";

import {
  Calendar,
  Car,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Hourglass,
  Info,
  Mail,
  Package,
  Phone,
  Printer,
  ScrollText,
  Truck,
  User,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAuth } from "@/components/providers/AuthProvider";
import { OrderTicket, OrderTicketCopies, type TicketData } from "@/components/print/OrderTicket";
import { OrderSavPanel } from "@/components/sav/OrderSavPanel";
import { loadSavSettingsSafe } from "@/lib/data/sav";
import { printTicket } from "@/lib/print-ticket";
import { RETURN_CONDITIONS_TEXT } from "@/lib/return-conditions";
import { createClient } from "@/lib/supabase/client";
import { workflowLabel } from "@/lib/data/dashboard";
import {
  cancelOrder,
  loadOrderDetail,
  setLineHandedOver,
  type OrderDetail,
  type OrderDetailLine,
  type ReceptionStatus,
} from "@/lib/data/commandes";
import { loadOrganizationSettings, type OrganizationSettings } from "@/lib/data/saas";
import {
  loadOrderPayments,
  PAYMENT_MODE_LABEL,
  PAYMENT_MODES,
  recordOrderPayment,
  type Payment,
  type PaymentMode,
} from "@/lib/data/payments";
import { Ban, Banknote, HandCoins, Loader2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { emitInvoice, loadOrderInvoice, type Invoice } from "@/lib/data/invoices";
import { proofUrl } from "@/lib/data/delivery";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const LINE_STATUT: Record<
  ReceptionStatus,
  { label: string; cls: string; icon: LucideIcon }
> = {
  PENDING: { label: "En attente", cls: "attente", icon: Clock },
  RECEIVED: { label: "Reçu", cls: "recu", icon: CheckCircle2 },
  PARTIAL: { label: "Reçu partiel", cls: "reliquat", icon: Hourglass },
  BACKORDER: { label: "Reliquat", cls: "reliquat", icon: Hourglass },
  NOT_RECEIVED: { label: "Non reçu", cls: "nonrecu", icon: XCircle },
};

const PAIEMENT_LABEL: Record<string, { label: string; type: "success" | "info" | "warning" }> = {
  "PAYÉ": { label: "Payé", type: "success" },
  PARTIEL: { label: "Acompte", type: "warning" },
  "NON_PAYÉ": { label: "Non payé", type: "warning" },
};

const MODE_PAIEMENT_LABEL: Record<string, string> = {
  ESPECES: "Espèces",
  CARTE: "Carte bancaire",
  VIREMENT: "Virement",
  CHEQUE: "Chèque",
  EN_COMPTE: "En compte (garage)",
};

const LIVREUR_LABEL: Record<string, string> = {
  EN_ATTENTE: "En attente",
  EN_COURS: "En cours",
  "LIVRÉ": "Livré",
};

function eur(value: number): string {
  return `${value.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR");
}

function fmtDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

/** The bon de commande of an existing order, as it was printed at the counter. */
function ticketOf(order: OrderDetail, returnPolicy: string | null): TicketData {
  return {
    ref: order.ref,
    createdAt: order.createdAt ?? (order.date ? `${order.date}T00:00:00` : new Date().toISOString()),
    vendeur: order.vendeurName && order.vendeurName !== "—" ? order.vendeurName : null,
    tourName: order.lines.find((l) => l.tourName)?.tourName ?? null,
    deliveryAt: order.dateEnvoi,
    clientName: order.clientName,
    clientPhone: order.clientPhone,
    plate: order.plate,
    vehicleModel: order.vehicle,
    kilometrage: order.kilometrage,
    lines: order.lines.map((l) => ({
      reference: l.reference,
      designation: l.designation,
      quantity: l.quantity,
      prixVente: l.prixVente,
      retourPossible: !l.retourImpossible,
      taken: l.fromStock && l.quantity > 0 && l.handedOver >= l.quantity,
    })),
    total: order.total,
    avoirApplique: order.avoirApplique,
    paye: order.paye + order.avance,
    reste: order.solde,
    statutPaiement: order.statutPaiement,
    modePaiement: order.modePaiement,
    echeance: order.echeance,
    promisedDate: null,
    returnPolicy: returnPolicy || RETURN_CONDITIONS_TEXT,
    consigneDeadline: null,
  };
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params?.id ?? "";
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [org, setOrg] = useState<OrganizationSettings | null>(null);
  /** The ticket being printed (bon de commande or bon de livraison, 80 mm). */
  const [printMode, setPrintMode] = useState<"bl" | "ticket" | null>(null);
  const printRef = useRef<HTMLDivElement>(null);
  /** Return policy printed at the foot of the bon de commande (Paramètres → Après-vente). */
  const [returnPolicy, setReturnPolicy] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.organization_id) return;
    loadOrganizationSettings(supabase, profile.organization_id)
      .then(setOrg)
      .catch(() => {});
    loadSavSettingsSafe(supabase)
      .then((s) => setReturnPolicy(s.available ? s.settings.returnPolicyText || null : null))
      .catch(() => {});
  }, [supabase, profile?.organization_id]);

  /** Renders the ticket, hands it to the 80 mm one-page print (lib/print-ticket.ts), then drops it. */
  const printDoc = useCallback(
    (mode: "bl" | "ticket") => {
      if (!order) return;
      flushSync(() => setPrintMode(mode));
      printTicket(
        mode === "ticket" ? order.ref : `${order.ref}-bon-livraison`,
        printRef.current,
      );
      setPrintMode(null);
    },
    [order],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* ---- Remise au client (units handed over) ---- */
  const [handing, setHanding] = useState<{ lineId: string; qty: string } | null>(null);
  const [handBusy, setHandBusy] = useState(false);
  const [handError, setHandError] = useState<string | null>(null);

  /* ---- Encaissement ---- */
  const [payments, setPayments] = useState<Payment[]>([]);
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMode, setPayMode] = useState<PaymentMode>("ESPECES");
  const [payRef, setPayRef] = useState("");
  const [payNote, setPayNote] = useState("");
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [payNotice, setPayNotice] = useState<string | null>(null);

  /* ---- Facture (document immuable) ---- */
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState(false);

  /* ---- Annulation ---- */
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelMode, setCancelMode] = useState<PaymentMode>("ESPECES");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  useEffect(() => {
    if (!profile?.organization_id || !orderId) return;
    let cancelled = false;
    loadOrderInvoice(supabase, profile.organization_id, orderId)
      .then((i) => {
        if (!cancelled) setInvoice(i);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supabase, profile?.organization_id, orderId, reloadKey]);
  const doEmitInvoice = useCallback(async () => {
    setInvoiceBusy(true);
    try {
      const id = await emitInvoice(supabase, orderId);
      router.push(`/dashboard/factures/${id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setInvoiceBusy(false);
    }
  }, [supabase, orderId, router]);

  const openPay = useCallback((balance: number) => {
    setPayAmount(balance > 0 ? balance.toFixed(2) : "");
    setPayMode("ESPECES");
    setPayRef("");
    setPayNote("");
    setPayError(null);
    setPayOpen(true);
  }, []);

  const submitPay = useCallback(async () => {
    const amount = Math.round(Number(String(payAmount).replace(",", ".")) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0) {
      setPayError("Indiquez le montant encaissé.");
      return;
    }
    setPayBusy(true);
    setPayError(null);
    try {
      await recordOrderPayment(supabase, { orderId, amount, mode: payMode, reference: payRef, note: payNote });
      setPayOpen(false);
      setPayNotice(`${amount.toLocaleString("fr-FR", { minimumFractionDigits: 2 })} € encaissés (${PAYMENT_MODE_LABEL[payMode].toLowerCase()}).`);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setPayBusy(false);
    }
  }, [supabase, orderId, payAmount, payMode, payRef, payNote]);

  useEffect(() => {
    if (!profile?.organization_id || !orderId) return;
    let cancelled = false;
    loadOrderPayments(supabase, profile.organization_id, orderId)
      .then((p) => {
        if (!cancelled) setPayments(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supabase, profile?.organization_id, orderId, reloadKey]);

  const openHanding = useCallback((l: OrderDetailLine) => {
    // Default: everything the client can take right now (on the shelf, or
    // already received from the supplier).
    const available = l.fromStock ? l.quantity : Math.min(l.quantity, l.received);
    const suggested = Math.max(l.handedOver, Math.min(l.quantity, available));
    setHanding({ lineId: l.id, qty: String(suggested > 0 ? suggested : l.quantity) });
    setHandError(null);
  }, []);

  const submitHanding = useCallback(
    async (l: OrderDetailLine) => {
      if (!profile?.organization_id || !handing) return;
      const qty = Number(handing.qty);
      if (!Number.isFinite(qty) || qty < 0 || qty > l.quantity) {
        setHandError(`Indiquez une quantité entre 0 et ${l.quantity}.`);
        return;
      }
      setHandBusy(true);
      setHandError(null);
      try {
        await setLineHandedOver(supabase, profile.organization_id, l.id, qty);
        setHanding(null);
        setReloadKey((k) => k + 1);
      } catch (e) {
        setHandError(e instanceof Error ? e.message : String(e));
      } finally {
        setHandBusy(false);
      }
    },
    [profile?.organization_id, handing, supabase],
  );

  useEffect(() => {
    if (!profile?.organization_id || !orderId) return;
    let cancelled = false;
    if (reloadKey === 0) setLoading(true);
    loadOrderDetail(supabase, profile.organization_id, orderId)
      .then((o) => {
        if (!cancelled) setOrder(o);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, profile?.organization_id, orderId, reloadKey]);

  /* ---- Preuve de livraison (photo privée, URL signée 1 h) ---- */
  const podPath = order?.delivery.podPath ?? null;
  /** undefined = loading, null = unavailable. */
  const [podUrl, setPodUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!podPath) return;
    let cancelled = false;
    proofUrl(supabase, podPath)
      .then((u) => {
        if (!cancelled) setPodUrl(u);
      })
      .catch(() => {
        if (!cancelled) setPodUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, podPath]);

  /* ---- Loading / error / not found ---- */
  if (loading) {
    return (
      <div className="od-page">
        <div className="od-card rc-empty">
          <p>Chargement de la commande…</p>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="od-page">
        <nav className="od-breadcrumb">
          <Link href="/dashboard">Tableau de bord</Link>
          <span className="od-breadcrumb-sep">
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
          <Link href="/dashboard/commandes">Commandes</Link>
        </nav>
        <div className="od-card rc-empty">
          <p>{error ?? "Commande introuvable."}</p>
        </div>
      </div>
    );
  }

  const wf = workflowLabel(order.workflow);
  const pay = PAIEMENT_LABEL[order.statutPaiement] ?? {
    label: order.statutPaiement,
    type: "info" as const,
  };
  const linesTotal = order.lines.reduce((s, l) => s + l.total, 0);
  const cashed = order.paye + order.avance;
  // Cancellation is only possible while nothing irreversible happened:
  // not delivered, not invoiced, no unit handed to the client.
  const canCancel =
    !order.cancelledAt &&
    order.workflow !== "DELIVERED" &&
    !invoice &&
    !order.lines.some((l) => l.handedOver > 0);

  async function submitCancel() {
    if (!cancelReason.trim()) {
      setCancelError("Indiquez le motif de l'annulation.");
      return;
    }
    setCancelBusy(true);
    setCancelError(null);
    try {
      await cancelOrder(supabase, {
        orderId,
        reason: cancelReason.trim(),
        refundMode: cashed > 0 ? cancelMode : null,
      });
      setCancelOpen(false);
      setCancelReason("");
      setReloadKey((k) => k + 1);
    } catch (e) {
      setCancelError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelBusy(false);
    }
  }

  return (
    <div className="od-page">
      {/* Breadcrumb */}
      <nav className="od-breadcrumb">
        <Link href="/dashboard">Tableau de bord</Link>
        <span className="od-breadcrumb-sep">
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
        <Link href="/dashboard/commandes">Commandes</Link>
        <span className="od-breadcrumb-sep">
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
        <span className="od-breadcrumb-current">{order.ref}</span>
      </nav>

      {/* Title row */}
      <div className="od-title-row">
        <div>
          <h1 className="od-title">
            {order.ref}
            {order.cancelledAt ? (
              <span className="status-badge status-badge--warning">Annulée</span>
            ) : (
              <span className={`status-badge status-badge--${wf.type}`}>{wf.label}</span>
            )}
          </h1>
          <div className="od-meta">
            <span className="od-meta-item">
              <Calendar className="h-4 w-4" />
              {fmtDate(order.date)}
            </span>
            <span className="od-meta-item">
              <User className="h-4 w-4" />
              Vendeur : {order.vendeurName}
            </span>
            <span className="od-meta-item">
              <Package className="h-4 w-4" />
              Canal : {order.canal}
            </span>
          </div>
        </div>
        <div className="od-title-actions">
          <button type="button" className="od-btn od-btn--ghost" onClick={() => printDoc("bl")}>
            <ScrollText className="h-4 w-4" />
            Bon de livraison
          </button>
          {/* The bon de commande given at the counter: reprinted here when it was forgotten. */}
          {!order.isRestock && (
            <button type="button" className="od-btn od-btn--primary" onClick={() => printDoc("ticket")}>
              <Printer className="h-4 w-4" />
              Bon de commande
            </button>
          )}
          {/* Pas de bouton « Facture FA-… » ici : la facture émise se retrouve
              dans Factures; cette page sert au caissier à réimprimer le bon. */}
          {!invoice && !order.devis && !order.isRestock && !order.cancelledAt ? (
            <button type="button" className="od-btn od-btn--ghost" onClick={() => void doEmitInvoice()} disabled={invoiceBusy}>
              {invoiceBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <ScrollText className="h-4 w-4" />}
              Émettre la facture
            </button>
          ) : null}
          {canCancel && (
            <button
              type="button"
              className="od-btn od-btn--ghost od-btn--danger"
              onClick={() => {
                setCancelError(null);
                setCancelOpen(true);
              }}
            >
              <Ban className="h-4 w-4" />
              Annuler la commande
            </button>
          )}
          <Link href="/dashboard/commandes" className="od-btn od-btn--ghost">
            Retour
          </Link>
        </div>
      </div>

      {order.cancelledAt && (
        <div className="od-note od-note--danger">
          <Ban className="h-4 w-4" />
          <p>
            Commande annulée le {fmtDateTime(order.cancelledAt)}
            {order.cancelReason ? ` — ${order.cancelReason}` : ""}. Les pièces sont revenues en stock et
            les sommes encaissées ont été remboursées.
          </p>
        </div>
      )}

      <div className="od-grid">
        {/* ---- Main column ---- */}
        <div className="od-main">
          {/* Client & vehicle */}
          <section className="od-card">
            <div className="od-info-grid">
              <div className="od-info-card">
                <div className="od-info-head">
                  <User className="h-4 w-4" />
                  {order.isRestock ? "Réapprovisionnement" : order.accountKind === "PRO" ? "Client PRO" : order.isGarage ? "Garage" : "Client"}
                </div>
                <p className="od-info-name">{order.clientName}</p>
                {order.isRestock && (
                  <p className="od-info-line">
                    <Package className="h-3.5 w-3.5" />
                    Pièces commandées pour le stock magasin — aucun client lié.
                  </p>
                )}
                {order.clientPhone && (
                  <p className="od-info-line">
                    <Phone className="h-3.5 w-3.5" />
                    {order.clientPhone}
                  </p>
                )}
                {order.clientEmail && (
                  <p className="od-info-line">
                    <Mail className="h-3.5 w-3.5" />
                    {order.clientEmail}
                  </p>
                )}
              </div>
              <div className="od-info-card">
                <div className="od-info-head">
                  <Car className="h-4 w-4" />
                  Véhicule
                </div>
                <p className="od-info-name">
                  {order.vehicle ?? "—"}
                  {order.kilometrage != null && (
                    <span className="rl-muted"> · {order.kilometrage.toLocaleString("fr-FR")} km</span>
                  )}
                </p>
                {order.plate && (
                  <p className="od-info-line">
                    <Info className="h-3.5 w-3.5" />
                    {order.plate}
                  </p>
                )}
              </div>
            </div>
          </section>

          {/* Lines */}
          <section className="od-card">
            <h2 className="od-card-title">
              Pièces commandées ({order.lines.length})
            </h2>
            <div className="od-table-wrap">
              <table className="od-table">
                <thead>
                  <tr>
                    <th className="od-th-num">#</th>
                    <th>Référence / Désignation</th>
                    <th>Origine</th>
                    <th>Statut</th>
                    <th className="od-th-right">PU</th>
                    <th className="od-th-center">Qté</th>
                    <th>Remis au client</th>
                    <th className="od-th-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l, idx) => {
                    const St = LINE_STATUT[l.status];
                    const StIcon = St.icon;
                    const remaining = Math.max(0, l.quantity - l.handedOver);
                    const editing = handing?.lineId === l.id;
                    return (
                      <tr key={l.id}>
                        <td className="od-td-num">
                          <span className="od-row-num">{idx + 1}</span>
                        </td>
                        <td>
                          <p className="od-ref">{l.reference}</p>
                          {l.referenceCommande && l.referenceCommande !== l.reference && (
                            <p className="rl-ref-cmd">Réf. cmd. {l.referenceCommande}</p>
                          )}
                          <p className="od-desig">{l.designation}</p>
                        </td>
                        <td>
                          <div className="od-origin">
                            <span
                              className={`od-chip ${l.fromStock ? "od-chip--blue" : "od-chip--violet"}`}
                            >
                              {l.fromStock
                                ? "Stock magasin"
                                : l.supplierName ?? "Fournisseur"}
                            </span>
                            {l.tourName && (
                              <span className="od-origin-supplier">{l.tourName}</span>
                            )}
                            {!l.fromStock && l.expectedAt && l.status !== "RECEIVED" && (
                              <span className="od-origin-eta">
                                Arrivée prévue : {fmtDateTime(l.expectedAt)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <span className={`rc-statut rc-statut--${St.cls}`}>
                            <StIcon className="h-3.5 w-3.5" />
                            {St.label}
                          </span>
                          {l.status === "RECEIVED" && l.receivedAt && (
                            <p className="od-statut-sub">
                              Reçu le {fmtDateTime(l.receivedAt)}
                            </p>
                          )}
                          {l.received > 0 && l.received < l.quantity && (
                            <p className="od-statut-sub">
                              {l.received} / {l.quantity} reçue(s)
                            </p>
                          )}
                        </td>
                        <td className="od-td-right od-num">
                          {eur(l.prixVente)}
                          {l.remisePct > 0 && (
                            <p className="od-statut-sub">
                              <s>{eur(l.prixBrut)}</s> · −{l.remisePct.toLocaleString("fr-FR")} %
                            </p>
                          )}
                        </td>
                        <td className="od-td-center od-num">{l.quantity}</td>
                        <td>
                          {editing ? (
                            <div className="od-remise-edit">
                              <input
                                className="od-input od-remise-input"
                                type="number"
                                min={0}
                                max={l.quantity}
                                step={1}
                                value={handing.qty}
                                onChange={(e) =>
                                  setHanding({ lineId: l.id, qty: e.target.value })
                                }
                                autoFocus
                              />
                              <span className="rl-muted">/ {l.quantity}</span>
                              <button
                                type="button"
                                className="rc-act rc-act--recu"
                                disabled={handBusy}
                                onClick={() => void submitHanding(l)}
                              >
                                OK
                              </button>
                              <button
                                type="button"
                                className="rc-act"
                                disabled={handBusy}
                                onClick={() => setHanding(null)}
                              >
                                Annuler
                              </button>
                              {handError && <p className="od-remise-error">{handError}</p>}
                            </div>
                          ) : (
                            <div className="od-remise">
                              {l.handedOver >= l.quantity ? (
                                <span className="rc-statut rc-statut--recu">
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Remis {l.handedOver}/{l.quantity}
                                </span>
                              ) : l.handedOver > 0 ? (
                                <span className="rc-statut rc-statut--reliquat">
                                  Remis {l.handedOver}/{l.quantity} · reste {remaining}
                                </span>
                              ) : (
                                <span className="rc-statut rc-statut--attente">
                                  Non remis · {l.quantity} à remettre
                                </span>
                              )}
                              <button
                                type="button"
                                className="rc-act rc-act--remise"
                                onClick={() => openHanding(l)}
                              >
                                {l.handedOver > 0 ? "Modifier" : "Remettre"}
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="od-td-right od-num od-num-strong">
                          {eur(l.total)}
                        </td>
                      </tr>
                    );
                  })}
                  {order.lines.length === 0 && (
                    <tr>
                      <td colSpan={8} className="rc-empty-cell">
                        Aucune pièce sur cette commande.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="od-lines-total">
              Total pièces <strong>{eur(linesTotal)}</strong>
            </div>
            {order.remiseMontant > 0 && (
              <div className="od-lines-consigne">remise en pied de commande : − {eur(order.remiseMontant)}</div>
            )}
          </section>

          {/* Après-vente : promesse, casier, garantie par ligne, dossiers */}
          {profile?.organization_id && !order.cancelledAt && (
            <OrderSavPanel
              orgId={profile.organization_id}
              order={{
                id: order.id,
                ref: order.ref,
                date: order.date,
                clientName: order.clientName,
                plate: order.plate,
                kilometrage: order.kilometrage,
                isGarage: order.isGarage,
                isRestock: order.isRestock,
                devis: order.devis,
              }}
              lines={order.lines.map((l) => ({
                id: l.id,
                designation: l.designation,
                reference: l.reference,
                quantity: l.quantity,
                handedOver: l.handedOver,
              }))}
            />
          )}

          {/* Consigne note */}
          {order.consigne && (
            <div className="od-note">
              <Info className="h-4 w-4" />
              <p>{order.consigne}</p>
            </div>
          )}
        </div>

        {/* ---- Rail ---- */}
        <div className="od-rail">
          {/* Payment */}
          <section className="od-card">
            <h2 className="od-card-title">
              <CreditCard className="h-4 w-4" />
              Paiement
            </h2>
            <dl className="od-kv">
              <div className="od-kv-row">
                <dt>Total commande</dt>
                <dd className="od-kv-strong">{eur(order.total)}</dd>
              </div>
              {order.remiseMontant > 0 && (
                <div className="od-kv-row">
                  <dt>dont remise en pied</dt>
                  <dd style={{ color: "var(--clr-success-text)", fontWeight: 700 }}>− {eur(order.remiseMontant)}</dd>
                </div>
              )}
              <div className="od-kv-row">
                <dt>Payé</dt>
                <dd>{eur(order.paye)}</dd>
              </div>
              <div className="od-kv-row">
                <dt>Avance</dt>
                <dd>{eur(order.avance)}</dd>
              </div>
              {order.avoirApplique > 0 && (
                <div className="od-kv-row">
                  <dt>Avoir utilisé</dt>
                  <dd style={{ color: "var(--clr-success-text)", fontWeight: 700 }}>
                    − {eur(order.avoirApplique)}
                  </dd>
                </div>
              )}
              <div className="od-kv-row">
                <dt>Reste à payer</dt>
                <dd className="od-kv-strong">{eur(order.solde)}</dd>
              </div>
              <div className="od-kv-row">
                <dt>Statut</dt>
                <dd>
                  <span className={`status-badge status-badge--${pay.type}`}>
                    {pay.label}
                  </span>
                </dd>
              </div>
              {order.modePaiement && (
                <div className="od-kv-row">
                  <dt>Mode de paiement</dt>
                  <dd className="od-kv-strong">
                    {MODE_PAIEMENT_LABEL[order.modePaiement] ?? order.modePaiement}
                  </dd>
                </div>
              )}
              {order.modePaiement === "EN_COMPTE" && order.echeance && (
                <div className="od-kv-row">
                  <dt>Échéance</dt>
                  <dd
                    style={
                      order.solde > 0 && order.echeance < new Date().toISOString().slice(0, 10)
                        ? { color: "var(--clr-danger-text)", fontWeight: 700 }
                        : undefined
                    }
                  >
                    {new Date(order.echeance).toLocaleDateString("fr-FR")}
                  </dd>
                </div>
              )}
            </dl>
            {payNotice && (
              <div className="od-note" style={{ marginTop: 10 }}>
                <HandCoins className="h-4 w-4" />
                <p>{payNotice}</p>
              </div>
            )}
            {!order.devis && !order.isRestock && !order.cancelledAt && order.solde > 0 && (
              <button
                type="button"
                className="od-btn od-btn--primary"
                style={{ marginTop: 12, width: "100%", justifyContent: "center" }}
                onClick={() => openPay(order.solde)}
              >
                <Banknote className="h-4 w-4" /> Encaisser {eur(order.solde)}
              </button>
            )}
            {payments.length > 0 && (
              <div className="cx-history">
                <div className="cx-history-title">Règlements</div>
                {payments.map((p) => (
                  <div key={p.id} className="cx-history-row">
                    <span>
                      {new Date(p.receivedAt).toLocaleDateString("fr-FR")} · {PAYMENT_MODE_LABEL[p.mode]}
                      {p.kind === "REGLEMENT_COMPTE" ? " · règlement de compte" : p.kind === "REMBOURSEMENT" ? " · remboursement" : ""}
                      {p.receivedByName ? ` · ${p.receivedByName}` : ""}
                    </span>
                    <strong style={{ color: p.kind === "REMBOURSEMENT" ? "var(--clr-danger-text)" : "var(--clr-success-text)" }}>
                      {p.kind === "REMBOURSEMENT" ? "− " : ""}
                      {eur(
                        p.kind === "REGLEMENT_COMPTE"
                          ? (p.allocations.find((a) => a.orderId === orderId)?.amount ?? p.amount)
                          : p.amount,
                      )}
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </section>

          {cancelOpen && (
            <div className="ga-modal-overlay" onClick={() => !cancelBusy && setCancelOpen(false)}>
              <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="cancel-title" onClick={(e) => e.stopPropagation()}>
                <div className="ga-modal-head">
                  <span className="ga-modal-title" id="cancel-title"><Ban className="h-4 w-4" /> Annuler {order.ref}</span>
                  <button type="button" className="ga-modal-close" onClick={() => setCancelOpen(false)} aria-label="Fermer" disabled={cancelBusy}><X className="h-4 w-4" /></button>
                </div>
                <div className="ga-modal-form">
                  <p className="od-hint">
                    Les pièces prises en stock y retournent, la livraison est retirée
                    {order.avoirApplique > 0 ? ", l'avoir utilisé redevient disponible" : ""}
                    {cashed > 0 ? ` et ${eur(cashed)} sont remboursés au client.` : "."}
                  </p>
                  <div className="od-field">
                    <span className="od-label">Motif <span className="od-req">*</span></span>
                    <input className="od-input" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Client parti, erreur de saisie, pièce indisponible…" autoFocus />
                  </div>
                  {cashed > 0 && (
                    <div className="od-field">
                      <span className="od-label">Remboursement de {eur(cashed)} par</span>
                      <div className="nc-pay-quick" role="radiogroup">
                        {PAYMENT_MODES.map((m) => (
                          <button key={m} type="button" role="radio" aria-checked={cancelMode === m} className={`nc-chip${cancelMode === m ? " nc-chip--on" : ""}`} onClick={() => setCancelMode(m)}>
                            {PAYMENT_MODE_LABEL[m]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {cancelError && <div className="nc-error">{cancelError}</div>}
                  <div className="ga-modal-actions">
                    <button type="button" className="od-btn od-btn--ghost" onClick={() => setCancelOpen(false)} disabled={cancelBusy}>Garder la commande</button>
                    <button type="button" className="od-btn od-btn--primary od-btn--danger-solid" onClick={() => void submitCancel()} disabled={cancelBusy}>
                      {cancelBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Ban className="h-4 w-4" />} Confirmer l&apos;annulation
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
          {payOpen && (
            <div className="ga-modal-overlay" onClick={() => !payBusy && setPayOpen(false)}>
              <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="pay-title" onClick={(e) => e.stopPropagation()}>
                <div className="ga-modal-head">
                  <span className="ga-modal-title" id="pay-title"><Banknote className="h-4 w-4" /> Encaisser {order.ref}</span>
                  <button type="button" className="ga-modal-close" onClick={() => setPayOpen(false)} aria-label="Fermer" disabled={payBusy}><X className="h-4 w-4" /></button>
                </div>
                <div className="ga-modal-form">
                  {payError && <div className="nc-error">{payError}</div>}
                  <div className="od-field">
                    <span className="od-label">Montant encaissé <span className="od-req">*</span></span>
                    <div className="nc-pay-input">
                      <input className="od-input nc-pay-amount" type="number" min={0} max={order.solde} step="0.01" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} autoFocus />
                      <span className="nc-pay-unit">€</span>
                    </div>
                    <div className="nc-pay-quick">
                      <button type="button" className="nc-chip" onClick={() => setPayAmount(order.solde.toFixed(2))}>Tout · {eur(order.solde)}</button>
                      <button type="button" className="nc-chip" onClick={() => setPayAmount((Math.round((order.solde / 2) * 100) / 100).toFixed(2))}>Moitié</button>
                    </div>
                    <span className="st-cmd-hint">Reste à payer : {eur(order.solde)}.</span>
                  </div>
                  <div className="od-field">
                    <span className="od-label">Mode de paiement</span>
                    <div className="nc-pay-quick" role="radiogroup" aria-label="Mode de paiement">
                      {PAYMENT_MODES.map((m) => (
                        <button key={m} type="button" role="radio" aria-checked={payMode === m} className={`nc-chip${payMode === m ? " nc-chip--on" : ""}`} onClick={() => setPayMode(m)}>
                          {PAYMENT_MODE_LABEL[m]}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="ga-modal-row">
                    <div className="od-field">
                      <span className="od-label">Référence</span>
                      <input className="od-input" value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="N° chèque, virement…" />
                    </div>
                    <div className="od-field">
                      <span className="od-label">Note</span>
                      <input className="od-input" value={payNote} onChange={(e) => setPayNote(e.target.value)} placeholder="Facultatif" />
                    </div>
                  </div>
                  <div className="ga-modal-actions">
                    <button type="button" className="od-btn od-btn--ghost" onClick={() => setPayOpen(false)} disabled={payBusy}>Annuler</button>
                    <button type="button" className="od-btn od-btn--primary" onClick={() => void submitPay()} disabled={payBusy}>
                      {payBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Banknote className="h-4 w-4" />}
                      Valider l&apos;encaissement
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Delivery */}
          <section className="od-card">
            <h2 className="od-card-title">
              <Truck className="h-4 w-4" />
              Livraison
            </h2>
            <dl className="od-kv">
              <div className="od-kv-row">
                <dt>Envoi au livreur</dt>
                <dd>{order.envoyerAuLivreur ? "Oui" : "Non"}</dd>
              </div>
              {order.envoyerAuLivreur && (
                <>
                  <div className="od-kv-row">
                    <dt>Livreur</dt>
                    <dd>{order.livreurName ?? "Non assigné"}</dd>
                  </div>
                  <div className="od-kv-row">
                    <dt>Statut livreur</dt>
                    <dd>{LIVREUR_LABEL[order.statutLivreur] ?? order.statutLivreur}</dd>
                  </div>
                  <div className="od-kv-row">
                    <dt>Date d&apos;envoi</dt>
                    <dd>{fmtDateTime(order.dateEnvoi)}</dd>
                  </div>
                </>
              )}
              {order.delivery.deliveredAt && (
                <>
                  <div className="od-kv-row">
                    <dt>Livrée le</dt>
                    <dd>
                      {fmtDateTime(order.delivery.deliveredAt)}
                      {order.delivery.deliveredBy ? ` — par ${order.delivery.deliveredBy}` : ""}
                    </dd>
                  </div>
                  <div className="od-kv-row">
                    <dt>Remis à</dt>
                    <dd>{order.delivery.recipient ?? "—"}</dd>
                  </div>
                  {order.delivery.note && (
                    <div className="od-kv-row">
                      <dt>Remarque livreur</dt>
                      <dd>{order.delivery.note}</dd>
                    </div>
                  )}
                </>
              )}
              {order.delivery.podPath && (
                <div className="od-kv-row">
                  <dt>Preuve de livraison</dt>
                  <dd>
                    {podUrl ? (
                      <a href={podUrl} target="_blank" rel="noreferrer" title="Ouvrir la photo">
                        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL of a private bucket, not optimisable */}
                        <img src={podUrl} alt={`Preuve de livraison ${order.ref}`} className="od-pod-img" />
                      </a>
                    ) : podUrl === null ? (
                      "Photo indisponible"
                    ) : (
                      "Chargement de la photo…"
                    )}
                  </dd>
                </div>
              )}
              {order.delivery.attempts > 0 && (
                <div className="od-kv-row">
                  <dt>Passages du livreur</dt>
                  <dd>{order.delivery.attempts}</dd>
                </div>
              )}
              {order.delivery.failedReason && (
                <div className="od-kv-row">
                  <dt>Dernier échec</dt>
                  <dd className="od-kv-danger">
                    {order.delivery.failedReason}
                    {order.delivery.failedAt ? ` — ${fmtDateTime(order.delivery.failedAt)}` : ""}
                  </dd>
                </div>
              )}
              <div className="od-kv-row">
                <dt>Bon de livraison</dt>
                <dd>{order.bl ? `Oui — ${fmtDate(order.dateBl)}` : "Non"}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      {/* ---- Bon de commande / bon de livraison: 80 mm tickets, never shown, copied by printTicket ---- */}
      {printMode && (
        <div className="tk-print-only" ref={printRef}>
          {printMode === "bl" ? (
            <OrderTicket org={org} kind="livraison" data={{ ...ticketOf(order, returnPolicy), livreur: order.livreurName }} />
          ) : (
            <OrderTicketCopies org={org} data={ticketOf(order, returnPolicy)} />
          )}
        </div>
      )}
    </div>
  );
}
