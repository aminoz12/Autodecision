"use client";

import {
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  Flag,
  Hourglass,
  Loader2,
  PackageCheck,
  Play,
  Printer,
  RefreshCw,
  RotateCcw,
  Route,
  Search,
  StickyNote,
  Store,
  Truck,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { loadLivreurs, type Livreur } from "@/lib/data/livreurs";
import {
  addDays,
  buildTourGrid,
  departureText,
  ensureSupplierTour,
  filterTourLines,
  fmtBoardDate,
  fmtHour,
  fmtRelativeDay,
  focusSlot,
  loadSupplierTourBoard,
  loadTeamOrder,
  parisDate,
  pct,
  pickupState,
  PICKUP_STATE_LABEL,
  scheduleSlots,
  setLinePickup,
  setSupplierTourStatus,
  slotLabel,
  supplierStops,
  TOUR_STATUS_LABEL,
  tourColor,
  tourStats,
  updateSupplierTour,
  vendeurColors,
  vendeurKey,
  type PickupState,
  type PickupStatus,
  type SupplierTourBoard,
  type TourLine,
  type TourStatus,
} from "@/lib/data/tournees";

/** Background refresh while the board is on screen. */
const REFRESH_MS = 30_000;

const STATES: PickupState[] = ["pending", "picked", "unavailable", "received"];
const STATE_ICON: Record<PickupState, LucideIcon | null> = {
  pending: null,
  picked: Check,
  unavailable: Ban,
  received: Store,
};

function clockText(d: Date | number): string {
  return new Date(d).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n > 1 ? "s" : ""}`;
}

function StateIcon({ state }: { state: PickupState }) {
  const Icon = STATE_ICON[state];
  return Icon ? <Icon /> : null;
}

function Kpi({
  tone,
  icon: Icon,
  label,
  value,
  share,
  sub,
}: {
  tone: "blue" | "green" | "amber" | "red";
  icon: LucideIcon;
  label: string;
  value: number;
  share?: number;
  sub?: string;
}) {
  return (
    <div className={`tf-kpi tf-kpi--${tone}`}>
      <span className="tf-kpi-icon">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="tf-kpi-label">{label}</p>
        <p className="tf-kpi-value">
          {value}
          {share !== undefined && <span className="tf-kpi-pct">{share} %</span>}
        </p>
        {sub && <p className="tf-kpi-sub">{sub}</p>}
      </div>
    </div>
  );
}

function PartChip({
  line,
  color,
  saving,
  onToggle,
  onOpen,
}: {
  line: TourLine;
  color: string;
  saving: boolean;
  onToggle: (line: TourLine, status: PickupStatus | null) => void;
  onOpen: (line: TourLine) => void;
}) {
  const state = pickupState(line);
  const picked = state === "picked";
  return (
    <span className={`tf-chip tf-chip--${state}`} style={{ "--vc": color } as CSSProperties}>
      <button
        type="button"
        role="checkbox"
        aria-checked={picked}
        className="tf-check"
        disabled={state === "received" || saving}
        onClick={() => onToggle(line, picked ? null : "PICKED_UP")}
        title={state === "received" ? "Déjà reçue au magasin" : picked ? "Remettre à récupérer" : "Marquer récupérée"}
        aria-label={`${line.reference} : ${PICKUP_STATE_LABEL[state]}`}
      >
        <StateIcon state={state} />
      </button>
      <button type="button" className="tf-ref" onClick={() => onOpen(line)} title={`${line.designation} — ${PICKUP_STATE_LABEL[state]}`}>
        {line.reference}
        {line.quantity > 1 && <em>×{line.quantity}</em>}
      </button>
    </span>
  );
}

/**
 * Tournée fournisseurs — for the counter (caissiers and admin): at each
 * tournée, the parts every vendeur ordered, one column per supplier, ticked
 * live as the livreur collects them.
 */
export default function TourneesPage() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id ?? null;
  const supabase = useMemo(() => createClient(), []);

  const [date, setDate] = useState(() => parisDate());
  const [board, setBoard] = useState<SupplierTourBoard | null>(null);
  const [livreurs, setLivreurs] = useState<Livreur[]>([]);
  const [team, setTeam] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<string | null>(null);
  const [savingLines, setSavingLines] = useState<ReadonlySet<string>>(() => new Set());

  const [tourFilter, setTourFilter] = useState("");
  const [vendeurFilter, setVendeurFilter] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [openLineId, setOpenLineId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState<{ tourId: string; text: string } | null>(null);

  /** Only the latest request may update the board (date changes, polling). */
  const seq = useRef(0);

  const refresh = useCallback(
    async (quiet = false) => {
      if (!orgId) return;
      const mine = ++seq.current;
      if (!quiet) setLoading(true);
      try {
        const fresh = await loadSupplierTourBoard(supabase, date);
        if (seq.current !== mine) return;
        setBoard(fresh);
        setSyncedAt(Date.now());
        setError(null);
      } catch (e) {
        if (seq.current === mine) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq.current === mine) {
          setLoading(false);
          setNow(new Date());
        }
      }
    },
    [supabase, orgId, date],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(new Date()), 15_000);
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(clock);
      window.clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void Promise.all([
      loadLivreurs(supabase, orgId).catch(() => [] as Livreur[]),
      loadTeamOrder(supabase, orgId),
    ]).then(([l, t]) => {
      if (cancelled) return;
      setLivreurs(l);
      setTeam(t);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase, orgId]);

  const goDate = (next: string) => {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(next) || next === date) return;
    setDate(next);
    setBoard(null);
    setSelectedKey(null);
    setTourFilter("");
    setOpenLineId(null);
    setNoteDraft(null);
  };

  /* ---- Derived ---- */
  const today = parisDate(now);
  const isToday = date === today;
  const lines = useMemo(() => board?.lines ?? [], [board]);
  const slots = useMemo(() => scheduleSlots(board?.tours ?? [], true), [board]);
  const colors = useMemo(() => vendeurColors(team, lines), [team, lines]);
  const visibleSlots = useMemo(
    () => (tourFilter ? slots.filter((s) => s.key === tourFilter) : slots),
    [slots, tourFilter],
  );
  const filtered = useMemo(
    () => filterTourLines(lines, { vendeur: vendeurFilter, supplierId: supplierFilter, query }),
    [lines, vendeurFilter, supplierFilter, query],
  );
  const grid = useMemo(() => buildTourGrid(visibleSlots, filtered), [visibleSlots, filtered]);
  const stats = useMemo(() => {
    const ids = new Set(visibleSlots.flatMap((s) => (s.tour ? [s.tour.id] : [])));
    return tourStats(filtered.filter((l) => ids.has(l.tourId)));
  }, [visibleSlots, filtered]);
  const filtering = Boolean(tourFilter || vendeurFilter || supplierFilter || query.trim());

  const vendeurOptions = useMemo(() => {
    const m = new Map<string, { name: string; count: number }>();
    for (const l of lines) {
      const cur = m.get(vendeurKey(l));
      if (cur) cur.count += 1;
      else m.set(vendeurKey(l), { name: l.vendeur, count: 1 });
    }
    return [...m.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name, "fr"));
  }, [lines]);

  const supplierOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lines) m.set(l.supplierId, l.supplier);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], "fr"));
  }, [lines]);

  const pendingByTour = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) if (pickupState(l) === "pending") m.set(l.tourId, (m.get(l.tourId) ?? 0) + 1);
    return m;
  }, [lines]);

  const focus = useMemo(() => focusSlot(slots, date, pendingByTour, now), [slots, date, pendingByTour, now]);
  const selected = slots.find((s) => s.key === selectedKey) ?? focus;
  const tour = selected?.tour ?? null;
  const tourLines = useMemo(() => (tour ? lines.filter((l) => l.tourId === tour.id) : []), [lines, tour]);
  const tourStat = useMemo(() => tourStats(tourLines), [tourLines]);
  const tourStops = useMemo(() => supplierStops(tourLines), [tourLines]);
  const livreurOptions = livreurs.filter((l) => l.active || l.id === tour?.livreurId);

  const kicker = !selected
    ? ""
    : tour?.status === "EN_COURS"
      ? "Tournée en cours"
      : isToday && selected.key === focus?.key
        ? "Prochaine tournée"
        : "Tournée sélectionnée";

  const openLine = openLineId ? lines.find((l) => l.id === openLineId) ?? null : null;
  const openSlot = openLine ? slots.find((s) => s.tour?.id === openLine.tourId) ?? null : null;

  /* ---- Actions ---- */
  async function run(key: string, fn: () => Promise<void>, ok?: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh(true);
      if (ok) setNotice(ok);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const patchLine = (id: string, patch: Partial<TourLine>) =>
    setBoard((b) => (b ? { ...b, lines: b.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)) } : b));

  async function pickup(line: TourLine, status: PickupStatus | null) {
    if (savingLines.has(line.id)) return;
    const before = { pickupStatus: line.pickupStatus, pickupAt: line.pickupAt, pickupBy: line.pickupBy };
    patchLine(line.id, {
      pickupStatus: status,
      pickupAt: status ? new Date().toISOString() : null,
      pickupBy: status ? profile?.display_name ?? null : null,
    });
    setSavingLines((s) => new Set(s).add(line.id));
    setError(null);
    try {
      await setLinePickup(supabase, line.id, status);
    } catch (e) {
      patchLine(line.id, before);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingLines((s) => {
        const next = new Set(s);
        next.delete(line.id);
        return next;
      });
    }
  }

  function changeStatus(status: TourStatus) {
    if (!tour) return;
    if (
      status === "TERMINEE" &&
      tourStat.pending > 0 &&
      !window.confirm(
        `${plural(tourStat.pending, "pièce")} pas encore récupérée${tourStat.pending > 1 ? "s" : ""} sur ${tour.name}. Finaliser la tournée quand même ?`,
      )
    ) {
      return;
    }
    const done: Record<TourStatus, string> = {
      PLANIFIEE: `${tour.name} remise en planifiée.`,
      EN_COURS: `${tour.name} en cours.`,
      TERMINEE: `${tour.name} finalisée.`,
    };
    void run(`status-${tour.id}`, () => setSupplierTourStatus(supabase, tour.id, status), done[status]);
  }

  const defaultLivreur = selected ? board?.defaults[selected.name] ?? null : null;
  const isDefault = Boolean(tour?.livreurId && defaultLivreur?.livreurId === tour.livreurId);
  const upcoming = board?.upcoming ?? [];
  const dayWord = isToday ? "aujourd'hui" : "ce jour-là";

  /** The tournée row — created on the spot when no order has opened it yet. */
  async function tourId(): Promise<string> {
    if (tour) return tour.id;
    if (!selected) throw new Error("Choisissez une tournée.");
    return ensureSupplierTour(supabase, { date, name: selected.name, slot: selected.slot });
  }

  function assignLivreur(livreurId: string) {
    if (!selected) return;
    const name = livreurs.find((l) => l.id === livreurId)?.name;
    void run(
      `assign-${selected.key}`,
      async () => updateSupplierTour(supabase, await tourId(), { livreurId: livreurId || null, note: tour?.note ?? "" }),
      name
        ? `${selected.name} confiée à ${name} pour ${dayWord} : elle apparaît dans son espace livreur.`
        : `${selected.name} sans livreur : visible par tous les livreurs.`,
    );
  }

  function rememberLivreur(remember: boolean) {
    if (!tour) return;
    const name = livreurs.find((l) => l.id === tour.livreurId)?.name ?? "ce livreur";
    void run(
      `remember-${tour.id}`,
      () => updateSupplierTour(supabase, tour.id, { livreurId: tour.livreurId, note: tour.note ?? "", remember }),
      remember
        ? `${name} fait désormais ${tour.name} tous les jours : la tournée lui est confiée dès la première commande.`
        : `${tour.name} n'a plus de livreur attitré.`,
    );
  }

  // Drafts are keyed by the slot (a tournée without a row yet has no id).
  const noteKey = selected?.key ?? "";
  const noteValue = noteDraft?.tourId === noteKey ? noteDraft.text : tour?.note ?? "";
  const noteDirty = Boolean(selected && noteDraft?.tourId === noteKey && noteDraft.text.trim() !== (tour?.note ?? ""));

  function saveNote() {
    if (!selected || !noteDraft) return;
    const text = noteDraft.text;
    void run(
      `note-${selected.key}`,
      async () => {
        await updateSupplierTour(supabase, await tourId(), { livreurId: tour?.livreurId ?? null, note: text });
        setNoteDraft(null);
      },
      text.trim() ? "Consigne enregistrée : le livreur la voit sur sa tournée." : "Consigne retirée.",
    );
  }

  const clearFilters = () => {
    setTourFilter("");
    setVendeurFilter("");
    setSupplierFilter("");
    setQuery("");
  };

  return (
    <div className="rl-page tf-page">
      <header className="rl-header tf-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            Tournée <span className="nc-title-accent">fournisseurs</span>
          </h1>
          <p className="rl-subtitle">
            Les pièces à récupérer chez chaque fournisseur, tournée par tournée — cochées en direct par le livreur.
          </p>
        </div>
        <div className="rl-header-actions tf-header-actions">
          <div className="tf-datenav">
            <button type="button" className="tf-iconbtn" onClick={() => goDate(addDays(date, -1))} aria-label="Jour précédent">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <input
              type="date"
              className="od-input tf-date-input"
              value={date}
              onChange={(e) => goDate(e.target.value)}
              aria-label="Date de la tournée"
            />
            <button type="button" className="tf-iconbtn" onClick={() => goDate(addDays(date, 1))} aria-label="Jour suivant">
              <ChevronRight className="h-4 w-4" />
            </button>
            {!isToday && (
              <button type="button" className="od-btn od-btn--ghost" onClick={() => goDate(today)}>
                Aujourd&apos;hui
              </button>
            )}
          </div>
          <div className="tf-clock">
            <span className="tf-clock-time">{clockText(now)}</span>
            {isToday ? (
              <span className="tf-live">
                <span className="tf-live-dot" />
                LIVE
              </span>
            ) : (
              <span className="tf-clock-sub">{date < today ? "Historique" : "À venir"}</span>
            )}
          </div>
          <button type="button" className="od-btn od-btn--ghost tf-noprint" onClick={() => void refresh()} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualiser
          </button>
          <button type="button" className="od-btn od-btn--ghost tf-noprint" onClick={() => window.print()}>
            <Printer className="h-4 w-4" />
            Imprimer
          </button>
        </div>
      </header>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      <div className="tf-kpis">
        <Kpi
          tone="blue"
          icon={Route}
          label={filtering ? "Pièces (sélection)" : "Pièces du jour"}
          value={stats.total}
          sub={`${plural(grid.suppliers.length, "fournisseur")} · ${plural(grid.slots.filter((s) => s.stats.total > 0).length, "tournée")}`}
        />
        <Kpi
          tone="green"
          icon={Check}
          label="Récupérées"
          value={stats.done}
          share={pct(stats.done, stats.total)}
          sub={stats.received > 0 ? `dont ${stats.received} déjà reçue${stats.received > 1 ? "s" : ""} au magasin` : undefined}
        />
        <Kpi tone="amber" icon={Hourglass} label="En attente" value={stats.pending} share={pct(stats.pending, stats.total)} />
        <Kpi tone="red" icon={Ban} label="Indisponibles" value={stats.unavailable} share={pct(stats.unavailable, stats.total)} />
      </div>

      <div className="tf-filters">
        <label className="tf-filter">
          <span>Tournée</span>
          <select className="od-select" value={tourFilter} onChange={(e) => setTourFilter(e.target.value)}>
            <option value="">Toutes</option>
            {slots.map((s) => (
              <option key={s.key} value={s.key}>
                {slotLabel(s.slot)} — {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="tf-filter">
          <span>Vendeur</span>
          <select className="od-select" value={vendeurFilter} onChange={(e) => setVendeurFilter(e.target.value)}>
            <option value="">Tous</option>
            {vendeurOptions.map(([key, v]) => (
              <option key={key} value={key}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <label className="tf-filter">
          <span>Fournisseur</span>
          <select className="od-select" value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
            <option value="">Tous</option>
            {supplierOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="tf-search">
          <Search className="h-4 w-4" />
          <input
            className="od-input"
            placeholder="Référence, désignation, commande…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Rechercher une pièce"
          />
        </div>
        {filtering && (
          <button type="button" className="od-btn od-btn--ghost" onClick={clearFilters}>
            <X className="h-4 w-4" />
            Effacer
          </button>
        )}
        <p className="tf-synced">{syncedAt ? `Mis à jour à ${clockText(syncedAt)}` : ""}</p>
      </div>

      <div className="tf-layout">
        <section className="od-card tf-board">
          <div className="tf-board-head">
            <p className="tf-board-title">{fmtBoardDate(date)}</p>
            {upcoming.length > 0 && (
              <div className="tf-upcoming" aria-label="Pièces à récupérer les jours suivants">
                {upcoming.map((u) => (
                  <button key={u.date} type="button" className="tf-upcoming-chip" onClick={() => goDate(u.date)} title={fmtBoardDate(u.date)}>
                    {fmtRelativeDay(u.date, date)} <strong>{u.count}</strong>
                  </button>
                ))}
              </div>
            )}
            <div className="tf-legend">
              {STATES.map((s) => (
                <span key={s} className={`tf-chip tf-chip--${s} tf-legend-item`}>
                  <span className="tf-check" aria-hidden="true">
                    <StateIcon state={s} />
                  </span>
                  {PICKUP_STATE_LABEL[s]}
                </span>
              ))}
            </div>
          </div>

          {board === null ? (
            <p className="tf-empty">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 nc-spin" /> Chargement de la tournée…
                </>
              ) : (
                "Tournée non chargée."
              )}
            </p>
          ) : (
            <div className="tf-scroll">
              <table className="tf-grid">
                <thead>
                  <tr>
                    <th className="tf-th-tour">Tournée</th>
                    <th className="tf-th-vendeur">Vendeur</th>
                    {grid.suppliers.map((s) => (
                      <th key={s.id} className="tf-th-supplier">
                        {s.name}
                      </th>
                    ))}
                    <th className="tf-th-nb">NB</th>
                  </tr>
                </thead>
                {grid.slots.map((slot) => {
                  const rows = slot.rows.length > 0 ? slot.rows : [null];
                  const isSelected = selected?.key === slot.key;
                  return (
                    <tbody key={slot.key} className={`tf-slot${isSelected ? " tf-slot--selected" : ""}`}>
                      {rows.map((row, i) => (
                        <tr key={row?.vendeurKey ?? "empty"}>
                          {i === 0 && (
                            <th
                              rowSpan={rows.length}
                              scope="rowgroup"
                              className="tf-tour"
                              style={{ "--tc": tourColor(slot.index) } as CSSProperties}
                            >
                              <button
                                type="button"
                                className="tf-tour-btn"
                                onClick={() => setSelectedKey(slot.key)}
                                aria-pressed={isSelected}
                              >
                                <span className="tf-tour-time">{slotLabel(slot.slot)}</span>
                                <span className="tf-tour-name">{slot.name}</span>
                                {slot.tour && (
                                  <span className={`tf-tour-status tf-tour-status--${slot.tour.status}`}>
                                    {TOUR_STATUS_LABEL[slot.tour.status]}
                                  </span>
                                )}
                                {slot.tour?.livreurName && (
                                  <span className="tf-tour-livreur">
                                    <Truck />
                                    {slot.tour.livreurName}
                                  </span>
                                )}
                              </button>
                            </th>
                          )}
                          {row ? (
                            <>
                              <td className="tf-vendeur">
                                <span className="tf-dot" style={{ background: colors.get(row.vendeurKey) }} />
                                {row.vendeur}
                              </td>
                              {grid.suppliers.map((s) => (
                                <td key={s.id} className="tf-cell">
                                  {(row.cells.get(s.id) ?? []).map((l) => (
                                    <PartChip
                                      key={l.id}
                                      line={l}
                                      color={colors.get(row.vendeurKey) ?? "#1A1F36"}
                                      saving={savingLines.has(l.id)}
                                      onToggle={(ln, st) => void pickup(ln, st)}
                                      onOpen={(ln) => setOpenLineId(ln.id)}
                                    />
                                  ))}
                                </td>
                              ))}
                              <td className="tf-nb">{row.count}</td>
                            </>
                          ) : (
                            <td colSpan={grid.suppliers.length + 2} className="tf-slot-empty">
                              Aucune pièce à récupérer
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  );
                })}
                <tfoot>
                  <tr>
                    <th colSpan={2}>Total par fournisseur</th>
                    {grid.suppliers.map((s) => (
                      <td key={s.id}>{s.count}</td>
                    ))}
                    <td className="tf-nb tf-nb--total">{grid.total}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {board && grid.total === 0 && (
            <div className="tf-hint">
              {filtering ? (
                "Aucune pièce ne correspond aux filtres."
              ) : upcoming.length > 0 ? (
                <>
                  Aucune pièce fournisseur {dayWord}. Une commande passée après 17 h part sur la Tournée 1 du lendemain, plus
                  tard encore si le fournisseur a un délai :{" "}
                  <strong>
                    {upcoming[0].count} pièce{upcoming[0].count > 1 ? "s" : ""} {fmtRelativeDay(upcoming[0].date, date).toLowerCase()} (
                    {fmtBoardDate(upcoming[0].date)})
                  </strong>
                  .{" "}
                  <button type="button" className="od-btn od-btn--outline tf-hint-btn" onClick={() => goDate(upcoming[0].date)}>
                    <ChevronRight className="h-4 w-4" />
                    Voir {fmtRelativeDay(upcoming[0].date, date).toLowerCase()}
                  </button>
                </>
              ) : (
                `Aucune pièce fournisseur ${dayWord}. Chaque commande passée au comptoir s'ajoute ici, dans la tournée de son créneau (après 17 h : Tournée 1 du lendemain).`
              )}
            </div>
          )}
        </section>

        <aside className="tf-side">
          {selected && (
            <section className="od-card tf-panel" style={{ "--tc": tourColor(selected.index) } as CSSProperties}>
              <div className="tf-panel-head">
                <span className="tf-panel-kicker">{kicker}</span>
                <p className="tf-panel-time">{slotLabel(selected.slot)}</p>
                <p className="tf-panel-name">
                  {selected.name}
                  {tour && <span className="tf-panel-status">{TOUR_STATUS_LABEL[tour.status]}</span>}
                </p>
                <p className="tf-panel-when">
                  <Clock className="h-4 w-4" />
                  {departureText(selected, date, now)}
                </p>
              </div>

              <div className="tf-panel-body">
                {tour ? (
                  <div>
                    <div className="tf-bar">
                      <span style={{ width: `${pct(tourStat.done, tourStat.total)}%` }} />
                    </div>
                    <p className="tf-progress-text">
                      {tourStat.done}/{tourStat.total} récupérée{tourStat.done > 1 ? "s" : ""}
                      {tourStat.unavailable > 0 && ` · ${tourStat.unavailable} indisponible${tourStat.unavailable > 1 ? "s" : ""}`}
                    </p>
                  </div>
                ) : (
                  <p className="tf-panel-empty">
                    Aucune pièce sur cette tournée pour l&apos;instant. Vous pouvez déjà lui affecter un livreur et une consigne.
                  </p>
                )}

                <label className="od-field">
                  <span className="od-label">Livreur</span>
                  <select
                    className="od-select"
                    value={tour?.livreurId ?? ""}
                    disabled={busy === `assign-${selected.key}`}
                    onChange={(e) => assignLivreur(e.target.value)}
                  >
                    <option value="">Tous les livreurs (non assignée)</option>
                    {livreurOptions.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.active ? "" : " (inactif)"}
                      </option>
                    ))}
                  </select>
                  {tour?.livreurId ? (
                    <label className="tf-remember">
                      <input
                        type="checkbox"
                        checked={isDefault}
                        disabled={busy === `remember-${tour.id}`}
                        onChange={(e) => rememberLivreur(e.target.checked)}
                      />
                      <span>Lui confier {tour.name} tous les jours</span>
                    </label>
                  ) : defaultLivreur ? (
                    <span className="tf-remember-hint">
                      Attitré habituel : {defaultLivreur.livreurName}
                      {!tour ? " (appliqué dès la première commande)" : ""}
                    </span>
                  ) : null}
                </label>

                {tourStops.length > 0 && (
                    <ul className="tf-panel-suppliers">
                      {tourStops.map((s) => {
                        const done = s.lines.filter((l) => {
                          const st = pickupState(l);
                          return st === "picked" || st === "received";
                        }).length;
                        return (
                          <li key={s.supplierId}>
                            <span>{s.supplier}</span>
                            <span className={`tf-pill${done === s.lines.length ? " tf-pill--done" : ""}`}>
                              {done}/{s.lines.length}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                {tour && (
                  <div className="tf-panel-actions">
                    {tour.status === "PLANIFIEE" && (
                      <button
                        type="button"
                        className="od-btn od-btn--primary"
                        disabled={busy === `status-${tour.id}`}
                        onClick={() => changeStatus("EN_COURS")}
                      >
                        <Play className="h-4 w-4" />
                        Marquer partie
                      </button>
                    )}
                    {tour.status !== "TERMINEE" && (
                      <button
                        type="button"
                        className="od-btn od-btn--primary tf-btn-finish"
                        disabled={busy === `status-${tour.id}`}
                        onClick={() => changeStatus("TERMINEE")}
                      >
                        <Flag className="h-4 w-4" />
                        Finaliser la tournée
                      </button>
                    )}
                    {tour.status !== "PLANIFIEE" && (
                      <button
                        type="button"
                        className="od-btn od-btn--ghost"
                        disabled={busy === `status-${tour.id}`}
                        onClick={() => changeStatus(tour.status === "TERMINEE" ? "EN_COURS" : "PLANIFIEE")}
                      >
                        <RotateCcw className="h-4 w-4" />
                        {tour.status === "TERMINEE" ? "Rouvrir la tournée" : "Remettre en planifiée"}
                      </button>
                    )}
                  </div>
                )}

                <div className="od-field">
                  <span className="od-label tf-note-label">
                    <StickyNote className="h-4 w-4" />
                    Consigne pour le livreur
                  </span>
                  <textarea
                    className="od-input tf-note"
                    rows={3}
                    value={noteValue}
                    placeholder="BG fermé à 17 h, demander Karim chez AZ…"
                    onChange={(e) => setNoteDraft({ tourId: noteKey, text: e.target.value })}
                  />
                  {noteDirty && (
                    <button
                      type="button"
                      className="od-btn od-btn--outline"
                      disabled={busy === `note-${selected.key}`}
                      onClick={saveNote}
                    >
                      {busy === `note-${selected.key}` ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                      Enregistrer la consigne
                    </button>
                  )}
                </div>
              </div>
            </section>
          )}

          {vendeurOptions.length > 0 && (
            <section className="od-card tf-vendeurs">
              <p className="tf-vendeurs-title">Vendeurs</p>
              <ul>
                {vendeurOptions.map(([key, v]) => (
                  <li key={key}>
                    <button
                      type="button"
                      className={`tf-vendeur-btn${vendeurFilter === key ? " tf-vendeur-btn--on" : ""}`}
                      onClick={() => setVendeurFilter(vendeurFilter === key ? "" : key)}
                    >
                      <span className="tf-dot" style={{ background: colors.get(key) }} />
                      <span className="tf-vendeur-name">{v.name}</span>
                      <span className="tf-pill tf-pill--muted">{v.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>

      {openLine && (
        <div className="ga-modal-overlay" onClick={() => setOpenLineId(null)}>
          <div
            className="ga-modal tf-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tf-line-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ga-modal-head">
              <span className="ga-modal-title" id="tf-line-title">
                <PackageCheck className="h-4 w-4" /> {openLine.reference}
              </span>
              <button type="button" className="ga-modal-close" onClick={() => setOpenLineId(null)} aria-label="Fermer">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ga-modal-form">
              {(() => {
                const state = pickupState(openLine);
                const saving = savingLines.has(openLine.id);
                return (
                  <>
                    <dl className="tf-kv">
                      <div>
                        <dt>Désignation</dt>
                        <dd>{openLine.designation || "—"}</dd>
                      </div>
                      {openLine.referenceCommande && (
                        <div>
                          <dt>Réf. fournisseur</dt>
                          <dd>{openLine.referenceCommande}</dd>
                        </div>
                      )}
                      <div>
                        <dt>Quantité</dt>
                        <dd>{openLine.quantity}</dd>
                      </div>
                      <div>
                        <dt>Fournisseur</dt>
                        <dd>{openLine.supplier}</dd>
                      </div>
                      <div>
                        <dt>Tournée</dt>
                        <dd>{openSlot ? `${openSlot.name} · ${slotLabel(openSlot.slot)}` : "—"}</dd>
                      </div>
                      <div>
                        <dt>Vendeur</dt>
                        <dd>{openLine.vendeur}</dd>
                      </div>
                      <div>
                        <dt>Commande</dt>
                        <dd>
                          <Link href={`/dashboard/commandes/${openLine.orderId}`} className="rc-cmd">
                            {openLine.orderRef} <ExternalLink className="h-3.5 w-3.5 tf-inline-icon" />
                          </Link>
                        </dd>
                      </div>
                      <div>
                        <dt>Client</dt>
                        <dd>{openLine.client ?? "—"}</dd>
                      </div>
                      <div>
                        <dt>État</dt>
                        <dd>
                          <span className={`tf-state tf-state--${state}`}>{PICKUP_STATE_LABEL[state]}</span>
                          {openLine.pickupStatus && openLine.pickupAt && (
                            <span className="tf-state-by">
                              {openLine.pickupBy ? `${openLine.pickupBy} · ` : ""}
                              {fmtHour(openLine.pickupAt)}
                            </span>
                          )}
                        </dd>
                      </div>
                    </dl>
                    {state === "received" ? (
                      <p className="od-hint">Pièce déjà reçue au magasin : rien à récupérer.</p>
                    ) : (
                      <div className="ga-modal-actions tf-modal-actions">
                        {openLine.pickupStatus && (
                          <button type="button" className="od-btn od-btn--ghost" disabled={saving} onClick={() => void pickup(openLine, null)}>
                            <RotateCcw className="h-4 w-4" />
                            Remettre à récupérer
                          </button>
                        )}
                        {openLine.pickupStatus !== "UNAVAILABLE" && (
                          <button type="button" className="od-btn od-btn--danger" disabled={saving} onClick={() => void pickup(openLine, "UNAVAILABLE")}>
                            <Ban className="h-4 w-4" />
                            Indisponible
                          </button>
                        )}
                        {openLine.pickupStatus !== "PICKED_UP" && (
                          <button type="button" className="od-btn od-btn--primary" disabled={saving} onClick={() => void pickup(openLine, "PICKED_UP")}>
                            <Check className="h-4 w-4" />
                            Récupérée
                          </button>
                        )}
                      </div>
                    )}
                    <p className="st-cmd-hint">
                      « Récupérée » = la pièce est dans le camion. Sa réception au magasin se fait toujours dans Suivi des commandes → Pièces à recevoir.
                    </p>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
