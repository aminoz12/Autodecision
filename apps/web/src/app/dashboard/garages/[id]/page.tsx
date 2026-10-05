"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPlus,
  FileText,
  HandCoins,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { ReceiveReturnDialog } from "@/components/returns/ReceiveReturnDialog";
import { GarageSavCard } from "@/components/sav/GarageSavCard";
import { createClient } from "@/lib/supabase/client";
import { PAYMENT_TERMS, PAYMENT_TERMS_LABEL, paymentTermsLabel, type PaymentTermsDays } from "@/lib/constants/enums";
import { deleteClient } from "@/lib/data/clients";
import { fmtMoney, validateGarageReturn } from "@/lib/data/saas";
import { ensureSupplierTour, nextTourFromServer } from "@/lib/data/tournees";
import { LINE_RETURN_LABEL, REGLEMENT_LABEL, lineReglement, lineReturnState, type LineReglement } from "@/lib/garage-line-state";
import {
  buildGarageStatement,
  DEVIS_LABEL,
  GARAGE_STAGE_LABEL,
  garageStage,
  loadGarageCredits,
  loadGarageInfo,
  loadGarageOrdersForStaff,
  loadGarageReturns,
  setLineReglement,
  updatePaymentTerms,
  type GarageCredit,
  type GarageReturn,
  type GarageInfo,
  type GarageOrder,
} from "@/lib/data/garage";
import {
  imputeCreditNote,
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
  // The same file serves a garage (/dashboard/garages/…) and a client PRO (/dashboard/pros/…).
  const isPro = (usePathname() ?? "").startsWith("/dashboard/pros");
  const listHref = isPro ? "/dashboard/pros" : "/dashboard/garages";
  const listLabel = isPro ? "Clients PRO" : "Garages";
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;
  const router = useRouter();
  /** Deleting a garage or a client PRO is reserved to administrators (delete_client checks it too). */
  const isAdmin = profile?.role === "ADMIN";

  const [garage, setGarage] = useState<GarageInfo | null>(null);
  const [orders, setOrders] = useState<GarageOrder[]>([]);
  const [credits, setCredits] = useState<GarageCredit[]>([]);
  const [returnCount, setReturnCount] = useState(0);
  const [returns, setReturns] = useState<GarageReturn[]>([]);
  /** Orders opened to their lines. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [lineBusy, setLineBusy] = useState<string | null>(null);
  /** « Payé » on a line: the payment is recorded through the règlement modal, then the label is set. */
  const [payLine, setPayLine] = useState<{ orderId: string; lineId: string } | null>(null);
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
      setReturns(r);
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
  /** « Régler » on one order of « Commandes à régler »: the money goes to that order only. */
  const [settleOrderId, setSettleOrderId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PaymentMode>("VIREMENT");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  /** The order the règlement is restricted to (a line's « Payé », or « Régler »), else the whole account. */
  const scopeId = payLine?.orderId ?? settleOrderId;
  const scopeOrders = useMemo(() => (scopeId ? openOrders.filter((o) => o.id === scopeId) : openOrders), [openOrders, scopeId]);
  const scopeOwed = scopeOrders.reduce((s, o) => s + o.balance, 0);
  const scopeRef = scopeId ? orders.find((o) => o.id === scopeId)?.ref ?? null : null;

  const openSettle = () => {
    setPayLine(null);
    setSettleOrderId(null);
    setAmount(owed > 0 ? String(owed.toFixed(2)) : "");
    setMode("VIREMENT");
    setReference("");
    setNote("");
    setSettleError(null);
    setSettleOpen(true);
  };

  /** The garage pays one given order: the whole of what is left on it, by default. */
  const openSettleOrder = (o: GarageOrder) => {
    setPayLine(null);
    setSettleOrderId(o.id);
    setAmount(o.balance.toFixed(2));
    setMode("VIREMENT");
    setReference("");
    setNote(`Règlement ${o.ref}`);
    setSettleError(null);
    setSettleOpen(true);
  };

  /** Preview of the FIFO allocation the server will apply (by échéance, then date). */
  const preview = useMemo(() => {
    let remaining = money(amount);
    const rows: { order: GarageOrder; amount: number }[] = [];
    for (const o of scopeOrders) {
      if (remaining <= 0) break;
      const a = Math.min(remaining, o.balance);
      rows.push({ order: o, amount: a });
      remaining = Math.round((remaining - a) * 100) / 100;
    }
    return rows;
  }, [amount, scopeOrders]);

  const submitSettle = async () => {
    const a = money(amount);
    if (a <= 0) {
      setSettleError("Indiquez le montant reçu.");
      return;
    }
    if (a > scopeOwed + 0.005) {
      setSettleError(
        scopeRef ? `Le montant dépasse ce qui reste dû sur ${scopeRef} (${fmtMoney(scopeOwed)}).` : `Le montant dépasse le solde dû (${fmtMoney(scopeOwed)}).`,
      );
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
        orderIds: scopeId ? [scopeId] : undefined,
      });
      if (payLine) {
        await setLineReglement(supabase, payLine.lineId, "PAYE").catch(() => {});
        setPayLine(null);
      }
      setSettleOrderId(null);
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

  /* ---- Avoirs : déduire de l'encours ---- */
  const [creditBusy, setCreditBusy] = useState<string | null>(null);
  async function deductCredit(credit: GarageCredit) {
    const who = isPro ? "le client" : "le garage";
    if (!window.confirm(`Déduire l'avoir ${credit.num} (${fmtMoney(credit.remaining)}) de ce que ${who} doit ? Les commandes les plus anciennes sont réglées d'abord.`)) return;
    setCreditBusy(credit.id);
    setError(null);
    try {
      const r = await imputeCreditNote(supabase, credit.id);
      const refs = r.allocations.map((a) => `${a.ref} ${fmtMoney(a.amount)}`).join(", ");
      setNotice(
        `${fmtMoney(r.imputed)} de l'avoir ${r.num} déduits de l'encours (${refs})` +
          (r.remaining > 0 ? ` ; ${fmtMoney(r.remaining)} restent sur l'avoir.` : " ; l'avoir est entièrement utilisé."),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreditBusy(null);
    }
  }

  /* ---- Supprimer le garage / client PRO (administrateur) ---- */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  async function submitDelete() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await deleteClient(supabase, garageId);
      router.push(listHref);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleteBusy(false);
    }
  }

  /* ---- Réception d'un retour demandé par le garage ---- */
  const [receiving, setReceiving] = useState<GarageReturn | null>(null);

  /* ---- Délai de paiement ---- */
  const [termsOpen, setTermsOpen] = useState(false);
  const [terms, setTerms] = useState<PaymentTermsDays>(30);
  const [termsBusy, setTermsBusy] = useState(false);
  const [termsError, setTermsError] = useState<string | null>(null);
  /** Unpaid on-account orders: their due date stays as it is. */
  const datedOrders = openOrders.filter((o) => o.echeance).length;

  const openTerms = () => {
    const current = garage?.paymentTermsDays ?? 30;
    setTerms((PAYMENT_TERMS as readonly number[]).includes(current) ? (current as PaymentTermsDays) : 30);
    setTermsError(null);
    setTermsOpen(true);
  };

  const submitTerms = async () => {
    setTermsBusy(true);
    setTermsError(null);
    try {
      await updatePaymentTerms(supabase, garageId, terms);
      setGarage((g) => (g ? { ...g, paymentTermsDays: terms } : g));
      setTermsOpen(false);
      setNotice(
        `Délai de paiement : ${paymentTermsLabel(terms).toLowerCase()}. Il s'applique aux prochaines commandes en compte` +
          (datedOrders > 0 ? ` ; les ${datedOrders > 1 ? `${datedOrders} commandes` : "commande"} à régler gardent leur échéance.` : "."),
      );
    } catch (e) {
      setTermsError(e instanceof Error ? e.message : String(e));
    } finally {
      setTermsBusy(false);
    }
  };

  /* ---- Lignes : règlement + retours ---- */
  function toggleOrder(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function setReglement(order: GarageOrder, line: GarageOrder["lines"][number], code: LineReglement) {
    const gifted = line.reglement === "OFFERT" ? line.offertAmount ?? 0 : 0;
    if (code === "OFFERT") {
      const off = Math.min(line.lineTotal, Math.max(0, order.balance));
      const text =
        line.offertAmount === null
          ? "Marquer cette pièce « offerte » ? Le solde dû ne sera pas modifié tant que la migration 20261001030000 n\u2019est pas appliquée."
          : off > 0.005
            ? `Offrir cette pièce ? ${fmtMoney(off)} seront retirés du solde dû de la commande ${order.ref}.`
            : "Cette commande est déjà réglée : la pièce sera seulement étiquetée « offerte ». Pour rendre de l\u2019argent, émettez un avoir.";
      if (!window.confirm(text)) return;
    }
    setLineBusy(line.id);
    setError(null);
    try {
      if (code === "PAYE") {
        // An offered line comes back on the balance before it can be paid.
        if (gifted > 0) {
          await setLineReglement(supabase, line.id, "A_PAYER");
          await load();
        }
        const due = order.balance + gifted;
        if (due > 0.005) {
          // Money first: the standard règlement, restricted to this order, prefilled with the line.
          setSettleOrderId(null);
          setPayLine({ orderId: order.id, lineId: line.id });
          setAmount(Math.min(due, line.lineTotal).toFixed(2));
          setMode("VIREMENT");
          setReference("");
          setNote(`Règlement ${line.reference} — ${order.ref}`);
          setSettleError(null);
          setSettleOpen(true);
          return;
        }
      }
      await setLineReglement(supabase, line.id, code);
      if (code === "OFFERT" && line.offertAmount !== null) {
        const off = Math.min(line.lineTotal, Math.max(0, order.balance));
        if (off > 0.005) setNotice(`Pièce offerte : ${fmtMoney(off)} retirés du solde de ${order.ref}.`);
      } else if (gifted > 0) {
        setNotice(`${fmtMoney(gifted)} remis dans le solde de ${order.ref}.`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLineBusy(null);
    }
  }
  async function validateRequest(ret: GarageReturn, accept: boolean) {
    setLineBusy(ret.lineId ?? ret.id);
    setError(null);
    try {
      let tourId: string | null = null;
      if (accept) {
        const next = await nextTourFromServer(supabase);
        tourId = await ensureSupplierTour(supabase, { date: next.date, name: next.name, slot: next.slot });
      }
      await validateGarageReturn(supabase, ret.id, accept, tourId);
      setNotice(accept ? `${ret.ref} validé : à récupérer, confié au livreur.` : `${ret.ref} refusé.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLineBusy(null);
    }
  }
  /** « Réceptionner » opens the dialog: the part comes back, and the counter says what happens to the money. */
  function receiveRequest(ret: GarageReturn) {
    setError(null);
    setReceiving(ret);
  }

  if (!loading && !garage) {
    return (
      <div className="od-page">
        <nav className="od-breadcrumb">
          <Link href={listHref}>{listLabel}</Link>
        </nav>
        <div className="od-card rc-empty"><p>{error ?? (isPro ? "Client PRO introuvable." : "Garage introuvable.")}</p></div>
      </div>
    );
  }

  const balanceTone = statement.balance > 0 ? "#DC2626" : "#16A34A";

  return (
    <div className="od-page">
      <nav className="od-breadcrumb">
        <Link href={listHref} className="od-breadcrumb-back">
          <ArrowLeft className="h-3.5 w-3.5" /> {listLabel}
        </Link>
      </nav>

      <header className="rl-header rl-header--row">
        <div>
          <h1 className="rl-title">{garage?.name ?? (isPro ? "Client PRO" : "Garage")}</h1>
          <p className="rl-subtitle">
            <span className="ga-contact-row"><Phone className="h-3.5 w-3.5" />{garage?.phone ?? "—"}</span>
            {" · "}
            <span className="ga-contact-row"><Mail className="h-3.5 w-3.5" />{garage?.email ?? "—"}</span>
            {" · "}
            <span className="ga-contact-row"><MapPin className="h-3.5 w-3.5" />{garage?.city ?? "—"}</span>
          </p>
        </div>
        <div className="cx-actions">
          <button type="button" className="gp-terms gp-terms--edit" onClick={openTerms} disabled={!garage} title="Changer le délai de paiement">
            <CalendarClock className="h-3.5 w-3.5" />
            En compte · {paymentTermsLabel(garage?.paymentTermsDays ?? 30).toLowerCase()}
            <Pencil className="h-3 w-3" />
          </button>
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
          {isAdmin && (
            <button
              type="button"
              className="od-btn od-btn--danger"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
              disabled={!garage}
              title={isPro ? "Supprimer ce client PRO" : "Supprimer ce garage"}
            >
              <Trash2 className="h-4 w-4" /> Supprimer
            </button>
          )}
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
          {credits.length > 0 && (
            <div className="cx-alloc">
              {credits.map((c) => (
                <div key={c.id} className="cx-alloc-row">
                  <span>
                    Avoir {c.num} · reste {fmtMoney(c.remaining)}
                    {c.dueAt ? ` · valable jusqu'au ${frDate(c.dueAt)}` : ""}
                  </span>
                  <button
                    type="button"
                    className="rc-act rc-act--recu"
                    disabled={owed <= 0 || creditBusy !== null}
                    onClick={() => void deductCredit(c)}
                    title={owed > 0 ? "Payer les commandes à régler avec cet avoir" : "Rien à régler sur ce compte"}
                  >
                    {creditBusy === c.id ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Check className="h-3.5 w-3.5" />} Déduire de l&apos;encours
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="od-card">
          <div className="od-card-title"><Banknote className="h-4 w-4" /> Commandes à régler</div>
          <div className="rl-table-wrap">
            <table className="stk-table">
              <thead>
                <tr><th>Commande</th><th>Date</th><th>Échéance</th><th className="stk-th-center">Total</th><th className="stk-th-center">Reste</th><th /></tr>
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
                      <td className="stk-td-center">
                        <button type="button" className="rc-act rc-act--recu" onClick={() => openSettleOrder(o)} title={`Enregistrer le règlement de ${o.ref}`}>
                          <HandCoins className="h-3.5 w-3.5" /> Régler
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!loading && openOrders.length === 0 && (
                  <tr><td colSpan={6} className="stk-empty">Aucune commande en attente de règlement.</td></tr>
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
                <tr><td colSpan={7} className="stk-empty">Aucun règlement enregistré pour ce {isPro ? "client" : "garage"}.</td></tr>
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
                const open = expanded.has(o.id);
                return (
                  <Fragment key={o.id}>
                    <tr className={`ga-order-row${open ? " ga-order-row--open" : ""}`} onClick={() => toggleOrder(o.id)} aria-expanded={open}>
                      <td className="stk-ref">
                        <span className="ga-order-chev">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
                        <Link href={`/dashboard/commandes/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.ref}</Link>
                        <span className="ga-order-count">{o.lines.length} art.</span>
                      </td>
                      <td className="rl-muted-strong">{frDate(o.date)}</td>
                      <td><span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span></td>
                      <td className="rl-muted-strong">{o.balance > 0 ? frDate(o.echeance) : "—"}</td>
                      <td className="stk-td-center">
                        {fmtMoney(o.total)}
                        {o.offert > 0 && <span className="ga-offert">dont offert {fmtMoney(o.offert)}</span>}
                      </td>
                      <td className="stk-td-center">{fmtMoney(o.paid)}</td>
                      <td className="stk-td-center" style={{ color: o.balance > 0 ? "#DC2626" : "#16A34A", fontWeight: 700 }}>{fmtMoney(o.balance)}</td>
                    </tr>
                    {open && (
                      <tr className="ga-order-lines-row">
                        <td colSpan={7}>
                          <div className="ga-lines">
                            {o.lines.map((l) => {
                              const rs = lineReturnState(returns, l.id);
                              const reg = lineReglement(l.reglement, o.balance);
                              const cur = rs.current;
                              const busyLine = lineBusy === l.id;
                              return (
                                <div key={l.id} className="ga-line">
                                  <div className="ga-line-main">
                                    <strong>{l.designation || l.reference}</strong>
                                    <span className="rl-muted">
                                      {l.reference} · {l.quantity} × {fmtMoney(l.unitPrice)} = {fmtMoney(l.lineTotal)}
                                      {(l.offertAmount ?? 0) > 0 ? ` · offert : − ${fmtMoney(l.offertAmount ?? 0)}` : ""}
                                    </span>
                                  </div>
                                  <div className="ga-line-state">
                                    <span className={`rt-badge rt-badge--${REGLEMENT_LABEL[reg].cls}`}>{REGLEMENT_LABEL[reg].label.toUpperCase()}</span>
                                    <span className="ga-line-sep">·</span>
                                    <span className={`rt-badge rt-badge--${LINE_RETURN_LABEL[rs.state].cls}`}>
                                      {LINE_RETURN_LABEL[rs.state].label.toUpperCase()}
                                      {cur && cur.quantity > 1 ? ` ×${cur.quantity}` : ""}
                                    </span>
                                  </div>
                                  <div className="ga-line-acts">
                                    {!o.devis &&
                                      (["PAYE", "OFFERT", "A_PAYER"] as LineReglement[]).map((code) => (
                                        <button
                                          key={code}
                                          type="button"
                                          className={`rc-act ${reg === code ? "rc-act--retour" : "rc-act--quiet"}`}
                                          disabled={busyLine || reg === code}
                                          onClick={() => void setReglement(o, l, code)}
                                          title={code === "PAYE" ? "Enregistrer le règlement de cette pièce" : code === "OFFERT" ? "Pièce offerte au garage : son montant est retiré du solde dû" : "Reste à payer"}
                                        >
                                          {REGLEMENT_LABEL[code].label}
                                        </button>
                                      ))}
                                    {cur && rs.state === "REQUESTED" && (
                                      <>
                                        <button type="button" className="rc-act rc-act--recu" disabled={busyLine} onClick={() => void validateRequest(cur, true)}>
                                          {busyLine ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Check className="h-3.5 w-3.5" />} Valider le retour
                                        </button>
                                        <button type="button" className="rc-act rc-act--nonrecu" disabled={busyLine} onClick={() => void validateRequest(cur, false)}>
                                          <X className="h-3.5 w-3.5" /> Refuser
                                        </button>
                                      </>
                                    )}
                                    {cur && (rs.state === "COLLECTED" || rs.state === "TO_COLLECT") && (
                                      <button
                                        type="button"
                                        className={`rc-act ${rs.state === "COLLECTED" ? "rc-act--recu" : "rc-act--quiet"}`}
                                        disabled={busyLine}
                                        onClick={() => void receiveRequest(cur)}
                                        title={rs.state === "COLLECTED" ? "La pièce est revenue avec le livreur : la remettre en stock" : "Le livreur n\u2019a pas encore marqué la pièce récupérée"}
                                      >
                                        {busyLine ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Check className="h-3.5 w-3.5" />} Réceptionner
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                            {o.lines.length === 0 && <p className="rl-muted">Aucun article sur cette commande.</p>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!loading && orders.length === 0 && (
                <tr><td colSpan={7} className="stk-empty">Aucune commande pour ce {isPro ? "client" : "garage"}.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {termsOpen && (
        <div className="ga-modal-overlay" onClick={() => !termsBusy && setTermsOpen(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="terms-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="terms-title"><CalendarClock className="h-4 w-4" /> Délai de paiement de {garage?.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setTermsOpen(false)} aria-label="Fermer" disabled={termsBusy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {termsError && <div className="nc-error">{termsError}</div>}
              <div className="od-field">
                <span className="od-label">Délai de paiement (en compte)</span>
                <div className="nc-pay-quick" role="radiogroup" aria-label="Délai de paiement">
                  {PAYMENT_TERMS.map((d) => (
                    <button key={d} type="button" role="radio" aria-checked={terms === d} className={`nc-chip${terms === d ? " nc-chip--on" : ""}`} onClick={() => setTerms(d)}>
                      {PAYMENT_TERMS_LABEL[d]}
                    </button>
                  ))}
                </div>
                <span className="st-cmd-hint">
                  Les prochaines commandes en compte seront à régler sous {terms} jours.
                  {datedOrders > 0 &&
                    ` ${datedOrders > 1 ? `Les ${datedOrders} commandes encore à régler gardent` : "La commande encore à régler garde"} l'échéance déjà fixée.`}
                </span>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setTermsOpen(false)} disabled={termsBusy}>Annuler</button>
                <button
                  type="button"
                  className="od-btn od-btn--primary"
                  onClick={() => void submitTerms()}
                  disabled={termsBusy || terms === (garage?.paymentTermsDays ?? 30)}
                >
                  {termsBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  Enregistrer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteOpen && garage && (
        <div className="ga-modal-overlay" onClick={() => !deleteBusy && setDeleteOpen(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="delete-title"><Trash2 className="h-4 w-4" /> Supprimer {garage.name}</span>
              <button type="button" className="ga-modal-close" onClick={() => setDeleteOpen(false)} aria-label="Fermer" disabled={deleteBusy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              <p className="od-hint">
                La fiche {isPro ? "du client PRO" : "du garage"} et ses coordonnées sont effacées définitivement.
                {statement.orderCount > 0 ? ` Ses ${statement.orderCount} commande(s) restent dans l'historique, sans fiche.` : ""}{" "}
                Impossible s&apos;il reste une commande non réglée, un avoir, une facture, une consigne en cours
                {isPro ? "" : " ou un accès au portail garage (à supprimer d'abord dans Admin → Accès garagistes)"}.
              </p>
              {deleteError && <div className="nc-error">{deleteError}</div>}
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setDeleteOpen(false)} disabled={deleteBusy}>Annuler</button>
                <button type="button" className="od-btn od-btn--danger" onClick={() => void submitDelete()} disabled={deleteBusy}>
                  {deleteBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Trash2 className="h-4 w-4" />}
                  Supprimer définitivement
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {receiving && (
        <ReceiveReturnDialog
          ret={{
            id: receiving.id,
            ref: receiving.ref,
            designation: receiving.designation,
            quantity: receiving.quantity,
            amount: receiving.amount,
            orderId: receiving.orderId,
            orderRef: receiving.orderRef,
            legDone: receiving.legDone,
          }}
          supabase={supabase}
          onClose={() => setReceiving(null)}
          onDone={(message) => {
            setReceiving(null);
            setNotice(message);
            void load();
          }}
        />
      )}

      {settleOpen && (
        <div className="ga-modal-overlay" onClick={() => !busy && setSettleOpen(false)}>
          <div className="ga-modal ga-modal--wide" role="dialog" aria-modal="true" aria-labelledby="settle-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="settle-title"><HandCoins className="h-4 w-4" /> Règlement {scopeRef ? `de ${scopeRef} · ` : "de "}{garage?.name}</span>
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
                  <span className="st-cmd-hint">{scopeRef ? `Reste dû sur ${scopeRef} : ${fmtMoney(scopeOwed)}.` : `Solde dû : ${fmtMoney(owed)}.`}</span>
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
