"use client";

import {
  Check,
  Loader2,
  Pencil,
  Phone,
  Plus,
  Power,
  RefreshCw,
  Truck,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtDateTime, loadDeliveryTours, type DeliveryTourRow } from "@/lib/data/saas";
import {
  createLivreur,
  loadDeliveriesInProgress,
  loadLivreurs,
  markOrderDelivered,
  updateLivreur,
  type Livreur,
  type LivreurDelivery,
} from "@/lib/data/livreurs";

export default function LivreursPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const supabase = useMemo(() => createClient(), []);

  const [livreurs, setLivreurs] = useState<Livreur[]>([]);
  const [deliveries, setDeliveries] = useState<LivreurDelivery[]>([]);
  const [tours, setTours] = useState<DeliveryTourRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Add / rename
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; phone: string } | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [l, d, t] = await Promise.all([
        loadLivreurs(supabase, orgId),
        loadDeliveriesInProgress(supabase, orgId),
        loadDeliveryTours(supabase, orgId),
      ]);
      setLivreurs(l);
      setDeliveries(d);
      setTours(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const byLivreur = useMemo(() => {
    const map = new Map<string, LivreurDelivery[]>();
    for (const d of deliveries) {
      const key = d.livreurId ?? "none";
      const arr = map.get(key);
      if (arr) arr.push(d);
      else map.set(key, [d]);
    }
    return map;
  }, [deliveries]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    await run("add", async () => {
      await createLivreur(supabase, orgId, {
        name: newName,
        phone: newPhone,
        sortOrder: livreurs.length + 1,
      });
      setNewName("");
      setNewPhone("");
      setAdding(false);
    });
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !editing) return;
    const cur = editing;
    await run(`edit-${cur.id}`, async () => {
      await updateLivreur(supabase, orgId, cur.id, { name: cur.name, phone: cur.phone });
      setEditing(null);
    });
  }

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">
            Livreurs et tournées
            <span className="rl-title-icon"><Truck className="h-5 w-5" /></span>
          </h1>
          <p className="rl-subtitle">
            Vos livreurs, les commandes qu&apos;ils ont en cours de livraison et les tournées planifiées.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="od-btn od-btn--primary" onClick={() => setAdding((v) => !v)}>
            <Plus className="h-4 w-4" />
            Ajouter un livreur
          </button>
          <button type="button" className="rl-refresh" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      {adding && (
        <form className="od-card lv-add" onSubmit={submitAdd}>
          <div className="od-field">
            <span className="od-label">Nom du livreur <span className="od-req">*</span></span>
            <input
              className="od-input"
              placeholder={`Livreur ${livreurs.length + 1}`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="od-field">
            <span className="od-label">Téléphone</span>
            <input
              className="od-input"
              placeholder="06 …"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
            />
          </div>
          <div className="lv-add-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={() => setAdding(false)}>
              Annuler
            </button>
            <button type="submit" className="od-btn od-btn--primary" disabled={busy === "add" || !newName.trim()}>
              {busy === "add" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
              Enregistrer
            </button>
          </div>
        </form>
      )}

      {/* ---- Livreurs ---- */}
      <div className="lv-grid">
        {livreurs.map((l) => {
          const mine = byLivreur.get(l.id) ?? [];
          const isEditing = editing?.id === l.id;
          return (
            <section key={l.id} className={`od-card lv-card${l.active ? "" : " lv-card--off"}`}>
              <div className="lv-card-head">
                <span className="lv-avatar"><UserRound className="h-5 w-5" /></span>
                {isEditing ? (
                  <form className="lv-edit" onSubmit={submitEdit}>
                    <input
                      className="od-input"
                      value={editing.name}
                      onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                      autoFocus
                      aria-label="Nom"
                    />
                    <input
                      className="od-input"
                      value={editing.phone}
                      placeholder="Téléphone"
                      onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                      aria-label="Téléphone"
                    />
                    <span className="lv-edit-actions">
                      <button type="submit" className="rc-act rc-act--recu" disabled={busy === `edit-${l.id}`}>
                        <Check className="h-3.5 w-3.5" /> OK
                      </button>
                      <button type="button" className="rc-act" onClick={() => setEditing(null)}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  </form>
                ) : (
                  <span className="lv-card-titles">
                    <span className="lv-card-name">
                      {l.name}
                      {!l.active && <span className="rt-badge rt-badge--red">Inactif</span>}
                    </span>
                    <span className="lv-card-sub">
                      {l.phone ? (
                        <>
                          <Phone className="h-3.5 w-3.5" /> {l.phone}
                        </>
                      ) : (
                        "Aucun téléphone"
                      )}
                    </span>
                  </span>
                )}
                {!isEditing && (
                  <span className="lv-card-actions">
                    <button
                      type="button"
                      className="rc-act"
                      title="Renommer"
                      onClick={() => setEditing({ id: l.id, name: l.name, phone: l.phone ?? "" })}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className={`rc-act${l.active ? " rc-act--nonrecu" : " rc-act--recu"}`}
                      title={l.active ? "Désactiver" : "Réactiver"}
                      disabled={busy === `toggle-${l.id}`}
                      onClick={() =>
                        orgId &&
                        run(`toggle-${l.id}`, () =>
                          updateLivreur(supabase, orgId, l.id, { active: !l.active }),
                        )
                      }
                    >
                      <Power className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </div>

              <div className="lv-card-body">
                <p className="lv-count">
                  <Truck className="h-4 w-4" />
                  {mine.length === 0
                    ? "Aucune livraison en cours"
                    : `${mine.length} livraison${mine.length > 1 ? "s" : ""} en cours`}
                </p>
                {mine.map((d) => (
                  <div key={d.orderId} className="lv-delivery">
                    <span>
                      <Link href={`/dashboard/commandes/${d.orderId}`} className="rc-cmd">
                        {d.orderRef}
                      </Link>
                      <p className="rl-muted">
                        {d.clientName}
                        {d.isGarage && <span className="rt-badge rt-badge--violet" style={{ marginLeft: 6 }}>Garage</span>}
                        {" · "}{d.pieces} pièce{d.pieces > 1 ? "s" : ""} · départ {fmtDateTime(d.dateEnvoi)}
                      </p>
                    </span>
                    <button
                      type="button"
                      className="rc-act rc-act--recu"
                      disabled={busy === `deliver-${d.orderId}`}
                      onClick={() => run(`deliver-${d.orderId}`, () => markOrderDelivered(supabase, d.orderId))}
                    >
                      {busy === `deliver-${d.orderId}` ? <Loader2 className="h-3.5 w-3.5 nc-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Livrée
                    </button>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
        {!loading && livreurs.length === 0 && (
          <div className="od-card rc-empty">
            <p>Aucun livreur. Ajoutez-en un pour pouvoir envoyer des commandes en livraison.</p>
          </div>
        )}
      </div>

      {(byLivreur.get("none") ?? []).length > 0 && (
        <section className="od-card lv-card">
          <div className="lv-card-head">
            <span className="lv-avatar"><Truck className="h-5 w-5" /></span>
            <span className="lv-card-titles">
              <span className="lv-card-name">En livraison sans livreur assigné</span>
              <span className="lv-card-sub">Assignez-les depuis Suivi des commandes → Commande à livrer.</span>
            </span>
          </div>
          <div className="lv-card-body">
            {(byLivreur.get("none") ?? []).map((d) => (
              <div key={d.orderId} className="lv-delivery">
                <span>
                  <Link href={`/dashboard/commandes/${d.orderId}`} className="rc-cmd">{d.orderRef}</Link>
                  <p className="rl-muted">{d.clientName} · {d.pieces} pièce{d.pieces > 1 ? "s" : ""}</p>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Tournées ---- */}
      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table">
            <thead>
              <tr>
                <th>Tournée</th>
                <th>Date</th>
                <th>Véhicule</th>
                <th>Statut</th>
                <th className="rl-th-center">Lignes</th>
                <th className="rl-th-center">Pièces</th>
              </tr>
            </thead>
            <tbody>
              {tours.map((row) => (
                <tr key={row.id}>
                  <td className="rl-client">{row.name}</td>
                  <td className="rl-muted-strong">{fmtDate(row.date)}</td>
                  <td className="rl-reffour">{row.vehicle ?? "-"}</td>
                  <td><span className="rt-badge rt-badge--blue">{row.status}</span></td>
                  <td className="rl-th-center rl-qte">{row.lineCount}</td>
                  <td className="rl-th-center rl-qte">{row.pieceCount}</td>
                </tr>
              ))}
              {!loading && tours.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted">Aucune tournée planifiée.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
