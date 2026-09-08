"use client";

import { FileText, Loader2, Printer, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney } from "@/lib/data/saas";
import { loadInvoices, type Invoice } from "@/lib/data/invoices";

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

export default function FacturesPage() {
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id;
  const [month, setMonth] = useState(currentMonth());
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await loadInvoices(supabase, orgId, all ? {} : { month }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId, month, all]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const f = rows.filter((r) => r.kind === "FACTURE");
    const a = rows.filter((r) => r.kind === "AVOIR");
    return {
      count: f.length,
      ht: f.reduce((s, r) => s + r.totals.ht, 0) - a.reduce((s, r) => s + r.totals.ht, 0),
      tva: f.reduce((s, r) => s + r.totals.tva, 0) - a.reduce((s, r) => s + r.totals.tva, 0),
      ttc: f.reduce((s, r) => s + r.totals.ttc, 0) - a.reduce((s, r) => s + r.totals.ttc, 0),
      avoirs: a.length,
    };
  }, [rows]);

  return (
    <div className="rl-page">
      <header className="rl-header rl-header--row">
        <div>
          <h1 className="rl-title">Factures</h1>
          <p className="rl-subtitle">Documents émis, numérotés en continu et immuables. Une erreur se corrige par un avoir.</p>
        </div>
        <div className="cx-actions">
          <input className="od-input cx-date" type="month" value={month} onChange={(e) => { setAll(false); setMonth(e.target.value); }} aria-label="Mois" disabled={all} />
          <button type="button" className={`nc-chip${all ? " nc-chip--on" : ""}`} onClick={() => setAll((v) => !v)}>Toutes</button>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />} Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="ga-stats cx-tiles">
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#EEF2FF", color: "#4F46E5" }}><FileText className="h-5 w-5" /></span><div><p className="ga-stat-value">{totals.count}</p><p className="ga-stat-label">Factures{totals.avoirs ? ` · ${totals.avoirs} avoir(s)` : ""}</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}><FileText className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.ht)}</p><p className="ga-stat-label">Total HT net</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#D97706" }}><FileText className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.tva)}</p><p className="ga-stat-label">TVA collectée</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DCFCE7", color: "#16A34A" }}><FileText className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.ttc)}</p><p className="ga-stat-label">Total TTC net</p></div></div>
      </div>

      <section className="od-card">
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr><th>Numéro</th><th>Type</th><th>Date</th><th>Client</th><th>Commande</th><th className="stk-th-center">HT</th><th className="stk-th-center">TVA</th><th className="stk-th-center">TTC</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="stk-ref"><Link href={`/dashboard/factures/${r.id}`}>{r.number}</Link></td>
                  <td><span className={`rt-badge rt-badge--${r.kind === "AVOIR" ? "amber" : "blue"}`}>{r.kind === "AVOIR" ? "Avoir" : "Facture"}</span></td>
                  <td className="rl-muted-strong">{frDate(r.issuedAt)}</td>
                  <td>{r.clientId ? <Link href={r.buyer.isGarage ? `/dashboard/garages/${r.clientId}` : `/dashboard/clients/${r.clientId}`}>{r.buyer.name}</Link> : r.buyer.name}</td>
                  <td className="rl-muted-strong">{r.orderId ? <Link href={`/dashboard/commandes/${r.orderId}`}>{r.orderRef}</Link> : "—"}</td>
                  <td className="stk-td-center">{fmtMoney(r.totals.ht)}</td>
                  <td className="stk-td-center">{fmtMoney(r.totals.tva)}</td>
                  <td className="stk-td-center" style={{ fontWeight: 700 }}>{r.kind === "AVOIR" ? "− " : ""}{fmtMoney(r.totals.ttc)}</td>
                  <td className="od-td-right"><Link href={`/dashboard/factures/${r.id}`} className="od-btn od-btn--ghost"><Printer className="h-4 w-4" /> Voir</Link></td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={9} className="stk-empty">Aucun document sur cette période. Une facture s&apos;émet depuis la fiche d&apos;une commande (« Émettre la facture »).</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
