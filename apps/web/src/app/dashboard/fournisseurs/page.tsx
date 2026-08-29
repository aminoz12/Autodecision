"use client";

import {
  Check,
  Clock,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Truck,
  Warehouse,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  createSupplier,
  leadLabel,
  loadSuppliers,
  updateSupplier,
  type SupplierInput,
  type SupplierSummary,
} from "@/lib/data/saas";

const LEAD_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 10, 14];

type Form = { name: string; code: string; ownDelivery: boolean; leadDays: number };
const emptyForm: Form = { name: "", code: "", ownDelivery: false, leadDays: 0 };

export default function FournisseursPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const supabase = useMemo(() => createClient(), []);

  const [rows, setRows] = useState<SupplierSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // Add / edit modal
  const [modal, setModal] = useState<{ id: string | null; form: Form } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await loadSuppliers(supabase, orgId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => [r.name, r.code ?? ""].some((v) => v.toLowerCase().includes(q)));
  }, [rows, query]);

  const totals = useMemo(
    () => ({
      suppliers: rows.length,
      ownDelivery: rows.filter((r) => r.ownDelivery).length,
      pendingLines: rows.reduce((s, r) => s + r.pendingLines, 0),
      pendingPieces: rows.reduce((s, r) => s + r.pendingPieces, 0),
    }),
    [rows],
  );

  function openAdd() {
    setModal({ id: null, form: { ...emptyForm } });
    setFormError(null);
  }
  function openEdit(r: SupplierSummary) {
    setModal({ id: r.id, form: { name: r.name, code: r.code ?? "", ownDelivery: r.ownDelivery, leadDays: r.leadDays } });
    setFormError(null);
  }
  function setForm(patch: Partial<Form>) {
    setModal((m) => (m ? { ...m, form: { ...m.form, ...patch } } : m));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !modal) return;
    setSaving(true);
    setFormError(null);
    const input: SupplierInput = {
      name: modal.form.name,
      code: modal.form.code,
      ownDelivery: modal.form.ownDelivery,
      leadDays: modal.form.leadDays,
    };
    try {
      if (modal.id) {
        await updateSupplier(supabase, orgId, modal.id, input);
        setNotice(`${input.name.trim()} mis à jour.`);
      } else {
        await createSupplier(supabase, orgId, input);
        setNotice(`Fournisseur ${input.name.trim()} ajouté.`);
      }
      setModal(null);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            Mes <span className="nc-title-accent">fournisseurs</span>
          </h1>
          <p className="rl-subtitle">
            Fiches fournisseurs, mode de livraison et délai attendu — utilisés pour prévoir la réception des pièces.
          </p>
        </div>
        <div className="rl-header-actions">
          <div className="ga-search">
            <Search className="ga-search-icon h-4 w-4" />
            <input className="ga-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un fournisseur…" />
          </div>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button type="button" className="od-btn od-btn--primary" onClick={openAdd}>
            <Plus className="h-4 w-4" />
            Ajouter un fournisseur
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      <div className="ga-stats">
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#635BFF" }}><Warehouse className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{totals.suppliers}</p><p className="ga-stat-label">Fournisseurs</p></div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#533AFD" }}><Truck className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{totals.ownDelivery}</p><p className="ga-stat-label">Livrent eux-mêmes</p></div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#FCEDB9", color: "#983705" }}><Clock className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{totals.pendingLines}</p><p className="ga-stat-label">Lignes en attente</p></div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#D6ECFF", color: "#0055BC" }}><Package className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{totals.pendingPieces}</p><p className="ga-stat-label">Pièces à recevoir</p></div>
        </div>
      </div>

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table fo-table">
            <thead>
              <tr>
                <th>Fournisseur</th>
                <th>Code</th>
                <th>Livraison</th>
                <th className="rl-th-center">Délai</th>
                <th className="rl-th-center">Lignes en attente</th>
                <th className="rl-th-center">Pièces à recevoir</th>
                <th className="rl-th-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="fo-name">
                      <span className="fo-avatar">{r.name.slice(0, 2).toUpperCase()}</span>
                      <span className="rl-client">{r.name}</span>
                    </span>
                  </td>
                  <td className="rl-reffour">{r.code ?? "—"}</td>
                  <td>
                    {r.ownDelivery ? (
                      <span className="rt-badge rt-badge--violet"><Truck className="h-3.5 w-3.5" /> Livreur du fournisseur</span>
                    ) : (
                      <span className="rt-badge rt-badge--blue"><Package className="h-3.5 w-3.5" /> Tournée magasin</span>
                    )}
                  </td>
                  <td className="rl-th-center">
                    <span className={`fo-lead${r.leadDays === 0 ? " fo-lead--today" : ""}`}>{leadLabel(r.leadDays)}</span>
                  </td>
                  <td className="rl-th-center rl-qte">{r.pendingLines}</td>
                  <td className="rl-th-center rl-qte">{r.pendingPieces}</td>
                  <td className="rl-th-center">
                    <button type="button" className="rc-act rc-act--quiet" onClick={() => openEdit(r)}>
                      <Pencil className="h-3.5 w-3.5" /> Modifier
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="rc-empty-cell">
                    {rows.length === 0 ? "Aucun fournisseur — ajoutez-en un pour commander des pièces." : "Aucun fournisseur ne correspond à la recherche."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{filtered.length} fournisseur(s)</span>
        </div>
      </section>

      {modal && (
        <div className="ga-modal-overlay" onClick={() => !saving && setModal(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title">
                <Warehouse className="h-4 w-4" />
                {modal.id ? "Modifier le fournisseur" : "Nouveau fournisseur"}
              </span>
              <button type="button" className="ga-modal-close" onClick={() => setModal(null)} aria-label="Fermer" disabled={saving}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submit}>
              {formError && <div className="nc-error">{formError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Nom <span className="od-req">*</span></span>
                  <input className="od-input" value={modal.form.name} onChange={(e) => setForm({ name: e.target.value })} placeholder="Ex : BOSCH" autoFocus />
                </div>
                <div className="od-field">
                  <span className="od-label">Code</span>
                  <input className="od-input" value={modal.form.code} onChange={(e) => setForm({ code: e.target.value })} placeholder="Optionnel" />
                </div>
              </div>

              <div className="od-field">
                <span className="od-label">Mode de livraison</span>
                <div className="od-toggle-group">
                  <button
                    type="button"
                    className={`od-toggle${!modal.form.ownDelivery ? " od-toggle--on" : ""}`}
                    onClick={() => setForm({ ownDelivery: false })}
                  >
                    <Package className="h-5 w-5" />
                    <span>
                      <strong>Tournée magasin</strong>
                      <em>Les pièces arrivent sur une tournée (1, 2, 3, 4) — heure prévue connue</em>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`od-toggle${modal.form.ownDelivery ? " od-toggle--on" : ""}`}
                    onClick={() => setForm({ ownDelivery: true })}
                  >
                    <Truck className="h-5 w-5" />
                    <span>
                      <strong>Livreur du fournisseur</strong>
                      <em>Le fournisseur livre lui-même — pas de tournée, on pointe à l&apos;arrivée</em>
                    </span>
                  </button>
                </div>
              </div>

              <div className="od-field">
                <span className="od-label">Délai attendu</span>
                <div className="fo-lead-picker">
                  {LEAD_OPTIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`nc-chip${modal.form.leadDays === d ? " nc-chip--on" : ""}`}
                      onClick={() => setForm({ leadDays: d })}
                    >
                      {leadLabel(d)}
                    </button>
                  ))}
                </div>
                <span className="st-cmd-hint">
                  {modal.form.leadDays === 0
                    ? "J = le jour même de la commande."
                    : modal.form.ownDelivery
                      ? `Réception attendue ${leadLabel(modal.form.leadDays)} — le fournisseur livre vers ${modal.form.leadDays} jour${modal.form.leadDays > 1 ? "s" : ""} après la commande.`
                      : `La pièce est attendue sur la même tournée, ${modal.form.leadDays} jour${modal.form.leadDays > 1 ? "s" : ""} plus tard (${leadLabel(modal.form.leadDays)}).`}
                </span>
              </div>

              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setModal(null)} disabled={saving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={saving || !modal.form.name.trim()}>
                  {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  {modal.id ? "Enregistrer" : "Ajouter le fournisseur"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
