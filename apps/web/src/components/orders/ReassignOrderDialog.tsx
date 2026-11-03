"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { ArrowRightLeft, Loader2, Search, Truck, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { normName, type AccountKind } from "@/lib/data/client-duplicates";
import { normPhone } from "@/lib/data/clients";
import { loadLivreurs, type Livreur } from "@/lib/data/livreurs";
import { reassignOrder, type ReassignTarget } from "@/lib/data/orders";
import { fmtMoney, loadClients, loadGarages } from "@/lib/data/saas";

/*
 * « Changer le destinataire » (2026-11-03). A part ordered for the stock turns
 * out to be for a garage, or an order was keyed on the wrong file: the counter
 * moves the order to the stock or to another file instead of cancelling and
 * re-entering it. The amount is summed again from the lines' selling prices;
 * a garage goes « en compte » and into the delivery flow, straight away with a
 * livreur when one is picked here.
 */

type Target = "STOCK" | AccountKind;

type FileOption = { id: string; name: string; phone: string | null; city: string | null; kind: AccountKind };

const TARGET_LABEL: Record<Target, string> = {
  STOCK: "Stock magasin",
  GARAGE: "Garage",
  PRO: "Client PRO",
  PARTICULIER: "Client particulier",
};

export function ReassignOrderDialog({
  open,
  supabase,
  orgId,
  orderId,
  orderRef,
  current,
  onClose,
  onDone,
}: {
  open: boolean;
  supabase: SupabaseClient;
  orgId: string | undefined;
  orderId: string;
  orderRef: string;
  /** Where the order is today. */
  current: { target: Target; clientName: string | null };
  onClose: () => void;
  onDone: (result: ReassignTarget) => void;
}) {
  const [target, setTarget] = useState<Target>(current.target === "STOCK" ? "GARAGE" : "STOCK");
  const [files, setFiles] = useState<FileOption[] | null>(null);
  const [livreurs, setLivreurs] = useState<Livreur[]>([]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<FileOption | null>(null);
  const [sendNow, setSendNow] = useState(false);
  const [livreurId, setLivreurId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !orgId || files !== null) return;
    let alive = true;
    Promise.all([loadGarages(supabase, orgId), loadClients(supabase, orgId), loadLivreurs(supabase, orgId, { activeOnly: true }).catch(() => [] as Livreur[])])
      .then(([garages, clients, lv]) => {
        if (!alive) return;
        const seen = new Set<string>();
        const list: FileOption[] = [];
        for (const g of garages) {
          seen.add(g.id);
          list.push({ id: g.id, name: g.name, phone: g.phone, city: g.city, kind: g.kind });
        }
        for (const c of clients) {
          if (seen.has(c.id)) continue;
          list.push({ id: c.id, name: c.name, phone: c.phone, city: null, kind: "PARTICULIER" });
        }
        setFiles(list);
        setLivreurs(lv);
        setLivreurId((prev) => prev || lv[0]?.id || "");
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setFiles([]);
      });
    return () => {
      alive = false;
    };
  }, [open, orgId, files, supabase]);

  function close() {
    if (busy) return;
    setFiles(null);
    setQuery("");
    setPicked(null);
    setSendNow(false);
    setError(null);
    onClose();
  }

  const shown = useMemo(() => {
    if (target === "STOCK") return [];
    const q = query.trim();
    const qName = normName(q);
    const qPhone = normPhone(q);
    const pool = (files ?? []).filter((f) => f.kind === target);
    const hits = q
      ? pool.filter((f) => (qName && normName(f.name).includes(qName)) || (qPhone.length >= 4 && normPhone(f.phone).includes(qPhone)))
      : pool;
    return [...hits].sort((a, b) => a.name.localeCompare(b.name, "fr")).slice(0, 40);
  }, [files, target, query]);

  const ready = target === "STOCK" || (picked !== null && picked.kind === target);

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reassignOrder(supabase, orderId, target === "STOCK" ? null : picked!.id, {
        livreurId: target === "GARAGE" && sendNow && livreurId ? livreurId : null,
      });
      onDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (!open) return null;
  return (
    <div className="ga-modal-overlay" onClick={close}>
      <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="reassign-title" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title" id="reassign-title"><ArrowRightLeft className="h-4 w-4" /> Changer le destinataire de {orderRef}</span>
          <button type="button" className="ga-modal-close" onClick={close} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
        </div>
        <div className="ga-modal-form">
          <p className="od-hint">
            Aujourd&apos;hui : <strong>{TARGET_LABEL[current.target]}{current.clientName ? ` — ${current.clientName}` : ""}</strong>.
            Les pièces et leur tournée ne changent pas. Le montant est recalculé à partir des prix de vente des lignes ;
            un garage passe en compte et part en livraison ; vers le stock, il n&apos;y a plus rien à encaisser.
          </p>
          <div className="od-field">
            <span className="od-label">Pour qui ?</span>
            <div className="nc-chips" role="radiogroup" aria-label="Destinataire">
              {(["STOCK", "GARAGE", "PRO", "PARTICULIER"] as Target[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={target === t}
                  className={`nc-chip${target === t ? " nc-chip--on" : ""}`}
                  disabled={t === current.target && t === "STOCK"}
                  onClick={() => {
                    setTarget(t);
                    setPicked(null);
                  }}
                >
                  {TARGET_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          {target !== "STOCK" && (
            <div className="od-field">
              <span className="od-label">{TARGET_LABEL[target]}</span>
              <div className="mg-search">
                <Search className="h-4 w-4" />
                <input className="od-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nom ou téléphone…" autoFocus />
              </div>
              {files === null ? (
                <p className="od-hint"><Loader2 className="h-4 w-4 nc-spin" /> Chargement des fiches…</p>
              ) : (
                <div className="mg-list" role="radiogroup" aria-label="Fiche">
                  {shown.length === 0 && <p className="od-hint">Aucune fiche ne correspond.</p>}
                  {shown.map((f) => (
                    <label key={f.id} className={`mg-item${picked?.id === f.id ? " mg-item--on" : ""}`}>
                      <input type="radio" name="reassign-file" checked={picked?.id === f.id} onChange={() => setPicked(f)} />
                      <span className="mg-item-text">
                        <strong>{f.name}</strong>
                        <small>
                          {f.phone ?? "sans téléphone"}
                          {f.city ? ` · ${f.city}` : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {target === "GARAGE" && livreurs.length > 0 && (
            <div className="od-field">
              <label className="nc-check">
                <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
                <span><Truck className="h-4 w-4" /> Envoyer tout de suite au livreur</span>
              </label>
              {sendNow && (
                <select className="od-input" value={livreurId} onChange={(e) => setLivreurId(e.target.value)}>
                  {livreurs.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}
          {error && <div className="nc-error">{error}</div>}
          <div className="ga-modal-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={close} disabled={busy}>Annuler</button>
            <button type="button" className="od-btn od-btn--primary" onClick={() => void submit()} disabled={busy || !ready}>
              {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
              {target === "STOCK" ? "Passer au stock magasin" : picked ? `Rattacher à « ${picked.name} »` : "Rattacher"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function describeReassign(r: ReassignTarget): string {
  if (r.kind === "STOCK") return "La commande est maintenant un réapprovisionnement du stock : plus de client, rien à encaisser.";
  const who = r.kind === "GARAGE" ? "au garage" : r.kind === "PRO" ? "au client PRO" : "au client";
  return `Commande rattachée ${who} « ${r.clientName ?? ""} » — montant ${fmtMoney(r.total)}${r.kind === "GARAGE" ? ", en compte" : ""}.`;
}
