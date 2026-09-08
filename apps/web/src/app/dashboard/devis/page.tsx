"use client";

import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileSignature,
  Loader2,
  Plus,
  Printer,
  RotateCcw,
  ShoppingCart,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  effectiveQuoteStatus,
  loadQuotes,
  QUOTE_STATUS_LABEL,
  setQuoteStatus,
  type Quote,
  type QuoteStatus,
} from "@/lib/data/quotes";
import { loadOrganizationSettings, type OrganizationSettings } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Devis particulier — proposals waiting for the client's answer.    */
/*  A quote becomes an order from « Transformer en commande » (the    */
/*  nouvelle-commande form prefilled with the quote).                  */
/* ------------------------------------------------------------------ */

type Filter = "ALL" | QuoteStatus;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "ALL", label: "Tous" },
  { id: "EN_ATTENTE", label: "En attente" },
  { id: "ACCEPTE", label: "Acceptés" },
  { id: "REFUSE", label: "Refusés" },
  { id: "EXPIRE", label: "Expirés" },
];

function eur(v: number): string {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function netUnit(gross: number, pct?: number): number {
  const p = Math.min(100, Math.max(0, pct || 0));
  return Math.round(gross * (1 - p / 100) * 100) / 100;
}

export default function DevisPage() {
  const { profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const orgId = profile?.organization_id ?? null;

  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [org, setOrg] = useState<OrganizationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("EN_ATTENTE");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState<Quote | null>(null);

  const reload = useCallback(async () => {
    if (!orgId) return;
    try {
      setQuotes(await loadQuotes(supabase, orgId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!orgId) return;
    loadOrganizationSettings(supabase, orgId).then(setOrg).catch(() => {});
  }, [supabase, orgId]);

  useEffect(() => {
    const initialTitle = document.title;
    const reset = () => {
      setPrinting(null);
      document.title = initialTitle;
    };
    window.addEventListener("afterprint", reset);
    return () => window.removeEventListener("afterprint", reset);
  }, []);

  const rows = useMemo(() => {
    const withStatus = quotes.map((q) => ({ q, status: effectiveQuoteStatus(q) }));
    return filter === "ALL" ? withStatus : withStatus.filter((r) => r.status === filter);
  }, [quotes, filter]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: quotes.length, EN_ATTENTE: 0, ACCEPTE: 0, REFUSE: 0, EXPIRE: 0 };
    for (const q of quotes) c[effectiveQuoteStatus(q)] += 1;
    return c;
  }, [quotes]);

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(id));
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const printQuote = (q: Quote) => {
    setPrinting(q);
    document.title = q.ref;
    window.setTimeout(() => window.print(), 60);
  };

  return (
    <div className="od-page">
      <nav className="od-breadcrumb">
        <Link href="/dashboard">Tableau de bord</Link>
        <span className="od-breadcrumb-sep">
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
        <span className="od-breadcrumb-current">Devis</span>
      </nav>

      <div className="od-title-row">
        <div>
          <h1 className="od-title nc-title">
            <span className="nc-title-icon">
              <FileSignature className="h-5 w-5" />
            </span>
            Devis <span className="nc-title-accent">particuliers</span>
          </h1>
          <p className="rl-subtitle">
            Propositions chiffrées en attente de réponse. Un devis accepté se transforme en commande en un clic.
          </p>
        </div>
        <div className="od-title-actions">
          <Link href="/dashboard/nouvelle-commande" className="od-btn od-btn--primary">
            <Plus className="h-4 w-4" />
            Nouveau devis
          </Link>
        </div>
      </div>

      {error && <div className="nc-error">{error}</div>}

      <div className="dv-filters" role="tablist" aria-label="Filtrer les devis">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`nc-chip${filter === f.id ? " nc-chip--on" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label} · {counts[f.id]}
          </button>
        ))}
      </div>

      <section className="od-card rc-table-card">
        <div className="rc-table-wrap">
          <table className="rc-table">
            <thead>
              <tr>
                <th>N° devis / Date</th>
                <th>Client</th>
                <th>Véhicule</th>
                <th className="rc-th-center">Pièces</th>
                <th className="od-th-right">Total TTC</th>
                <th>Validité</th>
                <th>Statut</th>
                <th className="rc-th-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="rc-empty-cell">
                    Chargement des devis…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="rc-empty-cell">
                    {filter === "ALL"
                      ? "Aucun devis pour l'instant. Depuis Nouvelle commande, « Enregistrer en devis » garde les pièces et les prix sans commander."
                      : "Aucun devis dans cet état."}
                  </td>
                </tr>
              ) : (
                rows.map(({ q, status }) => {
                  const st = QUOTE_STATUS_LABEL[status];
                  const isBusy = busy.has(q.id);
                  const isOpen = open.has(q.id);
                  const lineCount = q.payload.lines?.length ?? 0;
                  const vehicle = [q.payload.vehicle_model, q.payload.immatriculation].filter(Boolean).join(" · ");
                  return (
                    <tr key={q.id} className="rc-row">
                      <td>
                        <button type="button" className="rc-cmd" onClick={() => toggle(q.id)} style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}>
                          {q.ref}{" "}
                          {isOpen ? <ChevronUp className="h-3.5 w-3.5" style={{ display: "inline" }} /> : <ChevronDown className="h-3.5 w-3.5" style={{ display: "inline" }} />}
                        </button>
                        <p className="rl-muted">{fmtDate(q.createdAt)}</p>
                        {isOpen && (
                          <div className="dv-lines">
                            <table>
                              <tbody>
                                {(q.payload.lines ?? []).map((l, i) => {
                                  const gross = l.prix_brut_unitaire ?? l.prix_vente_unitaire;
                                  const net = netUnit(gross, l.remise_pct);
                                  return (
                                    <tr key={i}>
                                      <td>
                                        <strong>{l.reference}</strong> — {l.nom_produit}
                                      </td>
                                      <td className="od-td-center">× {l.quantity}</td>
                                      <td className="od-td-right">
                                        {eur(net)}
                                        {(l.remise_pct ?? 0) > 0 ? ` (−${l.remise_pct} %)` : ""}
                                      </td>
                                      <td className="od-td-right">
                                        <strong>{eur(l.quantity * net)}</strong>
                                      </td>
                                    </tr>
                                  );
                                })}
                                {(q.payload.remise_montant ?? 0) > 0 && (
                                  <tr>
                                    <td colSpan={3}>Remise en pied de commande</td>
                                    <td className="od-td-right">− {eur(q.payload.remise_montant ?? 0)}</td>
                                  </tr>
                                )}
                              </tbody>
                            </table>
                            {q.note && <p className="rl-muted" style={{ marginTop: 6 }}>{q.note}</p>}
                          </div>
                        )}
                      </td>
                      <td>
                        <p className="rl-client">{q.clientName}</p>
                        {q.payload.client_phone && q.payload.client_phone !== "-" && (
                          <p className="rl-muted">{q.payload.client_phone}</p>
                        )}
                      </td>
                      <td>
                        <p className="rc-vehicle">{vehicle || "—"}</p>
                      </td>
                      <td className="rc-th-center">{lineCount}</td>
                      <td className="od-td-right od-num od-num-strong">{eur(q.total)}</td>
                      <td>
                        <p className="rc-last">{fmtDate(q.validUntil)}</p>
                      </td>
                      <td>
                        <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                        {q.convertedOrderId && (
                          <p className="rl-muted">
                            <Link href={`/dashboard/commandes/${q.convertedOrderId}`} className="rc-cmd">
                              {q.convertedOrderRef ?? "Voir la commande"}
                            </Link>
                          </p>
                        )}
                      </td>
                      <td>
                        <div className="rc-actions">
                          <button type="button" className="rc-act" onClick={() => printQuote(q)} title="Imprimer le devis">
                            <Printer className="h-3.5 w-3.5" /> Imprimer
                          </button>
                          {(status === "EN_ATTENTE" || status === "EXPIRE") && (
                            <Link
                              href={`/dashboard/nouvelle-commande?quote=${q.id}`}
                              className="rc-act rc-act--recu"
                              title="Ouvrir la commande pré-remplie avec ce devis"
                            >
                              <ShoppingCart className="h-3.5 w-3.5" /> Transformer en commande
                            </Link>
                          )}
                          {(status === "EN_ATTENTE" || status === "EXPIRE") && (
                            <button
                              type="button"
                              className="rc-act rc-act--nonrecu rc-act--quiet"
                              disabled={isBusy}
                              onClick={() => withBusy(q.id, () => setQuoteStatus(supabase, q.id, "REFUSE"))}
                            >
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <XCircle className="h-3.5 w-3.5" />} Refusé
                            </button>
                          )}
                          {status === "REFUSE" && (
                            <button
                              type="button"
                              className="rc-act rc-act--quiet"
                              disabled={isBusy}
                              onClick={() => withBusy(q.id, () => setQuoteStatus(supabase, q.id, "EN_ATTENTE"))}
                            >
                              {isBusy ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Réactiver
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Printable quote (only rendered while printing) ---- */}
      {printing && (
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
              <p className="print-doctype-name">DEVIS</p>
              <p className="print-org-line">{printing.ref}</p>
              <p className="print-org-line">{fmtDate(printing.createdAt)}</p>
              {printing.validUntil && <p className="print-org-line">Valable jusqu&apos;au {fmtDate(printing.validUntil)}</p>}
            </div>
          </div>
          <div className="print-client">
            <p className="print-section-title">Client</p>
            <p className="print-client-name">{printing.clientName}</p>
            {printing.payload.client_phone && printing.payload.client_phone !== "-" && (
              <p className="print-org-line">{printing.payload.client_phone}</p>
            )}
            {(printing.payload.vehicle_model || printing.payload.immatriculation) && (
              <p className="print-org-line">
                {[printing.payload.vehicle_model, printing.payload.immatriculation].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
          <table className="print-table">
            <thead>
              <tr>
                <th>Référence</th>
                <th>Désignation</th>
                <th className="print-num">Qté</th>
                <th className="print-num">PU TTC</th>
                <th className="print-num">Total</th>
              </tr>
            </thead>
            <tbody>
              {(printing.payload.lines ?? []).map((l, i) => {
                const net = netUnit(l.prix_brut_unitaire ?? l.prix_vente_unitaire, l.remise_pct);
                return (
                  <tr key={i}>
                    <td>{l.reference}</td>
                    <td>
                      {l.nom_produit}
                      {(l.remise_pct ?? 0) > 0 ? ` (remise ${l.remise_pct} %)` : ""}
                    </td>
                    <td className="print-num">{l.quantity}</td>
                    <td className="print-num">{eur(net)}</td>
                    <td className="print-num">{eur(l.quantity * net)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="print-totals">
            {(printing.payload.remise_montant ?? 0) > 0 && (
              <div>
                <span>Remise commerciale</span>
                <strong>− {eur(printing.payload.remise_montant ?? 0)}</strong>
              </div>
            )}
            <div className="print-totals-due">
              <span>Total TTC</span>
              <strong>{eur(printing.total)}</strong>
            </div>
          </div>
          <p className="print-footer">
            Devis valable {printing.validUntil ? `jusqu'au ${fmtDate(printing.validUntil)}` : "30 jours"} · prix TTC ·
            pièces disponibles sous réserve de stock fournisseur.
          </p>
        </div>
      )}
    </div>
  );
}
