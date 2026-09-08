"use client";

import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ClipboardList,
  Coins,
  History,
  Loader2,
  PackageOpen,
  Pencil,
  RefreshCw,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  reorderStockLines,
  loadRestockAlerts,
  loadRestockHistory,
  loadStockItems,
  loadSupplierOptions,
  type RestockAlert,
  type RestockHistoryRow,
  type StockItem,
  type SupplierOption,
} from "@/lib/data/saas";
import { computeTournee, type TourneeInfo } from "@/lib/data/orders";
import { fmtMoney } from "@/lib/data/saas";
import {
  adjustStock,
  loadStockMovements,
  loadStockRows,
  setStockQuantity,
  STOCK_REASON_LABEL,
  updateStockItem,
  type StockItemRow,
  type StockMovement,
} from "@/lib/data/stock";

const HISTORY_STATUS: Record<RestockHistoryRow["status"], { label: string; cls: string }> = {
  COMMANDE: { label: "Commandé", cls: "amber" },
  RECU: { label: "Reçu", cls: "blue" },
  RANGE: { label: "Rangé en stock", cls: "green" },
};

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

export default function StockPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [rows, setRows] = useState<StockItem[]>([]);
  const [items, setItems] = useState<StockItemRow[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [stockSearch, setStockSearch] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  /* Ajuster / inventaire */
  const [adjust, setAdjust] = useState<StockItemRow | null>(null);
  const [adjustMode, setAdjustMode] = useState<"delta" | "set">("delta");
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState<"AJUSTEMENT" | "INVENTAIRE" | "CASSE">("AJUSTEMENT");
  const [adjustNote, setAdjustNote] = useState("");
  const [adjustBusy, setAdjustBusy] = useState(false);
  const [adjustError, setAdjustError] = useState<string | null>(null);
  /* Seuil / emplacement / PMP */
  const [meta, setMeta] = useState<StockItemRow | null>(null);
  const [metaMin, setMetaMin] = useState("0");
  const [metaLoc, setMetaLoc] = useState("");
  const [metaCost, setMetaCost] = useState("");
  const [metaSupplier, setMetaSupplier] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<RestockAlert[]>([]);
  const [history, setHistory] = useState<RestockHistoryRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Commander modal — one or several parts, ONE supplier for all of them.
  const [targets, setTargets] = useState<RestockAlert[]>([]);
  const target = targets.length === 1 ? targets[0] : null;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [supplierId, setSupplierId] = useState("");
  const [refCommande, setRefCommande] = useState("");
  const [tournee, setTournee] = useState<TourneeInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commanding, setCommanding] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      const [legacy, restock, hist, sups, stockRows, moves] = await Promise.all([
        loadStockItems(sb, orgId),
        loadRestockAlerts(sb, orgId),
        loadRestockHistory(sb, orgId),
        loadSupplierOptions(sb, orgId),
        loadStockRows(sb, orgId),
        loadStockMovements(sb, orgId, { limit: 40 }).catch(() => [] as StockMovement[]),
      ]);
      setRows(legacy);
      setAlerts(restock);
      setHistory(hist);
      setSuppliers(sups);
      setItems(stockRows);
      setMovements(moves);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () => ({
      refs: rows.length,
      pieces: rows.reduce((sum, row) => sum + row.quantity, 0),
      toRestock: alerts.length,
      low: items.filter((i) => i.low).length,
      value: items.reduce((s, i) => s + i.value, 0),
    }),
    [rows, alerts, items],
  );

  const visibleItems = useMemo(() => {
    const q = stockSearch.trim().toLowerCase();
    return items.filter((i) => {
      if (lowOnly && !i.low) return false;
      if (!q) return true;
      return i.sku.toLowerCase().includes(q) || i.name.toLowerCase().includes(q) || (i.location ?? "").toLowerCase().includes(q);
    });
  }, [items, stockSearch, lowOnly]);

  function openAdjust(item: StockItemRow) {
    setAdjust(item);
    setAdjustMode("delta");
    setAdjustQty("");
    setAdjustReason("AJUSTEMENT");
    setAdjustNote("");
    setAdjustError(null);
  }
  async function submitAdjust(e: React.FormEvent) {
    e.preventDefault();
    if (!adjust) return;
    const n = Number(adjustQty);
    if (!Number.isFinite(n)) {
      setAdjustError("Indiquez une quantité.");
      return;
    }
    setAdjustBusy(true);
    setAdjustError(null);
    try {
      const sb = createClient();
      if (adjustMode === "set") {
        await setStockQuantity(sb, { sku: adjust.sku, quantity: n, reason: adjustReason === "INVENTAIRE" ? "INVENTAIRE" : "AJUSTEMENT", note: adjustNote });
      } else {
        if (n === 0) {
          setAdjustError("Le mouvement ne peut pas être nul.");
          setAdjustBusy(false);
          return;
        }
        await adjustStock(sb, { sku: adjust.sku, name: adjust.name, delta: n, reason: adjustReason, note: adjustNote });
      }
      setNotice(`Stock de ${adjust.sku} mis à jour.`);
      setAdjust(null);
      await load();
    } catch (err) {
      setAdjustError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdjustBusy(false);
    }
  }

  function openMeta(item: StockItemRow) {
    setMeta(item);
    setMetaMin(String(item.minQty));
    setMetaLoc(item.location ?? "");
    setMetaCost(item.costPrice == null ? "" : String(item.costPrice));
    setMetaSupplier(item.supplierId ?? "");
    setMetaError(null);
  }
  async function submitMeta(e: React.FormEvent) {
    e.preventDefault();
    if (!meta) return;
    setMetaBusy(true);
    setMetaError(null);
    try {
      const sb = createClient();
      await updateStockItem(sb, {
        sku: meta.sku,
        minQty: Math.max(0, Math.trunc(Number(metaMin) || 0)),
        location: metaLoc,
        costPrice: metaCost.trim() === "" ? null : Number(metaCost.replace(",", ".")),
        supplierId: metaSupplier || null,
      });
      setNotice(`Fiche de ${meta.sku} enregistrée.`);
      setMeta(null);
      await load();
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : String(err));
    } finally {
      setMetaBusy(false);
    }
  }

  function openCommander(list: RestockAlert[]) {
    if (list.length === 0) return;
    setTargets(list);
    setSupplierId("");
    setRefCommande("");
    // Arrival follows the tournée matching the time the order is placed.
    setTournee(computeTournee(new Date()));
    setModalError(null);
    setNotice(null);
  }

  const allSelected = alerts.length > 0 && alerts.every((a) => selected.has(a.id));
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(alerts.map((a) => a.id)));
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

  async function submitCommander(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || targets.length === 0) return;
    if (!supplierId) {
      setModalError("Choisissez un fournisseur.");
      return;
    }
    setCommanding(true);
    setModalError(null);
    try {
      const sb = createClient();
      // One restock order (no client) for every selected part, same supplier.
      const res = await reorderStockLines(sb, orgId, {
        lineIds: targets.map((t) => t.id),
        supplierId,
        referenceCommandes: target ? { [target.id]: refCommande } : {},
      });
      const t = tournee ?? computeTournee(new Date());
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? "fournisseur";
      setNotice(
        targets.length === 1
          ? `${targets[0].reference} commandée chez ${supplierName} — ${res.orderRef}, ${res.tourName || t.name}, arrivée prévue ${fmtTournee(t)}.`
          : `${targets.length} pièces commandées chez ${supplierName} — commande stock ${res.orderRef}, ${res.tourName || t.name}, arrivée prévue ${fmtTournee(t)}.`,
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

  return (
    <div className="stk-page">
      <header className="stk-header">
        <div>
          <h1 className="stk-title rl-title--upper">
            <span className="stk-title-icon"><PackageOpen className="h-5 w-5" /></span>
            Mon <span className="nc-title-accent">stock</span>
          </h1>
          <p className="stk-sub">
            Alerte de réapprovisionnement : recommandez les pièces sorties du stock
            pour garder votre inventaire à jour.
          </p>
        </div>
        <button
          type="button"
          className="od-btn od-btn--ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          Actualiser
        </button>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="stk-stats">
        <div className="stk-stat stk-stat--violet">
          <span className="stk-stat-icon"><PackageOpen className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">Références en stock</span>
            <span className="stk-stat-value">{totals.refs}</span>
          </span>
        </div>
        <div className="stk-stat stk-stat--green">
          <span className="stk-stat-icon"><Boxes className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">Pièces en stock</span>
            <span className="stk-stat-value">{totals.pieces}</span>
          </span>
        </div>
        <div className="stk-stat stk-stat--amber">
          <span className="stk-stat-icon"><AlertTriangle className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">À recommander</span>
            <span className="stk-stat-value">{totals.toRestock}</span>
          </span>
        </div>
        <div className="stk-stat stk-stat--red">
          <span className="stk-stat-icon"><SlidersHorizontal className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">Sous le seuil</span>
            <span className="stk-stat-value">{totals.low}</span>
          </span>
        </div>
        <div className="stk-stat stk-stat--blue">
          <span className="stk-stat-icon"><Coins className="h-5 w-5" /></span>
          <span className="stk-stat-body">
            <span className="stk-stat-label">Valeur du stock (PMP)</span>
            <span className="stk-stat-value">{fmtMoney(totals.value)}</span>
          </span>
        </div>
      </div>

      {/* ---- Références en stock ---- */}
      <section className="stk-card">
        <div className="stk-card-head">
          <span className="stk-card-head-icon" style={{ background: "#DCFCE7", color: "#16A34A" }}>
            <Boxes className="h-4 w-4" />
          </span>
          <span className="stk-card-titles">
            <span className="stk-card-title">Références en stock</span>
            <span className="stk-card-sub">Quantités, seuil de réappro, emplacement et prix moyen pondéré. Chaque variation est journalisée.</span>
          </span>
          <div className="stk-bulk">
            <div className="rt-search">
              <Search className="h-4 w-4" />
              <input className="od-input" placeholder="Réf., désignation, emplacement…" value={stockSearch} onChange={(e) => setStockSearch(e.target.value)} />
            </div>
            <button type="button" className={`nc-chip${lowOnly ? " nc-chip--on" : ""}`} onClick={() => setLowOnly((v) => !v)}>
              Sous le seuil{totals.low ? ` · ${totals.low}` : ""}
            </button>
          </div>
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th>Référence / Désignation</th>
                <th>Emplacement</th>
                <th>Fournisseur</th>
                <th className="stk-th-center">Qté</th>
                <th className="stk-th-center">Seuil</th>
                <th className="stk-th-center">PMP</th>
                <th className="stk-th-center">Valeur</th>
                <th className="stk-th-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((i) => (
                <tr key={i.id} className={i.low ? "stk-row--low" : undefined}>
                  <td>
                    <p className="rl-ref">{i.sku}</p>
                    <p className="stk-desig">{i.name}</p>
                  </td>
                  <td className="rl-muted-strong">{i.location ?? "—"}</td>
                  <td className="rl-muted-strong">{i.supplierName ?? "—"}</td>
                  <td className="stk-td-center">
                    <span className={`stk-qty${i.low ? " stk-qty--low" : ""}`}>{i.quantity}</span>
                  </td>
                  <td className="stk-td-center rl-muted-strong">{i.minQty > 0 ? i.minQty : "—"}</td>
                  <td className="stk-td-center rl-muted-strong">{i.costPrice != null ? fmtMoney(i.costPrice) : "—"}</td>
                  <td className="stk-td-center rl-muted-strong">{i.value > 0 ? fmtMoney(i.value) : "—"}</td>
                  <td className="stk-td-center">
                    <div className="stk-row-actions">
                      <button type="button" className="rc-act rc-act--quiet" title="Ajuster la quantité / inventaire" onClick={() => openAdjust(i)}>
                        <ClipboardList className="h-3.5 w-3.5" /> Ajuster
                      </button>
                      <button type="button" className="rc-act rc-act--quiet" title="Seuil, emplacement, PMP" onClick={() => openMeta(i)}>
                        <Pencil className="h-3.5 w-3.5" /> Fiche
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!loading && visibleItems.length === 0 && (
                <tr>
                  <td colSpan={8} className="stk-empty">
                    {items.length === 0 ? "Aucune référence en stock. Les réceptions de réapprovisionnement et les retours clients alimentent le stock automatiquement." : "Aucune référence ne correspond."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- À recommander : stock-sourced lines awaiting re-order ---- */}
      <section className="stk-card">
        <div className="stk-card-head">
          <span className="stk-card-head-icon" style={{ background: "#FEF3C7", color: "#D97706" }}>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <span className="stk-card-titles">
            <span className="stk-card-title">Pièces à recommander</span>
            <span className="stk-card-sub">Sorties du stock pour un client — à recommander pour réapprovisionner.</span>
          </span>
          {alerts.length > 0 && (
            <span className="stk-card-badge" style={{ background: "#FEF3C7", color: "#B45309" }}>
              {alerts.length}
            </span>
          )}
          {alerts.length > 0 && (
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
                title="Commander toutes les pièces cochées chez le même fournisseur"
              >
                <ShoppingCart className="h-3.5 w-3.5" />
                Commander la sélection
                {selectedAlerts.length > 0 && (
                  <span className="rc-tab-count">{selectedAlerts.length}</span>
                )}
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
              {alerts.map((a) => (
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
                    <button
                      type="button"
                      className="od-btn od-btn--primary st-cmd-btn"
                      onClick={() => openCommander([a])}
                    >
                      <ShoppingCart className="h-3.5 w-3.5" />
                      Commander
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && alerts.length === 0 && (
                <tr>
                  <td colSpan={6} className="stk-empty">
                    Aucune pièce à recommander. Votre stock est à jour 👍
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Mouvements ---- */}
      <section className="stk-card">
        <div className="stk-card-head">
          <span className="stk-card-head-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}>
            <History className="h-4 w-4" />
          </span>
          <span className="stk-card-titles">
            <span className="stk-card-title">Derniers mouvements</span>
            <span className="stk-card-sub">Ventes, réceptions, retours, ajustements — qui, quand, pourquoi.</span>
          </span>
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr><th>Date</th><th>Référence</th><th>Motif</th><th>Commande / réf.</th><th className="stk-th-center">Mouvement</th><th className="stk-th-center">Après</th><th>Par</th></tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td className="rl-muted-strong">{new Date(m.createdAt).toLocaleDateString("fr-FR")} {new Date(m.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</td>
                  <td className="rl-ref">{m.sku}</td>
                  <td>{STOCK_REASON_LABEL[m.reason] ?? m.reason}{m.note ? ` · ${m.note}` : ""}</td>
                  <td className="rl-muted-strong">{m.orderId ? <Link href={`/dashboard/commandes/${m.orderId}`}>{m.ref ?? "commande"}</Link> : m.ref ?? "—"}</td>
                  <td className="stk-td-center" style={{ fontWeight: 700, color: m.delta < 0 ? "#DC2626" : "#16A34A" }}>{m.delta > 0 ? "+" : ""}{m.delta}</td>
                  <td className="stk-td-center rl-muted-strong">{m.quantityAfter}</td>
                  <td className="rl-muted-strong">{m.createdByName ?? "—"}</td>
                </tr>
              ))}
              {!loading && movements.length === 0 && (
                <tr><td colSpan={7} className="stk-empty">Aucun mouvement enregistré pour l&apos;instant.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- Historique : stock lines that were re-ordered ---- */}
      <section className="stk-card">
        <div className="stk-card-head">
          <span className="stk-card-head-icon" style={{ background: "#EEF2FF", color: "#5b4ee5" }}>
            <History className="h-4 w-4" />
          </span>
          <span className="stk-card-titles">
            <span className="stk-card-title">Historique des réapprovisionnements</span>
            <span className="stk-card-sub">Pièces commandées pour le stock — suivi jusqu&apos;à la mise en rayon.</span>
          </span>
          {history.length > 0 && (
            <span className="stk-card-badge" style={{ background: "#EEF2FF", color: "#4F46E5" }}>
              {history.length}
            </span>
          )}
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th>Référence / Désignation</th>
                <th>Fournisseur</th>
                <th>Commande</th>
                <th className="stk-th-center">Qté</th>
                <th>Date</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => {
                const st = HISTORY_STATUS[h.status];
                return (
                  <tr key={h.id}>
                    <td>
                      <p className="stk-ref">
                        {h.reference}
                        {h.referenceCommande && h.referenceCommande !== h.reference && (
                          <span className="stk-ref-cmd"> · cmd. {h.referenceCommande}</span>
                        )}
                      </p>
                      <p className="stk-desig">{h.designation}</p>
                    </td>
                    <td>
                      <span className="rc-brand" style={{ color: "#DC2626" }}>
                        {h.supplierName}
                      </span>
                    </td>
                    <td>
                      <Link href={`/dashboard/commandes/${h.orderId}`} className="rc-cmd">
                        {h.orderRef}
                      </Link>
                    </td>
                    <td className="stk-td-center"><span className="stk-qty">{h.quantity}</span></td>
                    <td className="rl-muted-strong">{fmtDay(h.date)}</td>
                    <td>
                      <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                    </td>
                  </tr>
                );
              })}
              {!loading && history.length === 0 && (
                <tr>
                  <td colSpan={6} className="stk-empty">
                    Aucun réapprovisionnement pour le moment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Toast message={notice} onClose={() => setNotice(null)} duration={8000} />

      {/* ---- Ajuster / inventaire ---- */}
      {adjust && (
        <div className="ga-modal-overlay" onClick={() => !adjustBusy && setAdjust(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="adjust-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <h2 className="ga-modal-title" id="adjust-title">Ajuster {adjust.sku}</h2>
              <button type="button" className="ga-modal-close" onClick={() => setAdjust(null)} aria-label="Fermer" disabled={adjustBusy}><X className="h-4 w-4" /></button>
            </div>
            <form className="ga-modal-form" onSubmit={submitAdjust}>
              {adjustError && <div className="nc-error">{adjustError}</div>}
              <p className="st-cmd-hint">{adjust.name} · en stock : <strong>{adjust.quantity}</strong></p>
              <div className="od-field">
                <span className="od-label">Type</span>
                <div className="nc-pay-quick" role="radiogroup">
                  <button type="button" role="radio" aria-checked={adjustMode === "delta"} className={`nc-chip${adjustMode === "delta" ? " nc-chip--on" : ""}`} onClick={() => setAdjustMode("delta")}>Entrée / sortie (±)</button>
                  <button type="button" role="radio" aria-checked={adjustMode === "set"} className={`nc-chip${adjustMode === "set" ? " nc-chip--on" : ""}`} onClick={() => { setAdjustMode("set"); setAdjustReason("INVENTAIRE"); }}>Quantité comptée (inventaire)</button>
                </div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">{adjustMode === "set" ? "Quantité comptée" : "Mouvement (ex. -2 ou +5)"} <span className="od-req">*</span></span>
                  <input className="od-input" type="number" step="1" value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} autoFocus />
                </div>
                <div className="od-field">
                  <span className="od-label">Motif</span>
                  <div className="od-select">
                    <select value={adjustReason} onChange={(e) => setAdjustReason(e.target.value as "AJUSTEMENT" | "INVENTAIRE" | "CASSE")}>
                      <option value="AJUSTEMENT">Ajustement</option>
                      <option value="INVENTAIRE">Inventaire</option>
                      <option value="CASSE">Casse / perte</option>
                    </select>
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
              </div>
              <div className="od-field">
                <span className="od-label">Note</span>
                <input className="od-input" value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="Comptage du 08/09, pièce abîmée…" />
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setAdjust(null)} disabled={adjustBusy}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={adjustBusy}>
                  {adjustBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <ClipboardList className="h-4 w-4" />} Enregistrer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---- Fiche : seuil, emplacement, PMP ---- */}
      {meta && (
        <div className="ga-modal-overlay" onClick={() => !metaBusy && setMeta(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="meta-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <h2 className="ga-modal-title" id="meta-title">Fiche {meta.sku}</h2>
              <button type="button" className="ga-modal-close" onClick={() => setMeta(null)} aria-label="Fermer" disabled={metaBusy}><X className="h-4 w-4" /></button>
            </div>
            <form className="ga-modal-form" onSubmit={submitMeta}>
              {metaError && <div className="nc-error">{metaError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Seuil de réappro</span>
                  <input className="od-input" type="number" min={0} step="1" value={metaMin} onChange={(e) => setMetaMin(e.target.value)} />
                  <span className="st-cmd-hint">Une alerte est envoyée quand la quantité passe sous ce seuil (0 = pas d&apos;alerte).</span>
                </div>
                <div className="od-field">
                  <span className="od-label">Emplacement</span>
                  <input className="od-input" value={metaLoc} onChange={(e) => setMetaLoc(e.target.value)} placeholder="Rayon B · étagère 3" />
                </div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Prix d&apos;achat moyen (PMP)</span>
                  <div className="nc-pay-input">
                    <input className="od-input nc-pay-amount" type="number" min={0} step="0.01" value={metaCost} onChange={(e) => setMetaCost(e.target.value)} placeholder="Calculé aux réceptions" />
                    <span className="nc-pay-unit">€</span>
                  </div>
                </div>
                <div className="od-field">
                  <span className="od-label">Fournisseur habituel</span>
                  <div className="od-select">
                    <select value={metaSupplier} onChange={(e) => setMetaSupplier(e.target.value)}>
                      <option value="">—</option>
                      {suppliers.map((s) => (<option key={s.id} value={s.id}>{s.name}</option>))}
                    </select>
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setMeta(null)} disabled={metaBusy}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={metaBusy}>
                  {metaBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Pencil className="h-4 w-4" />} Enregistrer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---- Commander modal ---- */}
      {targets.length > 0 && (
        <div className="ga-modal-overlay" onClick={() => !commanding && setTargets([])}>
          <div className="ga-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <h2 className="ga-modal-title">
                {targets.length === 1
                  ? "Commander la pièce"
                  : `Commander ${targets.length} pièces (même fournisseur)`}
              </h2>
              <button type="button" className="ga-modal-close" onClick={() => setTargets([])} aria-label="Fermer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitCommander}>
              {modalError && <div className="nc-error">{modalError}</div>}

              <div className="st-cmd-part st-cmd-part--list">
                {targets.map((t) => (
                  <div key={t.id} className="st-cmd-part-row">
                    <span>
                      <p className="rl-ref">{t.reference}</p>
                      <p className="rl-muted">{t.designation}</p>
                    </span>
                    <span className="stk-qty">×{t.quantity}</span>
                  </div>
                ))}
                <p className="st-cmd-hint">
                  Une commande de réapprovisionnement séparée est créée pour le stock :
                  les pièces ne restent pas liées au client.
                </p>
              </div>

              <div className="od-field">
                <span className="od-label">Fournisseur *</span>
                <div className="od-select">
                  <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                    <option value="">— Choisir un fournisseur —</option>
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
                  {commanding ? "Commande…" : "Commander"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
