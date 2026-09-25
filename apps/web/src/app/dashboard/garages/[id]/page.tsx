"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CalendarClock,
  Check,
  ClipboardPlus,
  FileText,
  HandCoins,
  Loader2,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { GarageSavCard } from "@/components/sav/GarageSavCard";
import { createClient } from "@/lib/supabase/client";
import { paymentTermsLabel } from "@/lib/constants/enums";
import { fmtMoney } from "@/lib/data/saas";
import {
  buildGarageStatement,
  DEVIS_LABEL,
  GARAGE_STAGE_LABEL,
  garageStage,
  loadGarageCredits,
  loadGarageInfo,
  loadGarageOrdersForStaff,
  loadGarageReturns,
  type GarageCredit,
  type GarageInfo,
  type GarageOrder,
} from "@/lib/data/garage";
import {
  loadClientPayments,
  PAYMENT_KIND_LABEL,
  PAYMENT_MODE_LABEL,
  PAYMENT_MODES,
  settleClientAccount,
  type Payment,
  type PaymentMode,
} from "@/lib/data/payments";

function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}
function frDateTime(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function money(raw: string): number {
  const n = Number(String(raw).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export default function GarageDetailPage() {
  const params = useParams<{ id: string }>();
  const garageId = params?.id ?? "";
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;

  const [garage, setGarage] = useState<GarageInfo | null>(null);
  const [orders, setOrders] = useState<GarageOrder[]>([]);
  const [credits, setCredits] = useState<GarageCredit[]>([]);
  const [returnCount, setReturnCount] = useState(0);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId || !garageId) return;
    setLoading(true);
    setError(null);
    try {
      const [info, o, c, r, p] = await Promise.all([
        loadGarageInfo(supabase, garageId),
        loadGarageOrdersForStaff(supabase, orgId, garageId),
        loadGarageCredits(supabase, orgId, garageId).catch(() => [] as GarageCredit[]),
        loadGarageReturns(supabase, orgId, garageId).catch(() => []),
        loadClientPayments(supabase, orgId, garageId).catch(() => [] as Payment[]),
      ]);
      setGarage(info);
      setOrders(o);
      setCredits(c);
      setReturnCount(r.length);
      setPayments(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId, garageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const statement = useMemo(
    () => buildGarageStatement(orders, credits, returnCount),
    [orders, credits, returnCount],
  );
  const today = localToday();
  const openOrders = useMemo(
    () =>
      orders
        .filter((o) => !o.devis && o.balance > 0)
        .sort((a, b) => {
          const ka = (a.echeance ?? a.date ?? "") + (a.date ?? "");
          const kb = (b.echeance ?? b.date ?? "") + (b.date ?? "");
          return ka.localeCompare(kb);
        }),
    [orders],
  );
  const owed = openOrders.reduce((s, o) => s + o.balance, 0);

  /* ---- Règlement ---- */
  const [settleOpen, setSettleOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PaymentMode>("VIREMENT");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  const openSettle = () => {
    setAmount(owed > 0 ? String(owed.toFixed(2)) : "");
    setMode("VIREMENT");
    setReference("");
    setNote("");
    setSettleError(null);
    setSettleOpen(true);
  };

  /** Preview of the FIFO allocation the server will apply (by échéance, then date). */
  const preview = useMemo(() => {
    let remaining = money(amount);
    const rows: { order: GarageOrder; amount: number }[] = [];
    for (const o of openOrders) {
      if (remaining <= 0) break;
      const a = Math.min(remaining, o.balance);
      rows.push({ order: o, amount: a });
      remaining = Math.round((remaining - a) * 100) / 100;
    }
    return rows;
  }, [amount, openOrders]);

  const submitSettle = async () => {
    const a = money(amount);
    if (a <= 0) {
      setSettleError("Indiquez le montant reçu.");
      return;
    }
    if (a > owed + 0.005) {
      setSettleError(`Le montant dépasse le solde dû (${fmtMoney(owed)}).`);
      return;
    }
    setBusy(true);
    setSettleError(null);
    try {
      const res = await settleClientAccount(supabase, {
        clientId: garageId,
        amount: a,
        mode,
        reference,
        note,
      });
      setSettleOpen(false);
      setNotice(
        `${fmtMoney(res.amount)} reçus (${PAYMENT_MODE_LABEL[mode].toLowerCase()}) — ${res.allocations.length} commande(s) réglée(s) : ${res.allocations
          .map((x) => `${x.ref} ${fmtMoney(x.amount)}`)
          .join(", ")}.`,
      );
      await load();
    } catch (e) {
      setSettleError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!loading && !garage) {
    return (
      <div className="od-page">
        <nav className="od-breadcrumb">
          <Link href="/dashboard/garages">Garages</Link>
        </nav>
        <div className="od-card rc-empty"><p>{error ?? "Garage introuvable."}</p></div>
      </div>
    );
  }

  const balanceTone = statement.balance > 0 ? "#DC2626" : "#16A34A";

  return (
    <div className="od-page">
      <nav className="od-breadcrumb">
        <Link href="/dashboard/garages" className="od-breadcrumb-back">
          <ArrowLeft className="h-3.5 w-3.5" /> Garages
        </Link>
      </nav>

      <header className="rl-header rl-header--row">
        <div>
          <h1 className="rl-title">{garage?.name ?? "Garage"}</h1>
          <p className="rl-subtitle">
            <span className="ga-contact-row"><Phone className="h-3.5 w-3.5" />{garage?.phone ?? "—"}</span>
            {" · "}
            <span className="ga-contact-row"><Mail className="h-3.5 w-3.5" />{garage?.email ?? "—"}</span>
            {" · "}
            <span className="ga-contact-row"><MapPin className="h-3.5 w-3.5" />{garage?.city ?? "—"}</span>
          </p>
        </div>
        <div className="cx-actions">
          <span className="gp-terms">
            <CalendarClock className="h-3.5 w-3.5" />
            En compte · {paymentTermsLabel(garage?.paymentTermsDays ?? 30).toLowerCase()}
          </span>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
          <Link href={`/dashboard/nouvelle-commande?client=${garageId}`} className="od-btn od-btn--outline">
            <ClipboardPlus className="h-4 w-4" /> Nouvelle commande
          </Link>
          <button type="button" className="od-btn od-btn--primary" onClick={openSettle} disabled={owed <= 0}>
            <HandCoins className="h-4 w-4" /> Enregistrer un règlement
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      {notice && (
        <div className="od-note cx-notice">
          <Check className="h-4 w-4" />
          <p>{notice}</p>
        </div>
      )}

      <div className="ga-stats">
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}><ShoppingCart className="h-5 w-5" /></span><div><p className="ga-stat-value">{statement.orderCount}</p><p className="ga-stat-label">Commandes</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#EEF2FF", color: "#4F46E5" }}><FileText className="h-5 w-5" /></span><div><p className="ga-stat-value">{statement.devisCount}</p><p className="ga-stat-label">Devis</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#D97706" }}><RotateCcw className="h-5 w-5" /></span><div><p className="ga-stat-value">{statement.returnCount}</p><p className="ga-stat-label">Retours</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: statement.balance > 0 ? "#FEE2E2" : "#DCFCE7", color: balanceTone }}><Wallet className="h-5 w-5" /></span><div><p className="ga-stat-value" style={{ color: balanceTone }}>{fmtMoney(statement.balance)}</p><p className="ga-stat-label">Solde du compte</p></div></div>
      </div>

      <div className="gp-statement">
        <section className="od-card">
          <div className="od-card-title"><Wallet className="h-4 w-4" /> Relevé de compte</div>
          <div className="gp-ledger">
            <div className="gp-ledger-row"><span>En cours {statement.periodLabel}</span><strong>{fmtMoney(statement.currentMonth)}</strong></div>
            {statement.carriedOver > 0 && (
              <div className="gp-ledger-row"><span>Encours antérieur</span><strong>{fmtMoney(statement.carriedOver)}</strong></div>
            )}
            <div className="gp-ledger-row gp-ledger-row--credit"><span>Avoir{credits.length > 1 ? "s" : ""}</span><strong>{statement.credits > 0 ? `− ${fmtMoney(statement.credits)}` : fmtMoney(0)}</strong></div>
            <div className="gp-ledger-row gp-ledger-row--total"><span>Solde du compte</span><strong style={{ color: balanceTone }}>{fmtMoney(statement.balance)}</strong></div>
          </div>
          {statement.overdue > 0 ? (
            <p className="gp-ledger-hint gp-overdue"><AlertTriangle className="h-3.5 w-3.5" style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} /> dont {fmtMoney(statement.overdue)} échus.</p>
          ) : (
            <p className="gp-ledger-hint">{owed > 0 ? "Les règlements sont affectés aux commandes les plus anciennes d'abord (par échéance)." : "Compte à jour."}</p>
          )}
        </section>

        <section className="od-card">
          <div className="od-card-title"><Banknote className="h-4 w-4" /> Commandes à régler</div>
          <div className="rl-table-wrap">
            <table className="stk-table">
              <thead>
                <tr><th>Commande</th><th>Date</th><th>Échéance</th><th className="stk-th-center">Total</th><th className="stk-th-center">Reste</th></tr>
              </thead>
              <tbody>
                {openOrders.map((o) => {
                  const late = !!o.echeance && o.echeance < today;
                  return (
                    <tr key={o.id}>
                      <td className="stk-ref"><Link href={`/dashboard/commandes/${o.id}`}>{o.ref}</Link></td>
                      <td className="rl-muted-strong">{frDate(o.date)}</td>
                      <td className={late ? "gp-overdue" : "rl-muted-strong"}>{frDate(o.echeance)}{late ? " · échue" : ""}</td>
                      <td className="stk-td-center">{fmtMoney(o.total)}</td>
                      <td className="stk-td-center" style={{ color: "#DC2626", fontWeight: 700 }}>{fmtMoney(o.balance)}</td>
                    </tr>
                  );
                })}
                {!loading && openOrders.length === 0 && (
                  <tr><td colSpan={5} className="stk-empty">Aucune commande en attente de règlement.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="od-card">
        <div className="od-card-title"><HandCoins className="h-4 w-4" /> Règlements reçus</div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Mode</th><th>Référence</th><th>Commandes réglées</th><th>Reçu par</th><th className="stk-th-center">Montant</th></tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="rl-muted-strong">{frDateTime(p.receivedAt)}</td>
                  <td>{PAYMENT_KIND_LABEL[p.kind]}</td>
                  <td><span className="rt-badge rt-badge--blue">{PAYMENT_MODE_LABEL[p.mode]}</span></td>
                  <td className="rl-muted-strong">{p.reference ?? p.note ?? "—"}</td>
                  <td className="rl-muted-strong">
                    {p.allocations.length > 0
                      ? p.allocations.map((a) => `${a.orderRef ?? ""} (${fmtMoney(a.amount)})`).join(", ")
                      : p.orderRef ?? "—"}
                  </td>
                  <td className="rl-muted-strong">{p.receivedByName ?? "—"}</td>
                  <td className="stk-td-center" style={{ fontWeight: 700, color: p.kind === "REMBOURSEMENT" ? "#DC2626" : "#16A34A" }}>
                    {p.kind === "REMBOURSEMENT" ? "− " : ""}{fmtMoney(p.amount)}
                  </td>
                </tr>
              ))}
              {!loading && payments.length === 0 && (
                <tr><td colSpan={7} className="stk-empty">Aucun règlement enregistré pour ce garage.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {orgId && garage && <GarageSavCard orgId={orgId} clientId={garage.id} />}

      <section className="od-card">
        <div className="od-card-title"><ShoppingCart className="h-4 w-4" /> Historique des commandes et devis</div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr><th>Commande</th><th>Date</th><th>Statut</th><th>Échéance</th><th className="stk-th-center">Total</th><th className="stk-th-center">Payé</th><th className="stk-th-center">Reste</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const st = o.devis
                  ? DEVIS_LABEL[o.devisStatus ?? "REQUESTED"] ?? { label: "Devis", cls: "amber" }
                  : GARAGE_STAGE_LABEL[garageStage(o)];
                return (
                  <tr key={o.id}>
                    <td className="stk-ref"><Link href={`/dashboard/commandes/${o.id}`}>{o.ref}</Link></td>
                    <td className="rl-muted-strong">{frDate(o.date)}</td>
                    <td><span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span></td>
                    <td className="rl-muted-strong">{o.balance > 0 ? frDate(o.echeance) : "—"}</td>
                    <td className="stk-td-center">{fmtMoney(o.total)}</td>
                    <td className="stk-td-center">{fmtMoney(o.paid)}</td>
                    <td className="stk-td-center" style={{ color: o.balance > 0 ? "#DC2626" : "#16A34A", fontWeight: 700 }}>{fmtMoney(o.balance)}</td>
                  </tr>
                );
              })}
              {!loading && orders.length === 0 && (
                <tr><td colSpan={7} className="stk-empty">Aucune commande pour ce garage.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {settleOpen && (
        <div className="ga-modal-overlay" onClick={() => !busy && setSettleOpen(false)}>
          <div className="ga-modal ga-modal--wide" role="dialog" aria-modal="true" aria-labelledby="settle-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="settle-title"><HandCoins className="h-4 w-4" /> Règlement de {garage?.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setSettleOpen(false)} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {settleError && <div className="nc-error">{settleError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Montant reçu <span className="od-req">*</span></span>
                  <div className="nc-pay-input">
                    <input className="od-input nc-pay-amount" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
                    <span className="nc-pay-unit">€</span>
                  </div>
                  <span className="st-cmd-hint">Solde dû : {fmtMoney(owed)}.</span>
                </div>
                <div className="od-field">
                  <span className="od-label">Référence (n° chèque, virement…)</span>
                  <input className="od-input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="VIR-2026-09" />
                </div>
              </div>
              <div className="od-field">
                <span className="od-label">Mode de règlement</span>
                <div className="nc-pay-quick" role="radiogroup" aria-label="Mode de règlement">
                  {PAYMENT_MODES.map((m) => (
                    <button key={m} type="button" role="radio" aria-checked={mode === m} className={`nc-chip${mode === m ? " nc-chip--on" : ""}`} onClick={() => setMode(m)}>
                      {PAYMENT_MODE_LABEL[m]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="od-field">
                <span className="od-label">Note</span>
                <input className="od-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Relevé de septembre" />
              </div>
              <div className="od-field">
                <span className="od-label">Affectation (par échéance)</span>
                <div className="cx-alloc">
                  {preview.length === 0 ? (
                    <span className="st-cmd-hint">Saisissez un montant pour voir les commandes réglées.</span>
                  ) : (
                    preview.map((r) => (
                      <div key={r.order.id} className="cx-alloc-row">
                        <span>{r.order.ref} · échéance {frDate(r.order.echeance)}</span>
                        <strong>{fmtMoney(r.amount)}{r.amount < r.order.balance ? ` / ${fmtMoney(r.order.balance)}` : ""}</strong>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setSettleOpen(false)} disabled={busy}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitSettle()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  Enregistrer le règlement
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
