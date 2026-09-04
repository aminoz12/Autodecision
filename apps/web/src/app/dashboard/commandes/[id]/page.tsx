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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { workflowLabel } from "@/lib/data/dashboard";
import {
  loadOrderDetail,
  setLineHandedOver,
  type OrderDetail,
  type OrderDetailLine,
  type ReceptionStatus,
} from "@/lib/data/commandes";
import { loadOrganizationSettings, type OrganizationSettings } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const LINE_STATUT: Record<
  ReceptionStatus,
  { label: string; cls: string; icon: LucideIcon }
> = {
  PENDING: { label: "En attente", cls: "attente", icon: Clock },
  RECEIVED: { label: "Reçu", cls: "recu", icon: CheckCircle2 },
  BACKORDER: { label: "Reliquat", cls: "reliquat", icon: Hourglass },
  NOT_RECEIVED: { label: "Non reçu", cls: "nonrecu", icon: XCircle },
};

const PAIEMENT_LABEL: Record<string, { label: string; type: "success" | "info" | "warning" }> = {
  "PAYÉ": { label: "Payé", type: "success" },
  PARTIEL: { label: "Acompte", type: "warning" },
  "NON_PAYÉ": { label: "Non payé", type: "warning" },
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

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params?.id ?? "";
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [org, setOrg] = useState<OrganizationSettings | null>(null);
  /** Which document the next window.print() renders. */
  const [printMode, setPrintMode] = useState<"facture" | "bl" | null>(null);

  useEffect(() => {
    if (!profile?.organization_id) return;
    loadOrganizationSettings(supabase, profile.organization_id)
      .then(setOrg)
      .catch(() => {});
  }, [supabase, profile?.organization_id]);

  const printDoc = useCallback(
    (mode: "facture" | "bl") => {
      setPrintMode(mode);
      // Tab title becomes the suggested PDF file name (REQ-…-facture.pdf).
      if (order?.ref) document.title = `${order.ref}-${mode === "facture" ? "facture" : "bon-livraison"}`;
      // Let React paint the .print-doc block before opening the dialog.
      window.setTimeout(() => window.print(), 60);
    },
    [order?.ref],
  );

  useEffect(() => {
    const initialTitle = document.title;
    const reset = () => {
      setPrintMode(null);
      document.title = initialTitle;
    };
    window.addEventListener("afterprint", reset);
    return () => window.removeEventListener("afterprint", reset);
  }, []);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  /* ---- Remise au client (units handed over) ---- */
  const [handing, setHanding] = useState<{ lineId: string; qty: string } | null>(null);
  const [handBusy, setHandBusy] = useState(false);
  const [handError, setHandError] = useState<string | null>(null);

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
            <span className={`status-badge status-badge--${wf.type}`}>{wf.label}</span>
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
          <button type="button" className="od-btn od-btn--primary" onClick={() => printDoc("facture")}>
            <Printer className="h-4 w-4" />
            Imprimer la facture
          </button>
          <Link href="/dashboard/commandes" className="od-btn od-btn--ghost">
            Retour
          </Link>
        </div>
      </div>

      <div className="od-grid">
        {/* ---- Main column ---- */}
        <div className="od-main">
          {/* Client & vehicle */}
          <section className="od-card">
            <div className="od-info-grid">
              <div className="od-info-card">
                <div className="od-info-head">
                  <User className="h-4 w-4" />
                  {order.isRestock ? "Réapprovisionnement" : order.isGarage ? "Garage" : "Client"}
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
                        <td className="od-td-right od-num">{eur(l.prixVente)}</td>
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
          </section>

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
            </dl>
          </section>

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
              <div className="od-kv-row">
                <dt>Bon de livraison</dt>
                <dd>{order.bl ? `Oui — ${fmtDate(order.dateBl)}` : "Non"}</dd>
              </div>
            </dl>
          </section>
        </div>
      </div>

      {/* ---- Printable document (Facture / Bon de livraison) ---- */}
      {printMode && (
        <div className="print-doc">
          <div className="print-head">
            <div>
              <p className="print-org">{org?.name ?? "Magasin"}</p>
              {org?.address && <p className="print-org-line">{org.address}</p>}
              {(org?.city || org?.phone) && (
                <p className="print-org-line">
                  {[org?.city, org?.phone ? `Tél. ${org.phone}` : null].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <div className="print-doctype">
              <p className="print-doctype-name">{printMode === "facture" ? "FACTURE" : "BON DE LIVRAISON"}</p>
              <p className="print-org-line">{order.ref}</p>
              <p className="print-org-line">{fmtDate(order.date)}</p>
            </div>
          </div>

          <div className="print-client">
            <p className="print-section-title">{order.isGarage ? "Garage" : "Client"}</p>
            <p className="print-client-name">{order.clientName}</p>
            {order.clientPhone && <p className="print-org-line">{order.clientPhone}</p>}
            {(order.vehicle || order.plate) && (
              <p className="print-org-line">
                {[order.vehicle, order.plate].filter(Boolean).join(" · ")}
                {order.kilometrage != null ? ` · ${order.kilometrage.toLocaleString("fr-FR")} km` : ""}
              </p>
            )}
          </div>

          <table className="print-table">
            <thead>
              <tr>
                <th>Référence</th>
                <th>Désignation</th>
                <th className="print-num">Qté</th>
                {printMode === "facture" && <th className="print-num">PU HT/TTC</th>}
                {printMode === "facture" && <th className="print-num">Total</th>}
              </tr>
            </thead>
            <tbody>
              {order.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.reference}</td>
                  <td>{l.designation}</td>
                  <td className="print-num">{l.quantity}</td>
                  {printMode === "facture" && <td className="print-num">{eur(l.prixVente)}</td>}
                  {printMode === "facture" && <td className="print-num">{eur(l.total)}</td>}
                </tr>
              ))}
            </tbody>
          </table>

          {printMode === "facture" ? (
            <div className="print-totals">
              <div><span>Total commande</span><strong>{eur(order.total)}</strong></div>
              {order.avoirApplique > 0 && <div><span>Avoir déduit</span><strong>− {eur(order.avoirApplique)}</strong></div>}
              <div><span>Payé</span><strong>{eur(order.paye + order.avance)}</strong></div>
              <div className="print-totals-due"><span>Reste à payer</span><strong>{eur(order.solde)}</strong></div>
            </div>
          ) : (
            <div className="print-sign">
              <div>
                <p className="print-section-title">Livré par</p>
                <p className="print-org-line">{order.livreurName ?? "________________"}</p>
              </div>
              <div>
                <p className="print-section-title">Signature du client</p>
                <div className="print-sign-box" />
              </div>
            </div>
          )}

          <p className="print-footer">
            {printMode === "facture"
              ? "Merci de votre confiance — TVA 20 % incluse dans les prix affichés."
              : "Marchandise vérifiée et reçue conforme."}
          </p>
        </div>
      )}
    </div>
  );
}
