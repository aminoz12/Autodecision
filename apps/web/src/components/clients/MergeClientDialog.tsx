"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { GitMerge, Loader2, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { KIND_LABEL, normName, type AccountKind } from "@/lib/data/client-duplicates";
import { mergeClients, normPhone } from "@/lib/data/clients";
import { loadClients, loadGarages } from "@/lib/data/saas";

/*
 * « Fusionner avec une autre fiche » (administrateur, 2026-11-03).
 *
 * Opened from the file of a duplicate: the admin picks the file to keep, and
 * everything of this one (commandes, règlements, avoirs, factures, retours,
 * SAV, consignes, fidélité, accès portail) moves to it before this file is
 * deleted. Garages, clients PRO and particuliers can all be merged together:
 * the file kept decides the category.
 */

export type MergeTarget = {
  id: string;
  name: string;
  phone: string | null;
  city: string | null;
  kind: AccountKind;
};

/** Where the kept file lives. */
export function mergeTargetHref(t: MergeTarget): string {
  return t.kind === "GARAGE" ? `/dashboard/garages/${t.id}` : t.kind === "PRO" ? `/dashboard/pros/${t.id}` : `/dashboard/clients/${t.id}`;
}

export function MergeClientDialog({
  open,
  supabase,
  orgId,
  sourceId,
  sourceName,
  onClose,
  onMerged,
}: {
  open: boolean;
  supabase: SupabaseClient;
  orgId: string | undefined;
  /** The file that disappears into the one picked. */
  sourceId: string;
  sourceName: string;
  onClose: () => void;
  onMerged: (kept: MergeTarget) => void;
}) {
  // null = not loaded yet (the list is read each time the dialog opens).
  const [options, setOptions] = useState<MergeTarget[] | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<MergeTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !orgId || options !== null) return;
    let alive = true;
    Promise.all([loadGarages(supabase, orgId), loadClients(supabase, orgId)])
      .then(([garages, clients]) => {
        if (!alive) return;
        const seen = new Set<string>();
        const list: MergeTarget[] = [];
        for (const g of garages) {
          seen.add(g.id);
          list.push({ id: g.id, name: g.name, phone: g.phone, city: g.city, kind: g.kind });
        }
        for (const c of clients) {
          if (seen.has(c.id)) continue;
          list.push({ id: c.id, name: c.name, phone: c.phone, city: null, kind: "PARTICULIER" });
        }
        setOptions(list.filter((o) => o.id !== sourceId));
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [open, orgId, options, sourceId, supabase]);

  /** Closing forgets everything, so the next opening starts clean and reloads the files. */
  function close() {
    if (busy) return;
    setOptions(null);
    setQuery("");
    setTarget(null);
    setError(null);
    onClose();
  }

  // The likely twins first: same name as this file, then the search.
  const shown = useMemo(() => {
    const all = options ?? [];
    const q = query.trim();
    const qName = normName(q);
    const qPhone = normPhone(q);
    const srcName = normName(sourceName);
    const score = (o: MergeTarget) => (normName(o.name) === srcName ? 0 : 1);
    const pool = q
      ? all.filter((o) => (qName && normName(o.name).includes(qName)) || (qPhone.length >= 4 && normPhone(o.phone).includes(qPhone)))
      : all;
    return [...pool].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, "fr")).slice(0, 40);
  }, [options, query, sourceName]);

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await mergeClients(supabase, target.id, sourceId);
      onMerged(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="ga-modal-overlay" onClick={close}>
      <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="merge-title" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title" id="merge-title"><GitMerge className="h-4 w-4" /> Fusionner {sourceName}</span>
          <button type="button" className="ga-modal-close" onClick={close} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
        </div>
        <div className="ga-modal-form">
          <p className="od-hint">
            Choisissez la fiche à <strong>conserver</strong>. Tout l&apos;historique de « {sourceName} » (commandes, règlements, encours,
            avoirs, factures, retours, SAV, fidélité, accès au portail) passe sur cette fiche, puis « {sourceName} » est supprimée.
            La fiche conservée garde sa catégorie et ses coordonnées ; ses champs vides sont complétés.
          </p>
          <div className="od-field">
            <span className="od-label">Fiche à conserver</span>
            <div className="mg-search">
              <Search className="h-4 w-4" />
              <input className="od-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nom ou téléphone…" autoFocus />
            </div>
            {options === null ? (
              <p className="od-hint"><Loader2 className="h-4 w-4 nc-spin" /> Chargement des fiches…</p>
            ) : (
              <div className="mg-list" role="radiogroup" aria-label="Fiche à conserver">
                {shown.length === 0 && <p className="od-hint">Aucune fiche ne correspond.</p>}
                {shown.map((o) => (
                  <label key={o.id} className={`mg-item${target?.id === o.id ? " mg-item--on" : ""}`}>
                    <input type="radio" name="merge-target" checked={target?.id === o.id} onChange={() => setTarget(o)} />
                    <span className="mg-item-text">
                      <strong>{o.name}</strong>
                      <small>
                        {KIND_LABEL[o.kind]}
                        {o.phone ? ` · ${o.phone}` : ""}
                        {o.city ? ` · ${o.city}` : ""}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {error && <div className="nc-error">{error}</div>}
          <div className="ga-modal-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={close} disabled={busy}>Annuler</button>
            <button type="button" className="od-btn od-btn--danger" onClick={() => void submit()} disabled={busy || !target}>
              {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <GitMerge className="h-4 w-4" />}
              {target ? `Fusionner dans « ${target.name} »` : "Fusionner"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
