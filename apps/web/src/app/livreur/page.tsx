"use client";

import {
  Check,
  CheckCircle2,
  Loader2,
  LogOut,
  MapPin,
  Package,
  Phone,
  RefreshCw,
  Truck,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { markOrderDelivered } from "@/lib/data/livreurs";
import { toNumber } from "@/lib/data/saas";

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
  city: string | null;
  isGarage: boolean;
  workflow: string;
  dateEnvoi: string | null;
  pieces: { name: string; reference: string; quantity: number }[];
};

function fmtTime(v: string | null): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Mobile space for a LIVREUR: only the deliveries assigned to them (RLS
 * enforces it server-side), one button per delivery. Nothing else.
 */
export default function LivreurPage() {
  const { profile, ready, logout } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [rows, setRows] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Only livreur sessions belong here.
  useEffect(() => {
    if (!ready) return;
    if (!profile) {
      router.replace("/login");
      return;
    }
    if (profile.role !== "LIVREUR") router.replace("/dashboard");
  }, [ready, profile, router]);

  const load = useCallback(async () => {
    if (!profile?.organization_id || profile.role !== "LIVREUR") return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await supabase
        .from("orders")
        .select(
          "id,ref_demande,workflow_status,date_envoi,client_phone,clients(name,phone,city,is_garage)," +
            "order_lines(nom_produit,reference,quantity)",
        )
        .eq("organization_id", profile.organization_id)
        .in("workflow_status", ["IN_TRANSIT", "DELIVERED"])
        .order("date_envoi", { ascending: false })
        .limit(60);
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
            city: (client?.city as string | null) ?? null,
            isGarage: client?.is_garage === true,
            workflow: String(row.workflow_status ?? ""),
            dateEnvoi: (row.date_envoi as string | null) ?? null,
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

  const inTransit = rows.filter((r) => r.workflow === "IN_TRANSIT");
  const today = new Date().toDateString();
  const deliveredToday = rows.filter(
    (r) => r.workflow === "DELIVERED" && r.dateEnvoi && new Date(r.dateEnvoi).toDateString() === today,
  );

  async function deliver(d: Delivery) {
    setBusy(d.id);
    setError(null);
    try {
      await markOrderDelivered(supabase, d.id);
      setNotice(`${d.ref} livrée ✓`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

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
        <button type="button" className="lp-iconbtn" onClick={() => void load()} aria-label="Actualiser" disabled={loading}>
          {loading ? <Loader2 className="h-5 w-5 nc-spin" /> : <RefreshCw className="h-5 w-5" />}
        </button>
        <button
          type="button"
          className="lp-iconbtn"
          aria-label="Se déconnecter"
          onClick={() => {
            void logout().then(() => router.replace("/login"));
          }}
        >
          <LogOut className="h-5 w-5" />
        </button>
      </header>

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

        {inTransit.map((d) => (
          <article key={d.id} className="lp-card">
            <div className="lp-card-head">
              <div>
                <p className="lp-client">
                  {d.client}
                  {d.isGarage && <span className="lp-tag">Garage</span>}
                </p>
                <p className="lp-meta">
                  {d.ref}
                  {d.dateEnvoi ? ` · départ ${fmtTime(d.dateEnvoi)}` : ""}
                </p>
              </div>
            </div>
            <div className="lp-contact">
              {d.phone && (
                <a href={`tel:${d.phone.replace(/\s/g, "")}`} className="lp-call">
                  <Phone className="h-4 w-4" />
                  {d.phone}
                </a>
              )}
              {d.city && (
                <span className="lp-city"><MapPin className="h-4 w-4" />{d.city}</span>
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
            <button
              type="button"
              className="lp-deliver"
              disabled={busy !== null}
              onClick={() => void deliver(d)}
            >
              {busy === d.id ? <Loader2 className="h-5 w-5 nc-spin" /> : <Check className="h-5 w-5" />}
              Livrée
            </button>
          </article>
        ))}

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
                  <p className="lp-meta">{d.ref} · {d.pieces.reduce((s, p) => s + p.quantity, 0)} pièce(s)</p>
                </div>
              </article>
            ))}
          </>
        )}
      </main>
    </div>
  );
}
