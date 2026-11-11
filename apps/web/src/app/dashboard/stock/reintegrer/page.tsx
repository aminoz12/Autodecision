"use client";

import { Check, Loader2, PackagePlus, RefreshCw, Search, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { countOf } from "@/lib/data/stock-shelving-ui";
import { loadRestockToShelve, SHELVE_COUNT_EVENT, shelveRestockLine, type ShelveRow } from "@/lib/data/stock-shelving";

function fmtWhen(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * « À réintégrer pour le stock » (2026-11-11): the restock parts pointed
 * received and still to put back on the shelf. Reception already counted them
 * in the stock; this is the physical to-do, ticked line by line.
 */
export default function ReintegrerPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  const [rows, setRows] = useState<ShelveRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await loadRestockToShelve(createClient()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The menu counter follows this list right away.
  useEffect(() => {
    if (loading || error) return;
    window.dispatchEvent(new CustomEvent(SHELVE_COUNT_EVENT, { detail: rows.length }));
  }, [rows, loading, error]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.reference, r.referenceCommande ?? "", r.designation, r.orderRef, r.supplierName ?? ""].some((v) => v.toLowerCase().includes(q)),
    );
  }, [rows, search]);

  const allSelected = visible.length > 0 && visible.every((r) => selected.has(r.lineId));
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(visible.map((r) => r.lineId)));
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function shelve(targets: ShelveRow[]) {
    if (targets.length === 0) return;
    setBusy((prev) => new Set([...prev, ...targets.map((t) => t.lineId)]));
    setError(null);
    const sb = createClient();
    const done: string[] = [];
    let failure: string | null = null;
    for (const t of targets) {
      try {
        await shelveRestockLine(sb, t.lineId);
        done.push(t.lineId);
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    setRows((prev) => prev.filter((r) => !done.includes(r.lineId)));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of done) next.delete(id);
      return next;
    });
    setBusy((prev) => {
      const next = new Set(prev);
      for (const t of targets) next.delete(t.lineId);
      return next;
    });
    if (failure) setError(failure);
    else if (done.length === 1) setNotice(`${targets[0].reference} : ${countOf(targets[0].toShelve, "pièce")} rangée${targets[0].toShelve > 1 ? "s" : ""} en rayon.`);
    else setNotice(`${done.length} pièces rangées en rayon.`);
  }

  const selectedRows = visible.filter((r) => selected.has(r.lineId));
  const units = rows.reduce((s, r) => s + r.toShelve, 0);

  return (
    <div className="stk-page">
      <header className="stk-header">
        <div>
          <h1 className="stk-title">À réintégrer pour le stock</h1>
          <p className="stk-sub">
            Les pièces de réapprovisionnement reçues, pas encore remises en rayon. Elles comptent déjà dans le stock :
            rangez-les, puis cochez-les.
          </p>
        </div>
        <div className="stk-header-actions">
          <Link href="/dashboard/stock" className="od-btn od-btn--ghost">
            Pièces à recommander
          </Link>
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
          placeholder="Rechercher : référence, désignation, commande, fournisseur…"
          aria-label="Rechercher une pièce à ranger"
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
            <span className="stk-card-title">Pièces à ranger</span>
            <span className="stk-card-sub">
              {rows.length === 0 ? "Rien à ranger." : `${countOf(rows.length, "ligne")} · ${countOf(units, "pièce")} à remettre en rayon.`}
            </span>
          </span>
          {rows.length > 0 && (
            <span className="stk-card-badge">{search.trim() ? `${visible.length} / ${rows.length}` : rows.length}</span>
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
                disabled={selectedRows.length === 0 || busy.size > 0}
                onClick={() => void shelve(selectedRows)}
                title="Marquer toutes les pièces cochées comme rangées en rayon"
              >
                <Check className="h-3.5 w-3.5" />
                Rangées
                {selectedRows.length > 0 && <span className="rc-tab-count">{selectedRows.length}</span>}
              </button>
            </div>
          )}
        </div>
        <div className="rl-table-wrap">
          <table className="stk-table">
            <thead>
              <tr>
                <th className="rc-th-check">
                  <input type="checkbox" className="rc-check" checked={allSelected} onChange={toggleAll} aria-label="Tout sélectionner" />
                </th>
                <th>Référence / Désignation</th>
                <th>Commande / Fournisseur</th>
                <th>Reçue le</th>
                <th className="stk-th-center">À ranger</th>
                <th className="stk-th-center">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="rc-empty-cell"><Loader2 className="h-5 w-5 nc-spin" /> Chargement…</td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={6} className="rc-empty-cell">
                    <PackagePlus className="h-5 w-5" /> {rows.length === 0 ? "Rien à ranger : tout le réappro reçu est en rayon." : "Aucune pièce ne correspond à la recherche."}
                  </td>
                </tr>
              ) : (
                visible.map((r) => (
                  <tr key={r.lineId} className={selected.has(r.lineId) ? "rc-row--selected" : undefined}>
                    <td className="rc-th-check">
                      <input type="checkbox" className="rc-check" checked={selected.has(r.lineId)} onChange={() => toggleOne(r.lineId)} aria-label={`Sélectionner ${r.reference}`} />
                    </td>
                    <td>
                      <p className="od-ref">{r.reference}</p>
                      <p className="rl-muted">
                        {r.designation}
                        {r.referenceCommande && r.referenceCommande !== r.reference ? ` · réf. fourn. ${r.referenceCommande}` : ""}
                      </p>
                    </td>
                    <td>
                      <Link href={`/dashboard/commandes/${r.orderId}`} className="rc-cmd">{r.orderRef}</Link>
                      <p className="rl-muted">{r.supplierName ?? "Fournisseur"}</p>
                    </td>
                    <td>{fmtWhen(r.receivedAt)}</td>
                    <td className="stk-th-center">
                      <strong>{r.toShelve}</strong>
                      {r.received < r.quantity ? <span className="rl-muted"> / {r.quantity} reçues {r.received}</span> : null}
                    </td>
                    <td className="stk-th-center">
                      <button type="button" className="rc-act rc-act--remise" disabled={busy.has(r.lineId)} onClick={() => void shelve([r])} title="La pièce est en rayon">
                        {busy.has(r.lineId) ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Check className="h-3.5 w-3.5" />} Rangée
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {notice && <Toast message={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
