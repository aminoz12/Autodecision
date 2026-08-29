"use client";

import {
  Award,
  Car,
  Check,
  Loader2,
  Phone,
  Plus,
  RefreshCw,
  Search,
  ShoppingCart,
  Users,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { TableSkeleton } from "@/components/ui/TableSkeleton";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney } from "@/lib/data/saas";
import {
  createParticulierClient,
  loadParticulierClients,
  LOYALTY,
  type ClientSummary,
} from "@/lib/data/clients";

function frDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

const AVATAR_COLORS = ["#4F46E5", "#0EA5E9", "#16A34A", "#DB2777", "#D97706", "#7C3AED"];

type Sort = "name" | "recent" | "revenue" | "points";

export default function ClientsParticuliersPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [rows, setRows] = useState<ClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [tierFilter, setTierFilter] = useState<string>("");

  // Nouveau client
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", plate: "", vehicle: "", city: "" });

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await loadParticulierClients(supabase, orgId));
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
    const digits = q.replace(/\D/g, "");
    let list = rows;
    if (q) {
      list = list.filter((c) =>
        [c.name, c.email, c.city, c.plate, c.vehicle].some((v) => (v ?? "").toLowerCase().includes(q)) ||
        (digits.length >= 3 && (c.phone ?? "").replace(/\D/g, "").includes(digits)),
      );
    }
    if (tierFilter) list = list.filter((c) => c.tier.id === tierFilter);
    const sorted = [...list];
    switch (sort) {
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "revenue":
        sorted.sort((a, b) => b.revenue - a.revenue);
        break;
      case "points":
        sorted.sort((a, b) => b.points - a.points);
        break;
      default:
        sorted.sort((a, b) => String(b.lastOrderAt ?? b.createdAt ?? "").localeCompare(String(a.lastOrderAt ?? a.createdAt ?? "")));
    }
    return sorted;
  }, [rows, query, sort, tierFilter]);

  const totals = useMemo(
    () => ({
      total: rows.length,
      withOrders: rows.filter((c) => c.orders > 0).length,
      revenue: rows.reduce((s, c) => s + c.revenue, 0),
      outstanding: rows.reduce((s, c) => s + c.outstanding, 0),
      points: rows.reduce((s, c) => s + c.points, 0),
      gold: rows.filter((c) => c.tier.id === "OR").length,
    }),
    [rows],
  );

  async function submitNew(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    setSaving(true);
    setFormError(null);
    try {
      const id = await createParticulierClient(supabase, orgId, form);
      setOpen(false);
      setForm({ name: "", phone: "", email: "", plate: "", vehicle: "", city: "" });
      router.push(`/dashboard/clients/${id}`);
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
          <h1 className="rl-title">
            Clients particuliers
            <span className="rl-title-icon"><Users className="h-5 w-5" /></span>
          </h1>
          <p className="rl-subtitle">
            Fichier clients, historique complet des achats et programme de fidélité
            ({LOYALTY.pointsPerEuro} point par € · 100 points = {LOYALTY.euroPer100Points} € de remise).
          </p>
        </div>
        <div className="rl-header-actions">
          <div className="ga-search">
            <Search className="ga-search-icon h-4 w-4" />
            <input
              className="ga-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Nom, téléphone, immatriculation…"
            />
          </div>
          <button type="button" className="od-btn od-btn--primary" onClick={() => { setFormError(null); setOpen(true); }}>
            <Plus className="h-4 w-4" />
            Nouveau client
          </button>
          <button type="button" className="rl-refresh" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}

      <div className="ga-stats">
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#EEF2FF", color: "#4F46E5" }}><Users className="h-5 w-5" /></span><div><p className="ga-stat-value">{totals.total}</p><p className="ga-stat-label">Clients ({totals.withOrders} avec commande)</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#DBEAFE", color: "#2563EB" }}><ShoppingCart className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.revenue)}</p><p className="ga-stat-label">CA particuliers</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FEF3C7", color: "#EA580C" }}><Wallet className="h-5 w-5" /></span><div><p className="ga-stat-value">{fmtMoney(totals.outstanding)}</p><p className="ga-stat-label">Reste à payer</p></div></div>
        <div className="ga-stat"><span className="ga-stat-icon" style={{ background: "#FEF9C3", color: "#A16207" }}><Award className="h-5 w-5" /></span><div><p className="ga-stat-value">{totals.points.toLocaleString("fr-FR")} pts</p><p className="ga-stat-label">Points en circulation · {totals.gold} client(s) Or</p></div></div>
      </div>

      <div className="cl-toolbar">
        <div className="rc-kinds" style={{ margin: 0 }}>
          {[{ id: "", label: "Tous" }, ...LOYALTY.tiers.map((t) => ({ id: t.id, label: t.label }))].map((t) => (
            <button
              key={t.id}
              type="button"
              className={`rc-kind cl-tier-filter${tierFilter === t.id ? " rc-kind--active rc-kind--client" : ""}`}
              onClick={() => setTierFilter(t.id)}
            >
              {t.id && <Award className="h-4 w-4" />}
              {t.label}
              <span className="rc-kind-count">
                {t.id ? rows.filter((c) => c.tier.id === t.id).length : rows.length}
              </span>
            </button>
          ))}
        </div>
        <label className="cl-sort">
          Trier :
          <select className="od-select-native" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="recent">Dernière commande</option>
            <option value="name">Nom</option>
            <option value="revenue">Chiffre d&apos;affaires</option>
            <option value="points">Points fidélité</option>
          </select>
        </label>
      </div>

      {loading && rows.length === 0 ? (
        <TableSkeleton rows={8} cols={8} />
      ) : (
      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table cl-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Contact</th>
                <th>Véhicule</th>
                <th className="rl-th-center">Commandes</th>
                <th>Dernière commande</th>
                <th className="rl-th-center">CA</th>
                <th className="rl-th-center">Reste dû</th>
                <th>Fidélité</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.id} className="cl-row" onClick={() => router.push(`/dashboard/clients/${c.id}`)}>
                  <td>
                    <span className="cl-id">
                      <span className="ga-avatar cl-avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                        {initials(c.name) || "?"}
                      </span>
                      <span>
                        <Link href={`/dashboard/clients/${c.id}`} className="cl-name" onClick={(e) => e.stopPropagation()}>
                          {c.name}
                        </Link>
                        <p className="rl-muted">{c.city ?? (c.createdAt ? `Client depuis ${frDate(c.createdAt)}` : "")}</p>
                      </span>
                    </span>
                  </td>
                  <td>
                    <p className="rl-client"><Phone className="h-3.5 w-3.5 cl-inline-icon" />{c.phone ?? "—"}</p>
                    <p className="rl-muted">{c.email ?? ""}</p>
                  </td>
                  <td>
                    <p className="rl-client"><Car className="h-3.5 w-3.5 cl-inline-icon" />{c.vehicle ?? "—"}</p>
                    <p className="rl-muted">{c.plate ?? ""}</p>
                  </td>
                  <td className="rl-th-center rl-qte">{c.orders}</td>
                  <td className="rl-muted-strong">{frDate(c.lastOrderAt)}</td>
                  <td className="rl-th-center rl-qte">{fmtMoney(c.revenue)}</td>
                  <td className="rl-th-center">
                    {c.outstanding > 0 ? (
                      <span className="rt-badge rt-badge--red">{fmtMoney(c.outstanding)}</span>
                    ) : (
                      <span className="rl-muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className="cl-fid">
                      <span className={`cl-tier cl-tier--${c.tier.cls}`}>
                        <Award className="h-3.5 w-3.5" />
                        {c.tier.label}
                      </span>
                      <strong>{c.points.toLocaleString("fr-FR")} pts</strong>
                    </span>
                  </td>
                </tr>
              ))}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="rc-empty-cell">
                    {rows.length === 0
                      ? "Aucun client particulier pour le moment — ils sont créés automatiquement à la première commande."
                      : "Aucun client ne correspond à la recherche."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{filtered.length} client(s)</span>
        </div>
      </section>
      )}

      {open && (
        <div className="ga-modal-overlay" onClick={() => !saving && setOpen(false)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title">
                <Users className="h-4 w-4" />
                Nouveau client particulier
              </span>
              <button type="button" className="ga-modal-close" onClick={() => setOpen(false)} aria-label="Fermer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <form className="ga-modal-form" onSubmit={submitNew}>
              {formError && <div className="nc-error">{formError}</div>}
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Nom <span className="od-req">*</span></span>
                  <input className="od-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
                </div>
                <div className="od-field">
                  <span className="od-label">Téléphone</span>
                  <input className="od-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="06 …" />
                </div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Email</span>
                  <input className="od-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
                <div className="od-field">
                  <span className="od-label">Ville</span>
                  <input className="od-input" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
              </div>
              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Immatriculation</span>
                  <input className="od-input" value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value })} placeholder="AA-123-BB" />
                </div>
                <div className="od-field">
                  <span className="od-label">Véhicule</span>
                  <input className="od-input" value={form.vehicle} onChange={(e) => setForm({ ...form, vehicle: e.target.value })} placeholder="Peugeot 308" />
                </div>
              </div>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setOpen(false)} disabled={saving}>Annuler</button>
                <button type="submit" className="od-btn od-btn--primary" disabled={saving || !form.name.trim()}>
                  {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                  Créer le client
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
