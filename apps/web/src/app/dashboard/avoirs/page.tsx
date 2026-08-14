"use client";

import {
  AlarmClock,
  Check,
  FileText,
  Loader2,
  Package,
  RefreshCw,
  Search,
  Undo2,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  markConsigneReturned,
  reopenConsigne,
} from "@/lib/data/consignes";
import {
  fmtDate,
  fmtMoney,
  loadCreditsAndConsignments,
  type CreditConsignRow,
} from "@/lib/data/saas";

const STATUS_CLASS: Record<string, string> = {
  EN_COURS: "encours",
  PARTIEL: "partiel",
  UTILISE: "utilise",
  EXPIRE: "expire",
  ACTIF: "actif",
  RENDUE: "rendue",
};

const STATUS_LABEL: Record<string, string> = {
  EN_COURS: "En cours",
  PARTIEL: "Partiel",
  UTILISE: "Utilise",
  EXPIRE: "Expire",
  ACTIF: "Active",
  RENDUE: "Rendue",
};

const KIND_CHIPS = [
  { id: "TOUS", label: "Tous" },
  { id: "avoir", label: "Avoirs" },
  { id: "consigne", label: "Consignes" },
];

const STATUS_CHIPS = [
  { id: "TOUS", label: "Tous statuts" },
  { id: "EN_COURS", label: "En cours" },
  { id: "PARTIEL", label: "Partiels" },
  { id: "UTILISE", label: "Utilises" },
  { id: "EXPIRE", label: "Expires" },
  { id: "ACTIF", label: "Actives" },
  { id: "RENDUE", label: "Rendues" },
];

const DAY_MS = 86_400_000;

/** Highlight an échéance: red once passed, amber within 30 days — only while
 *  there is still something to consume. */
function dueTone(row: CreditConsignRow): "expired" | "soon" | null {
  if (!row.dueAt) return null;
  if (row.status === "UTILISE" || row.status === "RENDUE") return null;
  const due = new Date(row.dueAt).getTime();
  if (due < Date.now() - DAY_MS) return "expired";
  if (due < Date.now() + 30 * DAY_MS) return "soon";
  return null;
}

