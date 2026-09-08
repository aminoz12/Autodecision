"use client";

import {
  AlertTriangle,
  Camera,
  Check,
  CheckCircle2,
  Loader2,
  LogOut,
  MapPin,
  Navigation,
  Package,
  Phone,
  RefreshCw,
  Truck,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { NotificationBell } from "@/components/NotificationBell";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  compressImage,
  DELIVERY_FAILURE_REASONS,
  deliverOrder,
  mapsLink,
  reportDeliveryFailure,
  uploadProofOfDelivery,
} from "@/lib/data/delivery";
import { toNumber } from "@/lib/data/saas";
import { homeSpace } from "@/lib/spaces";

type Embedded<T> = T | T[] | null | undefined;
function first<T>(v: Embedded<T>): T | null {
  if (!v) return null;
  return Array.isArray(v) ? v[0] ?? null : v;
}
function arr<T>(v: Embedded<T>): T[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

type Delivery = {
  id: string;
  ref: string;
  client: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  isGarage: boolean;
  workflow: string;
  dateEnvoi: string | null;
  deliveredAt: string | null;
  attempts: number;
  failedReason: string | null;
  note: string | null;
  pieces: { name: string; reference: string; quantity: number }[];
};

function fmtTime(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Mobile space for a LIVREUR: the deliveries assigned to them (RLS enforces
 * it server-side), in tour order, with the address, a call button, the
 * itinerary, and one clear outcome per stop: delivered (with proof) or not.
 */
export default function LivreurPage() {
  const { user, profile, ready, logout } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [rows, setRows] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);

  // Only livreur sessions belong here — anonymous visitors get this
  // space's login page, other accounts go to their own space.
  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/livreur/login");
      return;
    }
    if (profile?.role !== "LIVREUR") router.replace(homeSpace(profile, user.email));
  }, [ready, user, profile, router]);

  // Installable app + offline shell.
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const load = useCallback(async () => {
    if (!profile?.organization_id || profile.role !== "LIVREUR") return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from("orders")
        .select(
          "id,ref_demande,workflow_status,date_envoi,delivered_at,delivery_attempts,delivery_failed_reason,consigne,client_phone," +
            "clients(name,phone,address,city,is_garage),order_lines(nom_produit,reference,quantity)",
        )
        .eq("organization_id", profile.organization_id)
        .eq("livreur_id", profile.livreur_id ?? "")
        .in("workflow_status", ["IN_TRANSIT", "DELIVERED"])
        .order("date_envoi", { ascending: true })
        .limit(80);
      if (err) throw new Error(err.message);
      setRows(
        (data ?? []).map((raw) => {
          const row = raw as unknown as Record<string, unknown>;
          const client = first(row.clients as Embedded<Record<string, unknown>>);
          return {
            id: String(row.id),
            ref: String(row.ref_demande ?? ""),
            client: String(client?.name ?? row.client_phone ?? "Client"),
            phone: (client?.phone as string | null) ?? (row.client_phone as string | null) ?? null,
            address: (client?.address as string | null) ?? null,
            city: (client?.city as string | null) ?? null,
            isGarage: client?.is_garage === true,
            workflow: String(row.workflow_status ?? ""),
            dateEnvoi: (row.date_envoi as string | null) ?? null,
            deliveredAt: (row.delivered_at as string | null) ?? null,
            attempts: toNumber(row.delivery_attempts),
            failedReason: (row.delivery_failed_reason as string | null) ?? null,
            note: (row.consigne as string | null) ?? null,
            pieces: arr(row.order_lines as Embedded<Record<string, unknown>>).map((l) => ({
              name: String(l.nom_produit ?? ""),
              reference: String(l.reference ?? ""),
              quantity: toNumber(l.quantity),
            })),
          };
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, profile]);

  useEffect(() => {
    void load();
  }, [load]);

  // Tour order: departure slot first, then the oldest dispatch.
  const inTransit = rows.filter((r) => r.workflow === "IN_TRANSIT");
  const today = new Date().toDateString();
  const deliveredToday = rows.filter(
    (r) => r.workflow === "DELIVERED" && r.deliveredAt && new Date(r.deliveredAt).toDateString() === today,
  );

  /* ---- Livrée (avec preuve) ---- */
  const [deliver, setDeliver] = useState<Delivery | null>(null);
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  const openDeliver = (d: Delivery) => {
    setDeliver(d);
    setRecipient("");
    setNote("");
    setPhoto(null);
    setModalError(null);
  };

  const submitDeliver = async () => {
    if (!deliver || !profile?.organization_id) return;
    setBusy(true);
    setModalError(null);
    try {
      let podPath: string | null = null;
      if (photo) {
        const small = await compressImage(photo);
        podPath = await uploadProofOfDelivery(supabase, profile.organization_id, deliver.id, small);
      }
      await deliverOrder(supabase, { orderId: deliver.id, recipient, note, podPath });
      setNotice(`${deliver.ref} livrée ✓`);
      setDeliver(null);
      await load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ---- Échec ---- */
  const [fail, setFail] = useState<Delivery | null>(null);
  const [failReason, setFailReason] = useState<string>(DELIVERY_FAILURE_REASONS[0]);
  const [failDetail, setFailDetail] = useState("");

  const submitFail = async () => {
    if (!fail) return;
    setBusy(true);
    setModalError(null);
    try {
      const reason = failReason === "Autre" ? failDetail.trim() : `${failReason}${failDetail.trim() ? ` — ${failDetail.trim()}` : ""}`;
      if (!reason) {
        setModalError("Précisez le motif.");
        setBusy(false);
        return;
      }
      await reportDeliveryFailure(supabase, { orderId: fail.id, reason });
      setNotice(`${fail.ref} : livraison non effectuée, le magasin est prévenu.`);
      setFail(null);
      await load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ready || !profile || profile.role !== "LIVREUR") {
    return <div className="lp-page"><p className="lp-loading">Chargement…</p></div>;
  }

  return (
    <div className="lp-page">
      <header className="lp-header">
        <span className="lp-brand"><Truck className="h-5 w-5" /></span>
        <div className="lp-header-text">
          <p className="lp-title">Ma tournée</p>
          <p className="lp-sub">{profile.display_name}</p>
        </div>
        <NotificationBell compact />
        <button type="button" className="lp-iconbtn" onClick={() => void load()} aria-label="Actualiser" disabled={loading}>
          {loading ? <Loader2 className="h-5 w-5 nc-spin" /> : <RefreshCw className="h-5 w-5" />}
        </button>
        <button
          type="button"
          className="lp-iconbtn"
          aria-label="Se déconnecter"
          onClick={() => {
            void logout().then(() => router.replace("/livreur/login"));
          }}
        >
          <LogOut className="h-5 w-5" />
        </button>
      </header>

      {!online && <div className="lp-offline">Hors connexion : les livraisons affichées sont celles du dernier chargement.</div>}
      {error && <div className="nc-error lp-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      <main className="lp-main">
        <p className="lp-section">
          À livrer <span className="lp-count">{inTransit.length}</span>
        </p>

        {loading && rows.length === 0 && <p className="lp-loading">Chargement des livraisons…</p>}

        {!loading && inTransit.length === 0 && (
          <div className="lp-empty">
            <CheckCircle2 className="h-8 w-8" />
            <p>Aucune livraison en attente. 👍</p>
          </div>
        )}

        {inTransit.map((d, idx) => {
          const link = mapsLink(d.address, d.city);
          return (
            <article key={d.id} className="lp-card">
              <div className="lp-card-head">
                <span className="lp-stop">{idx + 1}</span>
                <div>
                  <p className="lp-client">
                    {d.client}
                    {d.isGarage && <span className="lp-tag">Garage</span>}
                  </p>
                  <p className="lp-meta">
                    {d.ref}
                    {d.dateEnvoi ? ` · créneau ${fmtTime(d.dateEnvoi)}` : ""}
                    {d.attempts > 0 ? ` · ${d.attempts + 1}ᵉ passage` : ""}
                  </p>
                </div>
              </div>
              {d.failedReason && d.attempts > 0 && (
                <p className="lp-warn"><AlertTriangle className="h-4 w-4" /> Dernier passage : {d.failedReason}</p>
              )}
              <div className="lp-address">
                <MapPin className="h-4 w-4" />
                <span>
                  {d.address ? <strong>{d.address}</strong> : <em>Adresse non renseignée</em>}
                  {d.city ? <> · {d.city}</> : null}
                </span>
              </div>
              {d.note && <p className="lp-note">📝 {d.note}</p>}
              <div className="lp-contact">
                {d.phone && (
                  <a href={`tel:${d.phone.replace(/\s/g, "")}`} className="lp-call">
                    <Phone className="h-4 w-4" />
                    Appeler
                  </a>
                )}
                {link && (
                  <a href={link} target="_blank" rel="noreferrer" className="lp-call lp-call--nav">
                    <Navigation className="h-4 w-4" />
                    Itinéraire
                  </a>
                )}
              </div>
              <div className="lp-pieces">
                <p className="lp-pieces-title">
                  <Package className="h-4 w-4" />
                  {d.pieces.reduce((s, p) => s + p.quantity, 0)} pièce(s)
                </p>
                {d.pieces.map((p, i) => (
                  <p key={i} className="lp-piece">
                    <strong>×{p.quantity}</strong> {p.name} <span>({p.reference})</span>
                  </p>
                ))}
              </div>
              <div className="lp-actions">
                <button type="button" className="lp-fail" disabled={busy} onClick={() => { setFail(d); setFailReason(DELIVERY_FAILURE_REASONS[0]); setFailDetail(""); setModalError(null); }}>
                  <X className="h-5 w-5" /> Non livrée
                </button>
                <button type="button" className="lp-deliver" disabled={busy} onClick={() => openDeliver(d)}>
                  <Check className="h-5 w-5" /> Livrée
                </button>
              </div>
            </article>
          );
        })}

        {deliveredToday.length > 0 && (
          <>
            <p className="lp-section lp-section--done">
              Livrées aujourd&apos;hui <span className="lp-count lp-count--done">{deliveredToday.length}</span>
            </p>
            {deliveredToday.map((d) => (
              <article key={d.id} className="lp-card lp-card--done">
                <CheckCircle2 className="h-5 w-5" />
                <div>
                  <p className="lp-client">{d.client}</p>
                  <p className="lp-meta">{d.ref} · {fmtTime(d.deliveredAt)} · {d.pieces.reduce((s, p) => s + p.quantity, 0)} pièce(s)</p>
                </div>
              </article>
            ))}
          </>
        )}
      </main>

      {deliver && (
        <div className="ga-modal-overlay" onClick={() => !busy && setDeliver(null)}>
          <div className="ga-modal lp-modal" role="dialog" aria-modal="true" aria-labelledby="deliver-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="deliver-title"><Check className="h-4 w-4" /> Livrée — {deliver.client}</span>
              <button type="button" className="ga-modal-close" onClick={() => setDeliver(null)} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {modalError && <div className="nc-error">{modalError}</div>}
              <div className="od-field">
                <span className="od-label">Remis à (nom)</span>
                <input className="od-input" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="M. Martin, réception…" />
              </div>
              <div className="od-field">
                <span className="od-label">Photo (preuve de livraison)</span>
                <label className="lp-photo">
                  <Camera className="h-5 w-5" />
                  <span>{photo ? photo.name : "Prendre une photo"}</span>
                  <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
                </label>
              </div>
              <div className="od-field">
                <span className="od-label">Remarque</span>
                <input className="od-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Déposé au comptoir, colis ouvert…" />
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setDeliver(null)} disabled={busy}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitDeliver()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Confirmer la livraison
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {fail && (
        <div className="ga-modal-overlay" onClick={() => !busy && setFail(null)}>
          <div className="ga-modal lp-modal" role="dialog" aria-modal="true" aria-labelledby="fail-title" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="fail-title"><AlertTriangle className="h-4 w-4" /> Non livrée — {fail.client}</span>
              <button type="button" className="ga-modal-close" onClick={() => setFail(null)} aria-label="Fermer" disabled={busy}><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              {modalError && <div className="nc-error">{modalError}</div>}
              <div className="od-field">
                <span className="od-label">Motif</span>
                <div className="lp-reasons" role="radiogroup">
                  {DELIVERY_FAILURE_REASONS.map((r) => (
                    <button key={r} type="button" role="radio" aria-checked={failReason === r} className={`nc-chip${failReason === r ? " nc-chip--on" : ""}`} onClick={() => setFailReason(r)}>{r}</button>
                  ))}
                </div>
              </div>
              <div className="od-field">
                <span className="od-label">{failReason === "Autre" ? "Précisez" : "Détail (facultatif)"}</span>
                <input className="od-input" value={failDetail} onChange={(e) => setFailDetail(e.target.value)} placeholder="Personne au garage à 15 h, rappelé…" />
              </div>
              <p className="st-cmd-hint">La commande revient dans « Commande à livrer » et le magasin reçoit une alerte.</p>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setFail(null)} disabled={busy}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitFail()} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <AlertTriangle className="h-4 w-4" />} Signaler
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
