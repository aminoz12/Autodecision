"use client";

import {
  Check,
  Loader2,
  Package,
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
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { fmtDateTime } from "@/lib/data/saas";
import {
  createLivreur,
  loadDeliveriesInProgress,
  loadLivreurs,
  markOrderDelivered,
  updateLivreur,
  type Livreur,
  type LivreurDelivery,
} from "@/lib/data/livreurs";

const AVATAR_COLORS = ["#635BFF", "#0570DE", "#1EA672", "#ED6704", "#DF1B41", "#533AFD"];

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export default function LivreursPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const isAdmin = profile?.role === "ADMIN" && !profile.client_id;
  const supabase = useMemo(() => createClient(), []);

  const [livreurs, setLivreurs] = useState<Livreur[]>([]);
  const [deliveries, setDeliveries] = useState<LivreurDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      const [l, d] = await Promise.all([
        loadLivreurs(supabase, orgId),
        loadDeliveriesInProgress(supabase, orgId),
      ]);
      setLivreurs(l);
      setDeliveries(d);
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

  const stats = useMemo(
    () => ({
      active: livreurs.filter((l) => l.active).length,
      inTransit: deliveries.length,
      unassigned: (byLivreur.get("none") ?? []).length,
    }),
    [livreurs, deliveries, byLivreur],
  );

  async function run(key: string, fn: () => Promise<void>, ok?: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      if (ok) setNotice(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    await run(
      "add",
      async () => {
        await createLivreur(supabase, orgId, {
          name: newName,
          phone: newPhone,
          sortOrder: livreurs.length + 1,
        });
        setNewName("");
        setNewPhone("");
        setAdding(false);
      },
      "Livreur ajouté.",
    );
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !editing) return;
    const cur = editing;
    await run(
      `edit-${cur.id}`,
      async () => {
        await updateLivreur(supabase, orgId, cur.id, { name: cur.name, phone: cur.phone });
        setEditing(null);
      },
      "Livreur mis à jour.",
    );
  }

  const unassigned = byLivreur.get("none") ?? [];

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            Mes <span className="nc-title-accent">livreurs</span>
          </h1>
          <p className="rl-subtitle">
            Vos livreurs et les commandes garages qu&apos;ils ont en cours de livraison.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
          {isAdmin && (
            <Link href="/dashboard/admin" className="od-btn od-btn--primary">
              <Plus className="h-4 w-4" />
              Gérer les livreurs
            </Link>
          )}
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      <div className="ga-stats lv-stats">
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#635BFF" }}><UserRound className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{stats.active}</p><p className="ga-stat-label">Livreurs actifs</p></div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: "#EEEDFF", color: "#533AFD" }}><Truck className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{stats.inTransit}</p><p className="ga-stat-label">Livraisons en cours</p></div>
        </div>
        <div className="ga-stat">
          <span className="ga-stat-icon" style={{ background: stats.unassigned > 0 ? "#FFE7F2" : "#F6F8FA", color: stats.unassigned > 0 ? "#B3093C" : "#697386" }}><Package className="h-5 w-5" /></span>
          <div><p className="ga-stat-value">{stats.unassigned}</p><p className="ga-stat-label">Sans livreur assigné</p></div>
        </div>
      </div>

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
            <input className="od-input" placeholder="06 …" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
          </div>
          <div className="lv-add-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={() => setAdding(false)}>Annuler</button>
            <button type="submit" className="od-btn od-btn--primary" disabled={busy === "add" || !newName.trim()}>
              {busy === "add" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
              Enregistrer
            </button>
          </div>
        </form>
      )}

      {/* ---- Livreurs ---- */}
      <div className="lv-grid">
        {livreurs.map((l, i) => {
          const mine = byLivreur.get(l.id) ?? [];
          const isEditing = editing?.id === l.id;
          const color = AVATAR_COLORS[i % AVATAR_COLORS.length];
          return (
            <section key={l.id} className={`od-card lv-card${l.active ? "" : " lv-card--off"}`}>
              <div className="lv-card-head">
                <span className="lv-avatar lv-avatar--initials" style={{ background: color }}>{initials(l.name)}</span>
                {isEditing ? (
                  <form className="lv-edit" onSubmit={submitEdit}>
                    <input className="od-input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus aria-label="Nom" />
                    <input className="od-input" value={editing.phone} placeholder="Téléphone" onChange={(e) => setEditing({ ...editing, phone: e.target.value })} aria-label="Téléphone" />
                    <span className="lv-edit-actions">
                      <button type="submit" className="rc-act rc-act--recu" disabled={busy === `edit-${l.id}`}>
                        <Check className="h-3.5 w-3.5" /> OK
                      </button>
                      <button type="button" className="rc-act" onClick={() => setEditing(null)}><X className="h-3.5 w-3.5" /></button>
                    </span>
                  </form>
                ) : (
                  <span className="lv-card-titles">
                    <span className="lv-card-name">
                      {l.name}
                      <span className={`rt-badge rt-badge--${l.active ? "green" : "red"}`}>{l.active ? "Actif" : "Inactif"}</span>
                    </span>
                    <span className="lv-card-sub">
                      <Phone className="h-3.5 w-3.5" />
                      {l.phone ?? "Aucun téléphone"}
                    </span>
                  </span>
                )}
                {!isEditing && isAdmin && (
                  <span className="lv-card-actions">
                    <button type="button" className="rc-act rc-act--quiet" title="Renommer / téléphone" onClick={() => setEditing({ id: l.id, name: l.name, phone: l.phone ?? "" })}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      className={`rc-act rc-act--quiet${l.active ? " rc-act--nonrecu" : " rc-act--recu"}`}
                      title={l.active ? "Désactiver" : "Réactiver"}
                      disabled={busy === `toggle-${l.id}`}
                      onClick={() => orgId && run(`toggle-${l.id}`, () => updateLivreur(supabase, orgId, l.id, { active: !l.active }))}
                    >
                      <Power className="h-3.5 w-3.5" />
                    </button>
                  </span>
                )}
              </div>

              <div className="lv-card-body">
                <p className={`lv-count${mine.length > 0 ? " lv-count--busy" : ""}`}>
                  <Truck className="h-4 w-4" />
                  {mine.length === 0
                    ? "Disponible — aucune livraison en cours"
                    : `${mine.length} livraison${mine.length > 1 ? "s" : ""} en cours`}
                </p>
                {mine.map((d) => (
                  <div key={d.orderId} className="lv-delivery">
                    <span className="lv-delivery-text">
                      <Link href={`/dashboard/commandes/${d.orderId}`} className="rc-cmd">{d.orderRef}</Link>
                      <span className="lv-delivery-meta">
                        {d.clientName}
                        {d.isGarage && <span className="rc-type rc-type--garage rc-type--inline">Garage</span>}
                        {" · "}{d.pieces} pièce{d.pieces > 1 ? "s" : ""} · départ {fmtDateTime(d.dateEnvoi)}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="rc-act rc-act--recu"
                      disabled={busy === `deliver-${d.orderId}`}
                      onClick={() => run(`deliver-${d.orderId}`, () => markOrderDelivered(supabase, d.orderId), `${d.orderRef} marquée livrée.`)}
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

      {unassigned.length > 0 && (
        <section className="od-card lv-card lv-card--warn">
          <div className="lv-card-head">
            <span className="lv-avatar" style={{ background: "#FFE7F2", color: "#B3093C" }}><Package className="h-5 w-5" /></span>
            <span className="lv-card-titles">
              <span className="lv-card-name">En livraison sans livreur assigné</span>
              <span className="lv-card-sub">
                Assignez-les depuis <Link href="/dashboard/commandes" className="rc-cmd">Suivi des commandes → Commande à livrer</Link>.
              </span>
            </span>
          </div>
          <div className="lv-card-body">
            {unassigned.map((d) => (
              <div key={d.orderId} className="lv-delivery">
                <span className="lv-delivery-text">
                  <Link href={`/dashboard/commandes/${d.orderId}`} className="rc-cmd">{d.orderRef}</Link>
                  <span className="lv-delivery-meta">{d.clientName} · {d.pieces} pièce{d.pieces > 1 ? "s" : ""}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