export default function AvoirsPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<CreditConsignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState("TOUS");
  const [statusFilter, setStatusFilter] = useState("TOUS");
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadCreditsAndConsignments(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const setConsigneStatus = useCallback(
    async (row: CreditConsignRow, to: "ACTIF" | "RENDUE") => {
      if (!profile?.organization_id) return;
      setActingId(row.id);
      setError(null);
      try {
        const sb = createClient();
        if (to === "RENDUE") {
          await markConsigneReturned(sb, profile.organization_id, row.id);
        } else {
          await reopenConsigne(sb, profile.organization_id, row.id);
        }
        setRows((prev) =>
          prev.map((r) => (r.id === row.id && r.kind === "consigne" ? { ...r, status: to } : r)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setActingId(null);
      }
    },
    [profile?.organization_id],
  );

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (kindFilter !== "TOUS" && row.kind !== kindFilter) return false;
      if (statusFilter !== "TOUS" && row.status !== statusFilter) return false;
      if (!q) return true;
      return [row.num, row.client, row.reference, row.motif, row.designation]
        .some((v) => v.toLowerCase().includes(q));
    });
  }, [rows, search, kindFilter, statusFilter]);

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>([["TOUS", rows.length]]);
    for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    return counts;
  }, [rows]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>([["TOUS", rows.length]]);
    for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
    return counts;
  }, [rows]);

  const stats = useMemo(() => {
    const avoirs = rows.filter((r) => r.kind === "avoir");
    const openAvoirs = avoirs.filter((r) => r.status === "EN_COURS" || r.status === "PARTIEL");
    const expiring = openAvoirs.filter((r) => dueTone(r) === "soon" && r.remaining > 0);
    const activeConsignes = rows.filter((r) => r.kind === "consigne" && r.status === "ACTIF");
    return {
      emitted: avoirs.reduce((s, r) => s + r.amount, 0),
      remaining: openAvoirs.reduce((s, r) => s + r.remaining, 0),
      used: avoirs.reduce((s, r) => s + r.usedAmount, 0),
      expiringAmount: expiring.reduce((s, r) => s + r.remaining, 0),
      expiringCount: expiring.length,
      consigneAmount: activeConsignes.reduce((s, r) => s + r.amount, 0),
      consigneCount: activeConsignes.length,
    };
  }, [rows]);

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">Suivi des avoirs et consignes</h1>
          <p className="rl-subtitle">Bons d&apos;achat émis, montants consommés et consignes de pièces.</p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="rl-refresh" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      <div className="av-summary av-summary--4">
        <div className="av-sum-card av-sum-card--green">
          <span className="av-sum-icon av-sum-icon--green"><FileText className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Avoirs à consommer</p>
            <p className="av-sum-value av-sum-value--green">{fmtMoney(stats.remaining)}</p>
            <p className="av-sum-label">{fmtMoney(stats.emitted)} émis</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--amber">
          <span className="av-sum-icon av-sum-icon--amber"><AlarmClock className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Expirent sous 30 jours</p>
            <p className="av-sum-value av-sum-value--amber">{fmtMoney(stats.expiringAmount)}</p>
            <p className="av-sum-label">{stats.expiringCount} avoir(s)</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--blue">
          <span className="av-sum-icon av-sum-icon--blue"><Wallet className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Montant consommé</p>
            <p className="av-sum-value av-sum-value--blue">{fmtMoney(stats.used)}</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--orange">
          <span className="av-sum-icon av-sum-icon--orange"><Package className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Consignes actives</p>
            <p className="av-sum-value av-sum-value--orange">{fmtMoney(stats.consigneAmount)}</p>
            <p className="av-sum-label">{stats.consigneCount} en attente de retour</p>
          </div>
        </div>
      </div>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <section className="od-card rl-table-card">
        <div className="rt-filterbar">
          <div className="rt-search">
            <Search className="h-4 w-4" />
            <input
              className="od-input"
              placeholder="Rechercher (n°, client, motif, référence)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="rt-chips">
            {KIND_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                className={`rt-chip${kindFilter === chip.id ? " rt-chip--active" : ""}`}
                onClick={() => setKindFilter(chip.id)}
              >
                {chip.label}
                <span className="rt-chip-count">{kindCounts.get(chip.id) ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="rt-chips">
            {STATUS_CHIPS.map((chip) => {
              const count = statusCounts.get(chip.id) ?? 0;
              if (chip.id !== "TOUS" && count === 0) return null;
              return (
                <button
                  key={chip.id}
                  type="button"
                  className={`rt-chip${statusFilter === chip.id ? " rt-chip--active" : ""}`}
                  onClick={() => setStatusFilter(chip.id)}
                >
                  {chip.label}
                  <span className="rt-chip-count">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="rl-table-wrap">
          <table className="rl-table av-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>N Avoir / Consigne</th>
                <th>Type</th>
                <th>Client</th>
                <th>Reference</th>
                <th>Motif / Designation</th>
                <th className="av-th-right">Montant</th>
                <th className="av-th-right">Utilise</th>
                <th className="av-th-right">Reste</th>
                <th>Statut</th>
                <th>Echeance</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const tone = dueTone(row);
                const busy = actingId === row.id;
                return (
                  <tr key={`${row.kind}-${row.id}`}>
                    <td className="rl-muted-strong">{fmtDate(row.createdAt)}</td>
                    <td><span className={`av-num av-num--${row.kind}`}>{row.num}</span></td>
                    <td><span className={`av-type av-type--${row.kind}`}>{row.kind === "avoir" ? "Avoir" : "Consigne"}</span></td>
                    <td><p className="rl-client">{row.client}</p></td>
                    <td className="rl-reffour">{row.reference}</td>
                    <td><p className="av-motif">{row.motif}</p><p className="rl-muted">{row.designation}</p></td>
                    <td className={`av-th-right av-montant av-montant--${row.kind}`}>{fmtMoney(row.amount)}</td>
                    <td className="av-th-right rl-muted-strong">{row.kind === "avoir" ? fmtMoney(row.usedAmount) : "—"}</td>
                    <td className={`av-th-right av-montant av-montant--${row.kind}`}>{row.kind === "avoir" ? fmtMoney(row.remaining) : "—"}</td>
                    <td><span className={`av-statut av-statut--${STATUS_CLASS[row.status] ?? "encours"}`}>{STATUS_LABEL[row.status] ?? row.status}</span></td>
                    <td className={`rl-muted-strong${tone ? ` av-due--${tone}` : ""}`}>{fmtDate(row.dueAt)}</td>
                    <td>
                      {row.kind !== "consigne" ? (
                        <span className="rt-dash">—</span>
                      ) : busy ? (
                        <Loader2 className="h-4 w-4 nc-spin" />
                      ) : row.status === "ACTIF" ? (
                        <button
                          type="button"
                          className="rt-act rt-act--accept"
                          disabled={actingId !== null}
                          onClick={() => void setConsigneStatus(row, "RENDUE")}
                        >
                          <Check className="h-3.5 w-3.5" /> Consigne rendue
                        </button>
                      ) : row.status === "RENDUE" ? (
                        <button
                          type="button"
                          className="rt-act rt-act--pickup"
                          disabled={actingId !== null}
                          onClick={() => void setConsigneStatus(row, "ACTIF")}
                        >
                          <Undo2 className="h-3.5 w-3.5" /> Rouvrir
                        </button>
                      ) : (
                        <span className="rt-dash">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && visibleRows.length === 0 && (
                <tr>
                  <td colSpan={12} className="text-muted">
                    {rows.length === 0 ? "Aucun avoir ou consigne." : "Aucune ligne ne correspond au filtre."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{visibleRows.length} résultat(s)</span>
        </div>
      </section>
    </div>
  );
}
