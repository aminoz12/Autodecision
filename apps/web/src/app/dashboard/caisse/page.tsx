"use client";

import {
  Banknote,
  Check,
  CreditCard,
  FileText,
  Landmark,
  Loader2,
  Lock,
  LockOpen,
  Printer,
  RefreshCw,
  Undo2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney } from "@/lib/data/saas";
import {
  closeCashSession,
  dayBounds,
  loadCashSessions,
  loadPaymentsBetween,
  loadSessionPayments,
  openCashSession,
  PAYMENT_KIND_LABEL,
  PAYMENT_MODE_LABEL,
  totalsByMode,
  type CashClosure,
  type CashSession,
  type Payment,
} from "@/lib/data/payments";

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function frTime(v: string) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function frDateTime(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function money(raw: string): number {
  const n = Number(String(raw).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export default function CaissePage() {
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;

  const [day, setDay] = useState(localToday());
  const [payments, setPayments] = useState<Payment[]>([]);
  const [sessions, setSessions] = useState<{ open: CashSession | null; history: CashSession[] }>({ open: null, history: [] });
  const [sessionPayments, setSessionPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const { from, to } = dayBounds(day);
      const [p, s] = await Promise.all([loadPaymentsBetween(supabase, orgId, from, to), loadCashSessions(supabase, orgId)]);
      setPayments(p);
      setSessions(s);
      setSessionPayments(s.open ? await loadSessionPayments(supabase, orgId, s.open.id) : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId, day]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => totalsByMode(payments), [payments]);
  const sessionTotals = useMemo(() => totalsByMode(sessionPayments), [sessionPayments]);
  const expectedCash = sessions.open ? Math.round((sessions.open.openingFloat + sessionTotals.ESPECES) * 100) / 100 : 0;

  const byStaff = useMemo(() => {
    const map = new Map<string, { name: string; total: number; count: number }>();
    for (const p of payments) {
      const key = p.receivedBy ?? "—";
      const cur = map.get(key) ?? { name: p.receivedByName ?? "—", total: 0, count: 0 };
      cur.total += (p.kind === "REMBOURSEMENT" ? -1 : 1) * p.amount;
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [payments]);

  /* ---- Open ---- */
  const [openFloat, setOpenFloat] = useState("0");
  const [busy, setBusy] = useState(false);
  const doOpen = async () => {
    setBusy(true);
    setError(null);
    try {
      await openCashSession(supabase, money(openFloat));
      setNotice(`Caisse ouverte avec un fond de ${fmtMoney(money(openFloat))}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---- Close (Z) ---- */
  const [closeOpen, setCloseOpen] = useState(false);
  const [counted, setCounted] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closure, setClosure] = useState<(CashClosure & { openedAt: string; payments: Payment[] }) | null>(null);

  const startClose = () => {
    setCounted(String(expectedCash.toFixed(2)));
    setCloseNote("");
    setCloseError(null);
    setCloseOpen(true);
  };
  const doClose = async () => {
    if (!sessions.open) return;
    setBusy(true);
    setCloseError(null);
    try {
      const snapshot = sessionPayments;
      const openedAt = sessions.open.openedAt;
      const res = await closeCashSession(supabase, money(counted), closeNote);
      setClosure({ ...res, openedAt, payments: snapshot });
      setCloseOpen(false);
      setNotice(
        `Caisse clôturée. Attendu ${fmtMoney(res.expected)}, compté ${fmtMoney(res.counted)}, écart ${fmtMoney(res.difference)}.`,
      );
      await load();
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const printZ = () => {
    const prev = document.title;
    document.title = `Z-caisse-${day}`;
    const reset = () => {
      document.title = prev;
      window.removeEventListener("afterprint", reset);
    };
    window.addEventListener("afterprint", reset);
    window.setTimeout(() => window.print(), 60);
  };

  const zTotals = closure ? totalsByMode(closure.payments) : null;

  return (
    <div className="rl-page">
      <header className="rl-header rl-header--row">
        <div>
          <h1 className="rl-title">Caisse</h1>
          <p className="rl-subtitle">Encaissements, remboursements et clôture de la journée.</p>
        </div>
        <div className="cx-actions">
          <input className="od-input cx-date" type="date" value={day} max={localToday()} onChange={(e) => setDay(e.target.value)} aria-label="Journée" />
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      {notice && (
        <div className="od-note cx-notice"><Check className="h-4 w-4" /><p>{notice}</p></div>
      )}

      {/* ---- Session ---- */}
      <section className={`od-card cx-session${sessions.open ? " is-open" : ""}`}>
        {sessions.open ? (
          <div className="cx-session-row">
            <span className="cx-session-icon"><LockOpen className="h-5 w-5" /></span>
            <div className="cx-session-text">
              <strong>Caisse ouverte</strong>
              <span>
                depuis le {frDateTime(sessions.open.openedAt)}
                {sessions.open.openedByName ? ` par ${sessions.open.openedByName}` : ""} · fond de caisse {fmtMoney(sessions.open.openingFloat)}
                {" · "}espèces attendues <strong>{fmtMoney(expectedCash)}</strong>
              </span>
            </div>
            <button type="button" className="od-btn od-btn--primary" onClick={startClose} disabled={busy}>
              <Lock className="h-4 w-4" /> Clôturer la caisse
            </button>
          </div>
        ) : (
          <div className="cx-session-row">
            <span className="cx-session-icon"><Lock className="h-5 w-5" /></span>
            <div className="cx-session-text">
              <strong>Caisse fermée</strong>
              <span>Ouvrez la caisse pour rattacher les encaissements en espèces du jour à une clôture.</span>
            </div>
            <div className="cx-open-form">
              <div className="nc-pay-input">
                <input className="od-input nc-pay-amount" type="number" min={0} step="0.01" value={openFloat} onChange={(e) => setOpenFloat(e.target.value)} aria-label="Fond de caisse" />
                <span className="nc-pay-unit">€</span>
              </div>
              <button type="button" className="od-btn od-btn--primary" onClick={() => void doOpen()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <LockOpen className="h-4 w-4" />} Ouvrir la caisse
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ---- Totals of the day ---- */}
      <div className="ga-stats cx-tiles">
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DCFCE7", color: "#16A34A" }}><Banknote className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.ESPECES)}</p><p className="ga-stat-label">Espèces</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}><CreditCard className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.CARTE)}</p><p className="ga-stat-label">Carte</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#EEF2FF", color: "#4F46E5" }}><Landmark className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.VIREMENT)}</p><p className="ga-stat-label">Virement</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#D97706" }}><FileText className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.CHEQUE)}</p><p className="ga-stat-label">Chèque</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FEE2E2", color: "#DC2626" }}><Undo2 className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.refunds)}</p><p className="ga-stat-label">Remboursements</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#0F172A", color: "#fff" }}><Check className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.total)}</p><p className="ga-stat-label">Net du jour · {totals.count} mouvement(s)</p></div></div>
      </div>

      <div className="cx-grid">
        <section className="od-card">
          <div className="od-card-title"><Banknote className="h-4 w-4" /> Mouvements du {new Date(day + "T12:00:00").toLocaleDateString("fr-FR")}</div>
          <div className="rl-table-wrap">
            <table className="stk-table">
              <thead>
                <tr><th>Heure</th><th>Client</th><th>Commande(s)</th><th>Type</th><th>Mode</th><th>Reçu par</th><th className="stk-th-center">Montant</th></tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td className="rl-muted-strong">{frTime(p.receivedAt)}</td>
                    <td>{p.clientId ? <Link href={`/dashboard/garages/${p.clientId}`}>{p.clientName ?? "Client"}</Link> : (p.clientName ?? "—")}</td>
                    <td className="rl-muted-strong">
                      {p.allocations.length > 0
                        ? p.allocations.map((a) => (
                            <Link key={a.orderId} href={`/dashboard/commandes/${a.orderId}`} style={{ marginRight: 6 }}>{a.orderRef}</Link>
                          ))
                        : p.orderId
                          ? <Link href={`/dashboard/commandes/${p.orderId}`}>{p.orderRef}</Link>
                          : "—"}
                    </td>
                    <td>{PAYMENT_KIND_LABEL[p.kind]}{p.reference ? ` · ${p.reference}` : ""}</td>
                    <td><span className="rt-badge rt-badge--blue">{PAYMENT_MODE_LABEL[p.mode]}</span></td>
                    <td className="rl-muted-strong">{p.receivedByName ?? "—"}</td>
                    <td className="stk-td-center" style={{ fontWeight: 700, color: p.kind === "REMBOURSEMENT" ? "#DC2626" : "#16A34A" }}>
                      {p.kind === "REMBOURSEMENT" ? "− " : ""}{fmtMoney(p.amount)}
                    </td>
                  </tr>
                ))}
                {!loading && payments.length === 0 && (
                  <tr><td colSpan={7} className="stk-empty">Aucun mouvement ce jour. Les encaissements se font depuis la fiche d'une commande (« Encaisser ») ou d'un garage (« Enregistrer un règlement »).</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <div className="cx-side">
          <section className="od-card">
            <div className="od-card-title">Par vendeur</div>
            {byStaff.length === 0 ? (
              <p className="st-cmd-hint">Rien à afficher.</p>
            ) : (
              <div className="gp-ledger">
                {byStaff.map((s) => (
                  <div key={s.name} className="gp-ledger-row"><span>{s.name} · {s.count}</span><strong>{fmtMoney(s.total)}</strong></div>
                ))}
              </div>
            )}
          </section>

          <section className="od-card">
            <div className="od-card-title">Dernières clôtures</div>
            <div className="rl-table-wrap">
              <table className="stk-table">
                <thead><tr><th>Clôturée le</th><th className="stk-th-center">Attendu</th><th className="stk-th-center">Compté</th><th className="stk-th-center">Écart</th></tr></thead>
                <tbody>
                  {sessions.history.slice(0, 15).map((s) => (
                    <tr key={s.id}>
                      <td className="rl-muted-strong">{frDateTime(s.closedAt)}{s.closedByName ? ` · ${s.closedByName}` : ""}</td>
                      <td className="stk-td-center">{fmtMoney(s.expectedCash ?? 0)}</td>
                      <td className="stk-td-center">{fmtMoney(s.countedCash ?? 0)}</td>
                      <td className="stk-td-center" style={{ fontWeight: 700, color: (s.difference ?? 0) === 0 ? "#16A34A" : "#DC2626" }}>{fmtMoney(s.difference ?? 0)}</td>
                    </tr>
                  ))}
                  {sessions.history.length === 0 && (
                    <tr><td colSpan={4} className="stk-empty">Aucune clôture pour l&apos;instant.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {closure && zTotals && (
            <section className="od-card cx-z">
              <div className="od-card-title"><FileText className="h-4 w-4" /> Z de caisse</div>
              <div className="gp-ledger">
                <div className="gp-ledger-row"><span>Fond de caisse</span><strong>{fmtMoney(closure.openingFloat)}</strong></div>
                <div className="gp-ledger-row"><span>Espèces encaissées</span><strong>{fmtMoney(closure.cashIn)}</strong></div>
                <div className="gp-ledger-row gp-ledger-row--credit"><span>Espèces remboursées</span><strong>− {fmtMoney(closure.cashOut)}</strong></div>
                <div className="gp-ledger-row"><span>Espèces attendues</span><strong>{fmtMoney(closure.expected)}</strong></div>
                <div className="gp-ledger-row"><span>Espèces comptées</span><strong>{fmtMoney(closure.counted)}</strong></div>
                <div className="gp-ledger-row gp-ledger-row--total"><span>Écart</span><strong style={{ color: closure.difference === 0 ? "#16A34A" : "#DC2626" }}>{fmtMoney(closure.difference)}</strong></div>
              </div>
              <div className="gp-ledger" style={{ marginTop: 10 }}>
                <div className="gp-ledger-row"><span>Carte</span><strong>{fmtMoney(zTotals.CARTE)}</strong></div>
                <div className="gp-ledger-row"><span>Virement</span><strong>{fmtMoney(zTotals.VIREMENT)}</strong></div>
                <div className="gp-ledger-row"><span>Chèque</span><strong>{fmtMoney(zTotals.CHEQUE)}</strong></div>
              </div>
              <button type="button" className="od-btn od-btn--outline" style={{ marginTop: 12 }} onClick={printZ}>
                <Printer className="h-4 w-4" /> Imprimer le Z
              </button>
            </section>
          )}
        </div>
      </div>

      {/* ---- Printable Z ---- */}
      {closure && zTotals && (
        <div className="print-doc">
          <div className="print-head">
            <div>
              <div className="print-org">{profile?.display_name ? "" : ""}Z DE CAISSE</div>
              <div className="print-org-line">Session du {frDateTime(closure.openedAt)} — clôturée le {frDateTime(new Date().toISOString())}</div>
            </div>
          </div>
          <table className="print-table">
            <tbody>
              <tr><td>Fond de caisse</td><td className="print-num">{fmtMoney(closure.openingFloat)}</td></tr>
              <tr><td>Espèces encaissées</td><td className="print-num">{fmtMoney(closure.cashIn)}</td></tr>
              <tr><td>Espèces remboursées</td><td className="print-num">− {fmtMoney(closure.cashOut)}</td></tr>
              <tr><td><strong>Espèces attendues</strong></td><td className="print-num"><strong>{fmtMoney(closure.expected)}</strong></td></tr>
              <tr><td>Espèces comptées</td><td className="print-num">{fmtMoney(closure.counted)}</td></tr>
              <tr><td><strong>Écart</strong></td><td className="print-num"><strong>{fmtMoney(closure.difference)}</strong></td></tr>
              <tr><td>Carte bancaire</td><td className="print-num">{fmtMoney(zTotals.CARTE)}</td></tr>
              <tr><td>Virement</td><td className="print-num">{fmtMoney(zTotals.VIREMENT)}</td></tr>
              <tr><td>Chèque</td><td className="print-num">{fmtMoney(zTotals.CHEQUE)}</td></tr>
              <tr><td><strong>Total net de la session</strong></td><td className="print-num"><strong>{fmtMoney(zTotals.total)}</strong></td></tr>
            </tbody>
          </table>
          <p className="print-foot">{closure.payments.length} mouvement(s). Document généré par Autodecision.</p>
        </div>
      )}

      {closeOpen && sessions.open && (
        <div className="ga-modal-overlay" onClick={() => !busy && setCloseOpen(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="close-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="close-title"><Lock className="h-4 w-4" /> Clôturer la caisse</span>
              <button type="button" className="ga-modal-close" onClick={() => setCloseOpen(false)} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {closeError && <div className="nc-error">{closeError}</div>}
              <div className="gp-ledger">
                <div className="gp-ledger-row"><span>Fond de caisse</span><strong>{fmtMoney(sessions.open.openingFloat)}</strong></div>
                <div className="gp-ledger-row"><span>Espèces nettes de la session</span><strong>{fmtMoney(sessionTotals.ESPECES)}</strong></div>
                <div className="gp-ledger-row gp-ledger-row--total"><span>Espèces attendues</span><strong>{fmtMoney(expectedCash)}</strong></div>
              </div>
              <div className="od-field">
                <span className="od-label">Espèces comptées <span className="od-req">*</span></span>
                <div className="nc-pay-input">
                  <input className="od-input nc-pay-amount" type="number" min={0} step="0.01" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />
                  <span className="nc-pay-unit">€</span>
                </div>
                <span className="st-cmd-hint">
                  Écart : <strong style={{ color: money(counted) - expectedCash === 0 ? "#16A34A" : "#DC2626" }}>{fmtMoney(Math.round((money(counted) - expectedCash) * 100) / 100)}</strong>
                </span>
              </div>
              <div className="od-field">
                <span className="od-label">Note</span>
                <input className="od-input" value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="Remarque sur la journée" />
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setCloseOpen(false)} disabled={busy}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void doClose()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Lock className="h-4 w-4" />} Clôturer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
