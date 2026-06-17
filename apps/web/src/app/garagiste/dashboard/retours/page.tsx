"use client";

import { ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import {
  createGarageReturn,
  loadGarageOrders,
  loadGarageReturns,
  RETURN_LABEL,
  type GarageOrder,
  type GarageReturn,
} from "@/lib/data/garage";

function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

export default function RetoursPage() {
  const { supabase, profile } = useAuth();
  const [orders, setOrders] = useState<GarageOrder[]>([]);
  const [returns, setReturns] = useState<GarageReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [orderId, setOrderId] = useState("");
  const [designation, setDesignation] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    setLoading(true);
    setError(null);
    try {
      const [o, r] = await Promise.all([
        loadGarageOrders(supabase, profile.organization_id, profile.client_id),
        loadGarageReturns(supabase, profile.organization_id, profile.client_id),
      ]);
      setOrders(o);
      setReturns(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.organization_id, profile?.client_id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!profile?.organization_id || !profile.client_id) return;
    if (!designation.trim() || !reason.trim()) {
      setError("Indiquez la pièce et le motif du retour.");
      return;
    }
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      await createGarageReturn(supabase, profile.organization_id, profile.client_id, {
        orderId: orderId || null,
        designation,
        reason,
      });
      setOrderId("");
      setDesignation("");
      setReason("");
      setMsg("Demande de retour envoyée à votre magasin.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="gp-page">
      <header className="gp-header">
        <h1 className="gp-title">Retours</h1>
        <p className="gp-subtitle">Demandez le retour d&apos;une pièce auprès de votre magasin.</p>
      </header>

      {error && <div className="nc-error">{error}</div>}
      {msg && <div className="nc-ok">{msg}</div>}

      <form onSubmit={submit} className="gp-card gp-form">
        <div className="gp-card-title">Nouvelle demande de retour</div>
        <div className="od-field">
          <span className="od-label">Commande concernée (optionnel)</span>
          <div className="od-select">
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
              <option value="">— Aucune / hors commande —</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>{o.ref} — {frDate(o.date)}</option>
              ))}
            </select>
            <ChevronDown className="h-4 w-4" />
          </div>
        </div>
        <div className="od-field">
          <span className="od-label">Pièce à retourner *</span>
          <input className="od-input" placeholder="Plaquettes de frein avant (GDB1330)" value={designation} onChange={(e) => setDesignation(e.target.value)} />
        </div>
        <div className="od-field">
          <span className="od-label">Motif *</span>
          <textarea className="gp-textarea" rows={3} placeholder="Pièce non conforme, erreur de référence…" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="gp-form-actions">
          <button type="submit" className="od-btn od-btn--primary" disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <RotateCcw className="h-4 w-4" />}
            {saving ? "Envoi…" : "Demander le retour"}
          </button>
        </div>
      </form>

      <section className="gp-card" style={{ marginTop: 18 }}>
        <div className="gp-card-title">Mes demandes de retour</div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr><th>Réf.</th><th>Pièce</th><th>Motif</th><th>Commande</th><th>Date</th><th>Statut</th></tr>
            </thead>
            <tbody>
              {returns.map((r) => {
                const st = RETURN_LABEL[r.status] ?? { label: r.status, cls: "amber" };
                return (
                  <tr key={r.id}>
                    <td className="stk-ref">{r.ref}</td>
                    <td>{r.designation}</td>
                    <td className="rl-muted">{r.reason}</td>
                    <td>{r.orderRef ?? "—"}</td>
                    <td className="rl-muted-strong">{frDate(r.createdAt)}</td>
                    <td><span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span></td>
                  </tr>
                );
              })}
              {!loading && returns.length === 0 && (
                <tr><td colSpan={6} className="stk-empty">Aucune demande de retour.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
