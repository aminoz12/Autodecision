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
  Truck,
  User,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { workflowLabel } from "@/lib/data/dashboard";
import {
  loadOrderDetail,
  type OrderDetail,
  type ReceptionStatus,
} from "@/lib/data/commandes";

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
  PARTIEL: { label: "Partiel", type: "warning" },
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.organization_id || !orderId) return;
    let cancelled = false;
    setLoading(true);
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
  }, [supabase, profile?.organization_id, orderId]);

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
          <Link href="/dashboard/commandes" className="od-btn od-btn--ghost">
            Retour aux commandes
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
                  Client
                </div>
                <p className="od-info-name">{order.clientName}</p>
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
                <p className="od-info-name">{order.vehicle ?? "—"}</p>
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
                    <th className="od-th-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l, idx) => {
                    const St = LINE_STATUT[l.status];
                    const StIcon = St.icon;
                    return (
                      <tr key={l.id}>
                        <td className="od-td-num">
                          <span className="od-row-num">{idx + 1}</span>
                        </td>
                        <td>
                          <p className="od-ref">{l.reference}</p>
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
                        <td className="od-td-right od-num od-num-strong">
                          {eur(l.total)}
                        </td>
                      </tr>
                    );
                  })}
                  {order.lines.length === 0 && (
                    <tr>
                      <td colSpan={7} className="rc-empty-cell">
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
    </div>
  );
}
