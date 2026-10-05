"use client";

import { Car, Check, ChevronDown, Loader2, Package, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import {
  acceptDevisOrder,
  DEVIS_LABEL,
  GARAGE_STAGE_LABEL,
  garageStage,
  loadGarageOrders,
  matchesGarageOrderSearch,
  refuseDevisOrder,
  type GarageOrder,
  loadGarageReturns,
  requestGarageLineReturn,
  type GarageOrderLine,
  type GarageReturn,
} from "@/lib/data/garage";
import { RETURN_MOTIFS } from "@/lib/sav";
import { LINE_RETURN_LABEL, lineReturnState, returnableQuantity } from "@/lib/garage-line-state";

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
  /** Plate (or order number / part reference) typed in the search box. */
  const [search, setSearch] = useState("");
  const visible = useMemo(() => orders.filter((o) => matchesGarageOrderSearch(o, search)), [orders, search]);
  /* ---- Demander un retour, article par article ---- */
  const [returns, setReturns] = useState<GarageReturn[]>([]);
  const [request, setRequest] = useState<{ order: GarageOrder; line: GarageOrderLine; left: number } | null>(null);
  const [qty, setQty] = useState(1);
  const [motif, setMotif] = useState("");
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    setLoading(true);
    setError(null);
    try {
      setOrders(await loadGarageOrders(supabase, profile.organization_id, profile.client_id));
      setReturns(await loadGarageReturns(supabase, profile.organization_id, profile.client_id).catch(() => [] as GarageReturn[]));
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

  function openRequest(order: GarageOrder, line: GarageOrderLine, left: number) {
    setRequest({ order, line, left });
    setQty(1);
    setMotif("");
    setComment("");
    setRequestError(null);
  }

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault();
    if (!request || !motif) return;
    setSaving(true);
    setRequestError(null);
    try {
      const ref = await requestGarageLineReturn(supabase, { lineId: request.line.id, quantity: qty, motifCode: motif, comment });
      setNotice(`Demande ${ref} envoyée au magasin : ${qty} × ${request.line.designation || request.line.reference}. Vous serez prévenu dès sa validation.`);
      setRequest(null);
      await load();
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
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

      {notice && <div className="nc-ok">{notice}</div>}

      {orders.length > 0 && (
        <div className="stk-search gp-order-search">
          <Search className="stk-search-icon" />
          <input
            className="stk-search-input"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher par plaque (AB-123-CD), n° de commande ou référence…"
            aria-label="Rechercher une commande par plaque, numéro ou référence"
          />
          {search && (
            <button type="button" className="stk-search-clear" onClick={() => setSearch("")} aria-label="Effacer la recherche">
              <X />
            </button>
          )}
        </div>
      )}
      {search.trim() && orders.length > 0 && (
        <p className="gp-order-search-count">
          {visible.length === 0
            ? `Aucune commande pour « ${search.trim()} ».`
            : `${visible.length} commande${visible.length > 1 ? "s" : ""} pour « ${search.trim()} »`}
        </p>
      )}

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
          {visible.map((o) => {
            const isDevis = o.devis;
            const quoted = isDevis && o.devisStatus === "QUOTED";
            const stage = isDevis ? null : garageStage(o);
            const badge = isDevis
              ? DEVIS_LABEL[o.devisStatus ?? "REQUESTED"] ?? { label: "Devis", cls: "amber" }
              : GARAGE_STAGE_LABEL[stage ?? "AWAITING_RECEPTION"];
            const received = o.lines.filter((l) => l.status === "RECEIVED").length;
            const expected = o.lines.filter((l) => l.status !== "NOT_RECEIVED").length;
            const quoteTotal = o.lines
              .filter((l) => l.disponible !== false)
              .reduce((s, l) => s + l.lineTotal, 0);
            return (
              <article key={o.id} className="gp-order">
                <div className="gp-order-head">
                  <div>
                    <span className="gp-order-ref">{o.ref}</span>
                    <span className="gp-order-date">{frDate(o.date)}</span>
                    {/* The vehicle the parts are for, as given when ordering. */}
                    <span className={`gp-order-vehicle${o.plate || o.vehicle ? "" : " gp-order-vehicle--none"}`}>
                      <Car className="h-4 w-4" />
                      {o.plate && <span className="gp-plate">{o.plate}</span>}
                      {o.vehicle && <span>{o.vehicle}</span>}
                      {!o.plate && !o.vehicle && "Véhicule non indiqué"}
                    </span>
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
                      {!isDevis &&
                        (() => {
                          const rs = lineReturnState(returns, l.id);
                          const left = returnableQuantity(returns, l.id, l.quantity);
                          return (
                            <span className="gp-ol-return">
                              {rs.state !== "NONE" && (
                                <span className={`rt-badge rt-badge--${LINE_RETURN_LABEL[rs.state].cls}`}>
                                  {LINE_RETURN_LABEL[rs.state].label}
                                  {rs.current && rs.current.quantity > 1 ? ` ×${rs.current.quantity}` : ""}
                                </span>
                              )}
                              {!l.retourImpossible && left > 0 && (
                                <button type="button" className="rc-act rc-act--quiet" onClick={() => openRequest(o, l, left)}>
                                  <RotateCcw className="h-3.5 w-3.5" /> Demander un retour
                                </button>
                              )}
                            </span>
                          );
                        })()}
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
                    <span className="gp-order-prog">
                      {stage === "IN_DELIVERY"
                        ? `En cours de livraison${o.deliveryAt ? ` · départ ${frDate(o.deliveryAt)}` : ""}`
                        : stage === "DELIVERED"
                          ? "Livrée"
                          : stage === "PREPARING"
                            ? "Toutes les pièces sont au magasin — préparation en cours"
                            : `${received}/${expected} pièce(s) reçue(s) au magasin`}
                    </span>
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

      {request && (
        <div className="ga-modal-overlay" onClick={() => !saving && setRequest(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><RotateCcw className="h-4 w-4" /> Demander un retour</span>
              <button type="button" className="ga-modal-close" onClick={() => setRequest(null)} aria-label="Fermer" disabled={saving}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitRequest}>
              {requestError && <div className="nc-error">{requestError}</div>}
              <div className="rt-picked">
                <div>
                  <p className="rt-order-ref">{request.line.designation || request.line.reference}</p>
                  <p className="rt-order-client">
                    {request.line.reference} · commande {request.order.ref} · {request.line.quantity} × {eur(request.line.unitPrice)}
                  </p>
                </div>
              </div>
              <div className="ga-modal-row">
                <label className="od-field">
                  <span className="od-label">Quantité à retourner</span>
                  <div className="od-select">
                    <select value={qty} onChange={(e) => setQty(Number(e.target.value))}>
                      {Array.from({ length: request.left }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </label>
                <label className="od-field">
                  <span className="od-label">Motif du retour <span className="od-req">*</span></span>
                  <div className="od-select">
                    <select value={motif} onChange={(e) => setMotif(e.target.value)}>
                      <option value="">— Choisir —</option>
                      {RETURN_MOTIFS.map((m) => (
                        <option key={m.code} value={m.code}>{m.label}</option>
                      ))}
                    </select>
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </label>
              </div>
              <label className="od-field">
                <span className="od-label">Commentaire (facultatif)</span>
                <textarea className="gp-textarea" rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Pièce non montée, emballage d’origine…" />
              </label>
              <p className="sav-hint">Le magasin valide la demande, puis le livreur passe récupérer la pièce. Chaque étape est visible dans « Retours ».</p>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setRequest(null)} disabled={saving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={saving || !motif}>
                  {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <RotateCcw className="h-4 w-4" />} Envoyer la demande
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
