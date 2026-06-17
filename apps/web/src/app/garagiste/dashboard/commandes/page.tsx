"use client";

import { Check, Loader2, Package, RefreshCw, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import {
  acceptDevisOrder,
  DEVIS_LABEL,
  loadGarageOrders,
  refuseDevisOrder,
  WORKFLOW_LABEL,
  type GarageOrder,
} from "@/lib/data/garage";

function eur(v: number) {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
function frDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}
const LINE_STATUS: Record<string, string> = {
  PENDING: "En attente",
  RECEIVED: "Reçue",
  BACKORDER: "Reliquat",
  NOT_RECEIVED: "Non reçue",
};

export default function GarageOrdersPage() {
  const { supabase, profile } = useAuth();
  const [orders, setOrders] = useState<GarageOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    setLoading(true);
    setError(null);
    try {
      setOrders(await loadGarageOrders(supabase, profile.organization_id, profile.client_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, profile?.organization_id, profile?.client_id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(orderId: string, action: "accept" | "refuse") {
    if (!profile?.organization_id) return;
    setBusy(orderId + action);
    setError(null);
    try {
      if (action === "accept") await acceptDevisOrder(supabase, profile.organization_id, orderId);
      else await refuseDevisOrder(supabase, profile.organization_id, orderId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="gp-page">
      <header className="gp-header gp-header--row">
        <div>
          <h1 className="gp-title">Mes commandes</h1>
          <p className="gp-subtitle">Suivez vos devis et commandes auprès de votre magasin.</p>
        </div>
        <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualiser
        </button>
      </header>

      {error && <div className="nc-error">{error}</div>}

      {loading && orders.length === 0 ? (
        <div className="gp-card gp-empty">Chargement…</div>
      ) : orders.length === 0 ? (
        <div className="gp-card gp-empty">
          <Package className="h-7 w-7" style={{ color: "#9CA3AF" }} />
          <p>Aucune commande pour le moment.</p>
          <Link href="/garagiste/dashboard/commander" className="od-btn od-btn--primary">Passer une commande</Link>
        </div>
      ) : (
        <div className="gp-order-list">
          {orders.map((o) => {
            const isDevis = o.devis;
            const quoted = isDevis && o.devisStatus === "QUOTED";
            const badge = isDevis
              ? DEVIS_LABEL[o.devisStatus ?? "REQUESTED"] ?? { label: "Devis", cls: "amber" }
              : WORKFLOW_LABEL[o.workflow] ?? { label: o.workflow, cls: "amber" };
            const received = o.lines.filter((l) => l.status === "RECEIVED").length;
            const quoteTotal = o.lines
              .filter((l) => l.disponible !== false)
              .reduce((s, l) => s + l.lineTotal, 0);
            return (
              <article key={o.id} className="gp-order">
                <div className="gp-order-head">
                  <div>
                    <span className="gp-order-ref">{o.ref}</span>
                    <span className="gp-order-date">{frDate(o.date)}</span>
                  </div>
                  <span className={`rt-badge rt-badge--${badge.cls}`}>{badge.label}</span>
                </div>

                <div className="gp-order-lines">
                  {o.lines.map((l) => (
                    <div key={l.id} className="gp-order-line">
                      <span className="gp-ol-ref">{l.reference}</span>
                      <span className="gp-ol-desig">{l.designation}</span>
                      <span className="gp-ol-qty">×{l.quantity}</span>
                      {quoted ? (
                        <span className="gp-ol-status">
                          {l.disponible === false ? (
                            <span style={{ color: "#DC2626" }}>Non disponible</span>
                          ) : (
                            <span style={{ color: "#16A34A" }}>{eur(l.lineTotal)}</span>
                          )}
                        </span>
                      ) : (
                        <span className="gp-ol-status">
                          {isDevis ? "—" : LINE_STATUS[l.status] ?? l.status}
                        </span>
                      )}
                    </div>
                  ))}
                </div>

                {quoted ? (
                  <div className="gp-order-foot">
                    <span className="gp-order-total">Total devis : {eur(quoteTotal)}</span>
                    <span className="gp-quote-actions">
                      <button
                        type="button"
                        className="od-btn od-btn--ghost"
                        disabled={busy === o.id + "refuse"}
                        onClick={() => act(o.id, "refuse")}
                      >
                        {busy === o.id + "refuse" ? <Loader2 className="h-4 w-4 nc-spin" /> : <X className="h-4 w-4" />}
                        Refuser
                      </button>
                      <button
                        type="button"
                        className="od-btn od-btn--primary"
                        disabled={busy === o.id + "accept"}
                        onClick={() => act(o.id, "accept")}
                      >
                        {busy === o.id + "accept" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                        Accepter le devis
                      </button>
                    </span>
                  </div>
                ) : isDevis ? (
                  <div className="gp-order-foot">
                    <span className="gp-order-prog">
                      {o.devisStatus === "REFUSED" ? "Devis refusé" : "En attente de la réponse du magasin…"}
                    </span>
                  </div>
                ) : (
                  <div className="gp-order-foot">
                    <span className="gp-order-prog">{received}/{o.lines.length} pièce(s) reçue(s)</span>
                    <span className="gp-order-total">
                      {eur(o.total)}
                      {o.balance > 0 && <span className="gp-order-balance"> · reste {eur(o.balance)}</span>}
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
