"use client";

import {
  AlertTriangle,
  BadgePercent,
  CalendarClock,
  FileText,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { paymentTermsLabel } from "@/lib/constants/enums";
import { loadClientPayments, PAYMENT_KIND_LABEL, PAYMENT_MODE_LABEL, type Payment } from "@/lib/data/payments";
import { loadInvoices, type Invoice } from "@/lib/data/invoices";
import {
  buildGarageStatement,
  DEVIS_LABEL,
  GARAGE_STAGE_LABEL,
  garageStage,
  loadGarageCredits,
  loadGarageInfo,
  loadGarageOrders,
  loadGarageReturns,
  MODE_PAIEMENT_SHORT,
  type GarageCredit,
  type GarageInfo,
  type GarageOrder,
} from "@/lib/data/garage";

function eur(v: number) {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
function signed(v: number) {
  if (v < 0) return `− ${eur(Math.abs(v))}`;
  return eur(v);
}
function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

type Filter = "MONTH" | "OPEN" | "ALL";

export default function GarageAccountPage() {
  const { supabase, profile } = useAuth();
  const [garage, setGarage] = useState<GarageInfo | null>(null);
  const [orders, setOrders] = useState<GarageOrder[]>([]);
  const [credits, setCredits] = useState<GarageCredit[]>([]);
  const [returnCount, setReturnCount] = useState(0);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("MONTH");

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    const orgId = profile.organization_id;
    const clientId = profile.client_id;
    setLoading(true);
    setError(null);
    try {
      const [info, o, c, r, p, inv] = await Promise.all([
        loadGarageInfo(supabase, clientId).catch(() => null),
        loadGarageOrders(supabase, orgId, clientId),
        loadGarageCredits(supabase, orgId, clientId).catch(() => [] as GarageCredit[]),
        loadGarageReturns(supabase, orgId, clientId).catch(() => []),
        loadClientPayments(supabase, orgId, clientId, 50).catch(() => [] as Payment[]),
        loadInvoices(supabase, orgId, { clientId, limit: 100 }).catch(() => [] as Invoice[]),
      ]);
      setGarage(info);
      setOrders(o);
      setCredits(c);
      setReturnCount(r.length);
      setPayments(p);
      setInvoices(inv);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.organization_id, profile?.client_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const statement = useMemo(
    () => buildGarageStatement(orders, credits, returnCount),
    [orders, credits, returnCount],
  );
  const today = localToday();

  const history = useMemo(() => {
    const confirmed = orders.filter((o) => !o.devis);
    if (filter === "MONTH") return statement.monthOrders;
    if (filter === "OPEN") return confirmed.filter((o) => o.balance > 0);
    return confirmed;
  }, [orders, filter, statement.monthOrders]);

  const owes = statement.balance > 0;
  const terms = garage?.paymentTermsDays ?? 30;

  return (
    <div className="gp-page">
      <header className="gp-header gp-header--row">
        <div>
          <h1 className="gp-title">Mon compte</h1>
          <p className="gp-subtitle">
            L&apos;historique de vos commandes et ce que vous devez au magasin.
          </p>
        </div>
        <div className="gp-header-actions">
          <span className="gp-terms" title="Délai accordé par votre magasin pour régler les commandes en compte">
            <CalendarClock className="h-3.5 w-3.5" />
            Paiement en compte · {paymentTermsLabel(terms).toLowerCase()}
          </span>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      {/* ---- Counts ---- */}
      <div className="gp-stats gp-stats--3">
        <Link href="/garagiste/dashboard/commandes" className="gp-stat">
          <span className="gp-stat-label"><ShoppingCart className="h-4 w-4" /> Commandes</span>
          <span className="gp-stat-value">{statement.orderCount}</span>
        </Link>
        <Link href="/garagiste/dashboard/commandes" className="gp-stat">
          <span className="gp-stat-label"><FileText className="h-4 w-4" /> Devis</span>
          <span className="gp-stat-value" style={{ color: "#1D4ED8" }}>{statement.devisCount}</span>
        </Link>
        <Link href="/garagiste/dashboard/retours" className="gp-stat">
          <span className="gp-stat-label"><RotateCcw className="h-4 w-4" /> Retours</span>
          <span className="gp-stat-value" style={{ color: "#B45309" }}>{statement.returnCount}</span>
        </Link>
      </div>

      {/* ---- Statement ---- */}
      <div className="gp-statement">
        <section className="gp-card">
          <div className="gp-card-title">
            <Wallet className="h-4 w-4" style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} />
            Relevé de compte
          </div>
          <div className="gp-ledger">
            <div className="gp-ledger-row">
              <span>En cours {statement.periodLabel}</span>
              <strong>{eur(statement.currentMonth)}</strong>
            </div>
            {statement.carriedOver > 0 && (
              <div className="gp-ledger-row">
                <span>Encours antérieur (mois précédents)</span>
                <strong>{eur(statement.carriedOver)}</strong>
              </div>
            )}
            <div className="gp-ledger-row gp-ledger-row--credit">
              <span>Avoir{credits.length > 1 ? "s" : ""}</span>
              <strong>{statement.credits > 0 ? `− ${eur(statement.credits)}` : eur(0)}</strong>
            </div>
            <div className="gp-ledger-row gp-ledger-row--total">
              <span>Solde du compte</span>
              <strong style={{ color: owes ? "#DC2626" : "#16A34A" }}>{signed(statement.balance)}</strong>
            </div>
          </div>
          {statement.overdue > 0 ? (
            <p className="gp-ledger-hint gp-overdue">
              <AlertTriangle className="h-3.5 w-3.5" style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />
              dont {eur(statement.overdue)} dont l&apos;échéance est dépassée.
            </p>
          ) : (
            <p className="gp-ledger-hint">
              {owes
                ? `Montant à régler au magasin, avoirs déduits. Chaque commande en compte est à régler sous ${terms} jours.`
                : statement.balance < 0
                  ? "Le magasin vous doit ce montant (avoirs supérieurs à l'encours)."
                  : "Votre compte est à jour."}
            </p>
          )}
        </section>

        <section className="gp-card">
          <div className="gp-card-title">
            <BadgePercent className="h-4 w-4" style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }} />
            Avoirs disponibles
          </div>
          {credits.length === 0 ? (
            <p className="gp-note" style={{ marginTop: 0 }}>
              Aucun avoir en cours. Un avoir est créé par le magasin lorsqu&apos;un retour est accepté.
            </p>
          ) : (
            <div className="gp-credit-list">
              {credits.map((c) => (
                <div key={c.id} className="gp-credit">
                  <span>
                    <strong>{c.num}</strong>
                    <span className="rl-muted-strong" style={{ marginLeft: 8 }}>
                      {frDate(c.createdAt)}
                      {c.dueAt ? ` · valable jusqu'au ${frDate(c.dueAt)}` : ""}
                    </span>
                  </span>
                  <strong style={{ color: "#16A34A" }}>− {eur(c.remaining)}</strong>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* ---- Invoices ---- */}
      {invoices.length > 0 && (
        <section className="gp-card">
          <div className="gp-card-title">Vos factures et avoirs</div>
          <div className="rl-table-wrap">
            <table className="stk-table">
              <thead>
                <tr><th>Numéro</th><th>Type</th><th>Date</th><th>Commande</th><th className="stk-th-center">TTC</th><th></th></tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="stk-ref"><Link href={`/garagiste/dashboard/factures/${i.id}`}>{i.number}</Link></td>
                    <td><span className={`rt-badge rt-badge--${i.kind === "AVOIR" ? "amber" : "blue"}`}>{i.kind === "AVOIR" ? "Avoir" : "Facture"}</span></td>
                    <td className="rl-muted-strong">{frDate(i.issuedAt)}</td>
                    <td className="rl-muted-strong">{i.orderRef ?? "—"}</td>
                    <td className="stk-td-center" style={{ fontWeight: 700 }}>{i.kind === "AVOIR" ? "− " : ""}{eur(i.totals.ttc)}</td>
                    <td className="od-td-right"><Link href={`/garagiste/dashboard/factures/${i.id}`} className="od-btn od-btn--ghost">Voir / PDF</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---- Payments received ---- */}
      {payments.length > 0 && (
        <section className="gp-card">
          <div className="gp-card-title">Vos règlements</div>
          <div className="rl-table-wrap">
            <table className="stk-table">
              <thead>
                <tr><th>Date</th><th>Type</th><th>Mode</th><th>Commandes réglées</th><th className="stk-th-center">Montant</th></tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="rl-muted-strong">{frDate(p.receivedAt)}</td>
                    <td>{PAYMENT_KIND_LABEL[p.kind]}{p.reference ? ` · ${p.reference}` : ""}</td>
                    <td><span className="rt-badge rt-badge--blue">{PAYMENT_MODE_LABEL[p.mode]}</span></td>
                    <td className="rl-muted-strong">
                      {p.allocations.length > 0 ? p.allocations.map((a) => a.orderRef).join(", ") : p.orderRef ?? "—"}
                    </td>
                    <td className="stk-td-center" style={{ fontWeight: 700, color: p.kind === "REMBOURSEMENT" ? "#DC2626" : "#16A34A" }}>
                      {p.kind === "REMBOURSEMENT" ? "− " : ""}{eur(p.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ---- History ---- */}
      <section className="gp-card">
        <div className="gp-card-title">Historique des commandes</div>
        <div className="gp-filter" role="tablist" aria-label="Filtrer l'historique">
          {(
            [
              ["MONTH", `Ce mois (${statement.monthOrders.length})`],
              ["OPEN", `À régler (${orders.filter((o) => !o.devis && o.balance > 0).length})`],
              ["ALL", `Toutes (${statement.orderCount})`],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`nc-chip${filter === key ? " nc-chip--on" : ""}`}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th>Commande</th>
                <th>Date</th>
                <th>Statut</th>
                <th>Paiement</th>
                <th>Échéance</th>
                <th className="stk-th-center">Total</th>
                <th className="stk-th-center">Payé</th>
                <th className="stk-th-center">Reste</th>
              </tr>
            </thead>
            <tbody>
              {history.map((o) => {
                const st = o.devis
                  ? DEVIS_LABEL[o.devisStatus ?? "REQUESTED"] ?? { label: "Devis", cls: "amber" }
                  : GARAGE_STAGE_LABEL[garageStage(o)];
                const late = o.balance > 0 && !!o.echeance && o.echeance < today;
                return (
                  <tr key={o.id}>
                    <td className="stk-ref">{o.ref}</td>
                    <td className="rl-muted-strong">{frDate(o.date)}</td>
                    <td><span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span></td>
                    <td>
                      {o.modePaiement ? (
                        <span className={`rt-badge rt-badge--${o.modePaiement === "EN_COMPTE" ? "violet" : "blue"}`}>
                          {MODE_PAIEMENT_SHORT[o.modePaiement] ?? o.modePaiement}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={late ? "gp-overdue" : "rl-muted-strong"}>
                      {o.balance > 0 ? frDate(o.echeance) : "—"}
                      {late ? " · échue" : ""}
                    </td>
                    <td className="stk-td-center">{eur(o.total)}</td>
                    <td className="stk-td-center">{eur(o.paid)}</td>
                    <td className="stk-td-center" style={{ color: o.balance > 0 ? "#DC2626" : "#16A34A", fontWeight: 700 }}>{eur(o.balance)}</td>
                  </tr>
                );
              })}
              {!loading && history.length === 0 && (
                <tr>
                  <td colSpan={8} className="stk-empty">
                    {filter === "MONTH"
                      ? "Aucune commande ce mois-ci."
                      : filter === "OPEN"
                        ? "Rien à régler : votre compte est à jour."
                        : "Aucune commande pour le moment. Les montants apparaissent une fois la commande chiffrée par le magasin."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <p className="gp-note">
        💳 Le règlement en ligne et l&apos;envoi de justificatifs (capture de virement) seront
        bientôt disponibles ici. En attendant, réglez votre solde directement auprès du magasin.
      </p>
    </div>
  );
}
