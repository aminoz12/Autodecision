"use client";

import { Clock3, Copy, Loader2, Plus, Save, Trash2, Truck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  DEFAULT_TOUR_SCHEDULE,
  loadTourSchedule,
  saveTourSchedule,
  STANDARD_TOURS,
  WEEKDAY_LABELS,
  type TourSchedule,
  type TourScheduleSlot,
} from "@/lib/data/tournees";

/**
 * Paramètres → Tournées : the magasin sets, day by day, which tournées leave
 * and when. A day without a tournée is closed: nothing is scheduled on it, an
 * order placed after the last « commandes jusqu'à » goes to the next open day.
 */

/** A row being edited: a key for React, and times as typed. */
type Row = TourScheduleSlot & { key: string };

let seq = 0;
const withKey = (s: TourScheduleSlot): Row => ({ ...s, key: `r${++seq}` });

/** The default cutoff: half an hour before departure. */
function cutoffFor(slot: string): string {
  const [h, m] = slot.split(":").map(Number);
  const total = Math.max(0, h * 60 + m - 30);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export function TourScheduleCard({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const week = await loadTourSchedule(createClient());
      setRows(week.map(withKey));
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows(DEFAULT_TOUR_SCHEDULE.map(withKey));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(() => {
    const map = new Map<number, Row[]>();
    for (let d = 1; d <= 7; d++) map.set(d, []);
    for (const r of rows) map.get(r.weekday)?.push(r);
    for (const list of map.values()) list.sort((a, b) => a.slot.localeCompare(b.slot));
    return map;
  }, [rows]);

  const update = (key: string, patch: Partial<TourScheduleSlot>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const remove = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    setDirty(true);
  };
  const add = (weekday: number) => {
    const existing = byDay.get(weekday) ?? [];
    // The next standard tournée not used on that day, else a blank one.
    const next = STANDARD_TOURS.find((t) => !existing.some((r) => r.name === t.name || r.slot === t.slot));
    const slot = next?.slot ?? "18:00";
    setRows((prev) => [...prev, withKey({ weekday, name: next?.name ?? `Tournée ${existing.length + 1}`, slot, cutoff: cutoffFor(slot) })]);
    setDirty(true);
  };
  const copyMonday = (weekday: number) => {
    const monday = byDay.get(1) ?? [];
    setRows((prev) => [...prev.filter((r) => r.weekday !== weekday), ...monday.map((r) => withKey({ ...r, weekday }))]);
    setDirty(true);
  };

  const problems = useMemo(() => {
    const out: string[] = [];
    if (rows.length === 0) out.push("Programmez au moins une tournée dans la semaine.");
    for (const [d, list] of byDay) {
      const slots = new Set<string>();
      const names = new Set<string>();
      for (const r of list) {
        if (!r.name.trim()) out.push(`${WEEKDAY_LABELS[d]} : une tournée sans nom.`);
        if (!/^\d{2}:\d{2}$/.test(r.slot) || !/^\d{2}:\d{2}$/.test(r.cutoff)) out.push(`${WEEKDAY_LABELS[d]} : heure manquante.`);
        else if (r.cutoff > r.slot) out.push(`${WEEKDAY_LABELS[d]} · ${r.name} : les commandes doivent fermer avant le départ.`);
        if (slots.has(r.slot)) out.push(`${WEEKDAY_LABELS[d]} : deux tournées partent à ${r.slot.replace(":", "h")}.`);
        if (names.has(r.name.trim())) out.push(`${WEEKDAY_LABELS[d]} : deux tournées s'appellent « ${r.name} ».`);
        slots.add(r.slot);
        names.add(r.name.trim());
      }
    }
    return [...new Set(out)];
  }, [rows, byDay]);

  const save = async () => {
    if (problems.length > 0) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const week: TourSchedule = rows.map(({ weekday, name, slot, cutoff }) => ({ weekday, name: name.trim(), slot, cutoff }));
      const saved = await saveTourSchedule(createClient(), week);
      setRows(saved.map(withKey));
      setDirty(false);
      setMessage("Horaires des tournées enregistrés. Les commandes à venir suivent ces horaires ; les tournées déjà planifiées ne bougent pas.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="od-card st-rajout" id="tournees">
      <header className="st-rajout-head">
        <h2 className="st-rajout-title"><Truck className="h-4 w-4" /> Tournées</h2>
      </header>
      <p className="st-cmd-hint" style={{ marginBottom: 12 }}>
        Jour par jour, les tournées du livreur et leur heure de départ. « Commandes jusqu&apos;à » est l&apos;heure limite pour qu&apos;une
        commande parte sur cette tournée ; après, elle passe à la suivante, ou à la première tournée du prochain jour ouvert.
        Un jour sans tournée est fermé.
      </p>
      {error && <div className="nc-error">{error}</div>}
      {message && <p className="stat-change" style={{ color: "var(--clr-success)", marginBottom: 10 }}>{message}</p>}
      {loading ? (
        <p className="rl-muted"><Loader2 className="h-4 w-4 nc-spin" /> Chargement…</p>
      ) : (
        <div className="ts-week">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => {
            const list = byDay.get(d) ?? [];
            const closed = list.length === 0;
            return (
              <div key={d} className={`ts-day${closed ? " ts-day--closed" : ""}`}>
                <div className="ts-day-head">
                  <strong>{WEEKDAY_LABELS[d]}</strong>
                  <span className={`rt-badge rt-badge--${closed ? "red" : "green"}`}>{closed ? "Fermé" : `${list.length} tournée${list.length > 1 ? "s" : ""}`}</span>
                  {isAdmin && (
                    <span className="ts-day-acts">
                      {d !== 1 && (byDay.get(1)?.length ?? 0) > 0 && (
                        <button type="button" className="rc-act rc-act--quiet" onClick={() => copyMonday(d)} title="Reprendre les horaires du lundi">
                          <Copy className="h-3.5 w-3.5" /> Comme lundi
                        </button>
                      )}
                      <button type="button" className="rc-act rc-act--quiet" onClick={() => add(d)}>
                        <Plus className="h-3.5 w-3.5" /> {closed ? "Ouvrir ce jour" : "Ajouter une tournée"}
                      </button>
                    </span>
                  )}
                </div>
                {list.length > 0 && (
                  <div className="ts-rows">
                    <div className="ts-row ts-row--head">
                      <span>Nom</span>
                      <span>Départ</span>
                      <span>Commandes jusqu&apos;à</span>
                      <span />
                    </div>
                    {list.map((r) => (
                      <div key={r.key} className="ts-row">
                        <input className="od-input" value={r.name} disabled={!isAdmin} onChange={(e) => update(r.key, { name: e.target.value })} placeholder="Tournée 1" />
                        <input
                          className="od-input"
                          type="time"
                          step={300}
                          value={r.slot}
                          disabled={!isAdmin}
                          onChange={(e) => {
                            const slot = e.target.value;
                            // The cutoff follows the departure while it keeps the default half-hour gap.
                            update(r.key, { slot, ...(r.cutoff === cutoffFor(r.slot) && slot ? { cutoff: cutoffFor(slot) } : {}) });
                          }}
                        />
                        <input className="od-input" type="time" step={300} value={r.cutoff} disabled={!isAdmin} onChange={(e) => update(r.key, { cutoff: e.target.value })} />
                        {isAdmin ? (
                          <button type="button" className="od-icon-btn" aria-label="Retirer cette tournée" onClick={() => remove(r.key)}>
                            <Trash2 className="h-4 w-4" />
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {problems.length > 0 && !loading && (
        <ul className="ts-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {isAdmin && !loading && (
        <div className="st-rajout-submit">
          <span className="st-cmd-hint" style={{ marginRight: "auto" }}>
            <Clock3 className="h-3.5 w-3.5" /> Heure de Paris. Un changement vaut pour les commandes passées après l&apos;enregistrement.
          </span>
          <button type="button" className="od-btn od-btn--primary" disabled={saving || !dirty || problems.length > 0} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Enregistrement…" : "Enregistrer les horaires"}
          </button>
        </div>
      )}
    </section>
  );
}
