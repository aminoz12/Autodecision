"use client";

import {
  ChevronDown,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { SearchParamEffect } from "@/components/ui/SearchParamEffect";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  loadRestockAlerts,
  loadSupplierOptions,
  RESTOCK_COUNT_EVENT,
  reorderStockLines,
  skipRestockAlert,
  type RestockAlert,
  type SupplierOption,
} from "@/lib/data/saas";
import { computeTournee, type TourneeInfo } from "@/lib/data/orders";
import { loadStockRows, type StockItemRow } from "@/lib/data/stock";

function fmtDay(value: string | null): string {
  if (!value) return "–";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

function fmtTournee(t: TourneeInfo): string {
  const d = t.deliveryAt;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const day = sameDay ? "aujourd'hui" : d.toLocaleDateString("fr-FR");
  return `${day} à ${t.slot}`;
}

/**
 * Stock = the parts that left the shelf for a client and are not back yet:
 * either re-order them (one restock order per supplier) or dismiss the alert
 * when the part is in fact already in stock.
 */
export default function StockPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [alerts, setAlerts] = useState<RestockAlert[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  /** Stock references: only used to pre-fill the usual supplier of a part. */
  const [stockRows, setStockRows] = useState<StockItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Commander modal — one or several parts, each with its supplier.
  const [targets, setTargets] = useState<RestockAlert[]>([]);
  const [lineSupplier, setLineSupplier] = useState<Record<string, string>>({});
  const [refCommande, setRefCommande] = useState("");
  const [tournee, setTournee] = useState<TourneeInfo | null>(null);
  const [commanding, setCommanding] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const target = targets.length === 1 ? targets[0] : null;

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      const [restock, sups, rows] = await Promise.all([
        loadRestockAlerts(sb, orgId),
        loadSupplierOptions(sb, orgId),
        loadStockRows(sb, orgId).catch(() => [] as StockItemRow[]),
      ]);
      setAlerts(restock);
      setSuppliers(sups);
      setStockRows(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The « Stock » counter in the menu follows this list right away.
  useEffect(() => {
    if (loading || error) return;
    window.dispatchEvent(new CustomEvent(RESTOCK_COUNT_EVENT, { detail: alerts.length }));
  }, [alerts, loading, error]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return alerts;
    return alerts.filter((a) =>
      [a.reference, a.designation, a.orderRef, a.clientName].some((v) => v.toLowerCase().includes(q)),
    );
  }, [alerts, search]);

  const allSelected = visible.length > 0 && visible.every((a) => selected.has(a.id));
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visible.map((a) => a.id)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const selectedAlerts = alerts.filter((a) => selected.has(a.id));

  /** The usual supplier of a reference, when the stock knows it. */
  const usualSupplier = useCallback(
    (reference: string): string => {
      const ref = reference.trim().toLowerCase();
      if (!ref) return "";
      return stockRows.find((r) => r.sku.trim().toLowerCase() === ref)?.supplierId ?? "";
    },
    [stockRows],
  );

  function openCommander(list: RestockAlert[]) {
    if (list.length === 0) return;
    setTargets(list);
    setLineSupplier(Object.fromEntries(list.map((t) => [t.id, usualSupplier(t.reference)])));
    setRefCommande("");
    // Arrival follows the tournée matching the time the order is placed.
    setTournee(computeTournee(new Date()));
    setModalError(null);
    setNotice(null);
  }
  function setAllSuppliers(id: string) {
    setLineSupplier((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, id])));
  }
  const supplierIds = new Set(targets.map((t) => lineSupplier[t.id] ?? ""));
  const commonSupplier = supplierIds.size === 1 ? [...supplierIds][0] : "";
  const mixed = targets.length > 1 && supplierIds.size > 1;

  async function submitCommander(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || targets.length === 0) return;
    const missing = targets.filter((t) => !lineSupplier[t.id]);
    if (missing.length > 0) {
      setModalError(
        targets.length === 1
          ? "Choisissez un fournisseur."
          : `Choisissez un fournisseur pour chaque pièce (${missing.length} sans fournisseur).`,
      );
      return;
    }
    setCommanding(true);
    setModalError(null);
    try {
      const sb = createClient();
      // One restock order per supplier: the selection can mix suppliers.
      const groups = new Map<string, RestockAlert[]>();
      for (const t of targets) {
        const sid = lineSupplier[t.id];
        groups.set(sid, [...(groups.get(sid) ?? []), t]);
      }
      const created: string[] = [];
      let failure: string | null = null;
      for (const [sid, list] of groups) {
        try {
          const res = await reorderStockLines(sb, orgId, {
            lineIds: list.map((t) => t.id),
            supplierId: sid,
            referenceCommandes: target ? { [target.id]: refCommande } : {},
          });
          const name = suppliers.find((s) => s.id === sid)?.name ?? "fournisseur";
          created.push(`${res.orderRef} chez ${name} (${list.length} pièce${list.length > 1 ? "s" : ""})`);
          // This supplier is ordered: drop its parts from the modal so a retry never re-sends them.
          const done = new Set(list.map((t) => t.id));
          setTargets((prev) => prev.filter((t) => !done.has(t.id)));
          setSelected((prev) => {
            const next = new Set(prev);
            for (const id of done) next.delete(id);
            return next;
          });
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err);
          break;
        }
      }
      const t = tournee ?? computeTournee(new Date());
      if (failure) {
        setModalError(`${created.length > 0 ? `Créé : ${created.join(" · ")}. ` : ""}Échec pour les pièces restantes : ${failure}`);
        if (created.length > 0) await load();
        return;
      }
      setNotice(
        created.length === 1
          ? `${target ? `${target.reference} commandée` : `${targets.length} pièces commandées`} — ${created[0]}, arrivée prévue ${fmtTournee(t)}.`
          : `${created.length} commandes de réapprovisionnement créées : ${created.join(" · ")} — arrivée prévue ${fmtTournee(t)}.`,
      );
      setTargets([]);
      setSelected(new Set());
      await load();
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommanding(false);
    }
  }

  /** « Déjà en stock » : the part is on the shelf, nothing to order. */
  async function skip(a: RestockAlert) {
    setSkipping(a.id);
    setError(null);
    try {
      await skipRestockAlert(createClient(), a.id);
      setAlerts((prev) => prev.filter((x) => x.id !== a.id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
      setNotice(`${a.reference} : alerte écartée, la pièce est déjà en stock.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSkipping(null);
    }
  }

  return (
    <div className="stk-page">
      {/* « Recherche pièce » opens this page with ?q=<référence>, also while it is already open. */}
      <Suspense fallback={null}>
        <SearchParamEffect name="q" onValue={setSearch} />
      </Suspense>
      <header className="stk-header">
        <div>
          <h1 className="stk-title">Stock</h1>
          <p className="stk-sub">
            Les pièces sorties du rayon pour un client : à recommander chez le fournisseur, ou déjà en stock.
          </p>
        </div>
        <div className="stk-header-actions">
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="stk-search">
        <Search className="stk-search-icon" />
        <input
          className="stk-search-input"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Rechercher une pièce à recommander : référence, désignation, commande, client…"
          aria-label="Rechercher une pièce à recommander"
        />
        {search && (
          <button type="button" className="stk-search-clear" onClick={() => setSearch("")} aria-label="Effacer la recherche">
            <X />
          </button>
        )}
      </div>

      <section className="stk-card">
        <div className="stk-card-head">
          <span className="stk-card-titles">
            <span className="stk-card-title">Pièces à recommander</span>
            <span className="stk-card-sub">
              Sorties du stock pour un client — commandez-les, ou écartez l&apos;alerte si la pièce est déjà en rayon.
            </span>
          </span>
          {alerts.length > 0 && (
            <span className="stk-card-badge">{search.trim() ? `${visible.length} / ${alerts.length}` : alerts.length}</span>
          )}
          {visible.length > 0 && (
            <div className="stk-bulk">
              <label className="rc-check rc-check--label">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                Tout sélectionner
              </label>
              <button
                type="button"
                className="od-btn od-btn--primary st-cmd-btn"
                disabled={selectedAlerts.length === 0}
                onClick={() => openCommander(selectedAlerts)}
                title="Commander toutes les pièces cochées — un fournisseur par pièce si besoin"
              >
                <ShoppingCart className="h-3.5 w-3.5" />
                Commander la sélection
                {selectedAlerts.length > 0 && <span className="rc-tab-count">{selectedAlerts.length}</span>}
              </button>
            </div>
          )}
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th className="rc-th-check">
                  <input
                    type="checkbox"
                    className="rc-check"
                    checked={allSelected}
                    onChange={toggleAll}
                    aria-label="Tout sélectionner"
                  />
                </th>
                <th>Référence / Désignation</th>
                <th>Commande / Client</th>
                <th className="stk-th-center">Qté</th>
                <th>Date</th>
                <th className="stk-th-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id} className={selected.has(a.id) ? "rc-row--selected" : undefined}>
                  <td className="rc-th-check">
                    <input
                      type="checkbox"
                      className="rc-check"
                      checked={selected.has(a.id)}
                      onChange={() => toggleOne(a.id)}
                      aria-label={`Sélectionner ${a.reference}`}
                    />
                  </td>
                  <td>
                    <p className="stk-ref">{a.reference}</p>
                    <p className="stk-desig">{a.designation}</p>
                  </td>
                  <td>
                    <Link href={`/dashboard/commandes/${a.orderId}`} className="rc-cmd">
                      {a.orderRef}
                    </Link>
                    <p className="stk-desig">{a.clientName}</p>
                  </td>
                  <td className="stk-td-center"><span className="stk-qty">{a.quantity}</span></td>
                  <td className="rl-muted-strong">{fmtDay(a.orderDate)}</td>
                  <td className="stk-td-center">
                    <div className="stk-row-actions">
                      <button type="button" className="od-btn od-btn--primary st-cmd-btn" onClick={() => openCommander([a])}>
                        <ShoppingCart className="h-3.5 w-3.5" />
                        Commander
                      </button>
                      <button
                        type="button"
                        className="od-btn od-btn--ghost"
                        disabled={skipping === a.id}
                        onClick={() => void skip(a)}
                        title="La pièce est déjà en rayon : retirer l'alerte sans commander"
                      >
                        {skipping === a.id ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
                        Déjà en stock
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && alerts.length === 0 && (
                <tr>
                  <td colSpan={6} className="stk-empty">
                    Aucune pièce à recommander : votre stock est à jour.
                  </td>
                </tr>
              )}
              {!loading && alerts.length > 0 && visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="stk-empty">
                    Aucune pièce ne correspond à « {search.trim()} ».
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Toast message={notice} onClose={() => setNotice(null)} />

      {/* ---- Commander modal ---- */}
      {targets.length > 0 && (
        <div className="ga-modal-overlay" onClick={() => !commanding && setTargets([])}>
          <div className={`ga-modal${target ? "" : " ga-modal--wide"}`} onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <h2 className="ga-modal-title">
                {target ? "Commander la pièce" : `Commander ${targets.length} pièces`}
              </h2>
              <button type="button" className="ga-modal-close" onClick={() => setTargets([])} aria-label="Fermer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitCommander}>
              {modalError && <div className="nc-error">{modalError}</div>}

              <div className="od-field">
                <span className="od-label">{target ? "Fournisseur *" : "Fournisseur pour toutes les pièces"}</span>
                <div className="od-select">
                  <select value={commonSupplier} onChange={(e) => setAllSuppliers(e.target.value)}>
                    <option value="">{mixed ? "— Fournisseurs différents (voir pièce par pièce) —" : "— Choisir un fournisseur —"}</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="h-4 w-4" />
                </div>
                {suppliers.length === 0 && (
                  <span className="st-cmd-hint">
                    {profile?.role === "ADMIN" ? (
                      <>Aucun fournisseur. Ajoutez-en un dans{" "}<Link href="/dashboard/fournisseurs" className="rc-cmd">Fournisseurs</Link>.</>
                    ) : (
                      <>Aucun fournisseur. Demandez à l&apos;administrateur du magasin d&apos;en ajouter un.</>
                    )}
                  </span>
                )}
              </div>

              <div className="st-cmd-part st-cmd-part--list">
                {targets.map((t) => (
                  <div key={t.id} className="st-cmd-part-row">
                    <span>
                      <p className="rl-ref">{t.reference}</p>
                      <p className="rl-muted">{t.designation}</p>
                    </span>
                    <span className="stk-qty">×{t.quantity}</span>
                    {!target && (
                      <div className="od-select" title="Fournisseur de cette pièce">
                        <select
                          value={lineSupplier[t.id] ?? ""}
                          onChange={(e) => setLineSupplier((prev) => ({ ...prev, [t.id]: e.target.value }))}
                          aria-label={`Fournisseur pour ${t.reference}`}
                        >
                          <option value="">— Fournisseur —</option>
                          {suppliers.map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                        <ChevronDown className="h-4 w-4" />
                      </div>
                    )}
                  </div>
                ))}
                <p className="st-cmd-hint">
                  {target
                    ? "Une commande de réapprovisionnement séparée est créée pour le stock : la pièce ne reste pas liée au client."
                    : "Une commande de réapprovisionnement est créée par fournisseur ; les pièces ne restent pas liées aux clients."}
                </p>
              </div>

              <div className="ga-modal-row">
                {target && (
                  <div className="od-field">
                    <span className="od-label">Référence commandée</span>
                    <input
                      className="od-input"
                      placeholder="Réf. fournisseur (gardée avec la réf. d'origine)"
                      value={refCommande}
                      onChange={(e) => setRefCommande(e.target.value)}
                    />
                    <span className="st-cmd-hint">
                      La référence d&apos;origine <strong>{target.reference}</strong> est conservée ; les deux seront recherchables.
                    </span>
                  </div>
                )}
                <div className="od-field">
                  <span className="od-label">Arrivée prévue</span>
                  <input
                    className="od-input nc-readonly"
                    readOnly
                    value={tournee ? `${tournee.name} — ${fmtTournee(tournee)}` : ""}
                  />
                  <span className="st-cmd-hint">Déterminée automatiquement par l&apos;heure de la commande.</span>
                </div>
              </div>

              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setTargets([])} disabled={commanding}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={commanding}>
                  {commanding ? <Loader2 className="h-4 w-4 nc-spin" /> : <ShoppingCart className="h-4 w-4" />}
                  {commanding ? "Commande…" : mixed ? `Commander (${supplierIds.size} fournisseurs)` : "Commander"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
