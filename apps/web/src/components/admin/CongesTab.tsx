"use client";

import { AlertTriangle, CalendarCheck, CalendarDays, CalendarPlus, Check, Hourglass, Loader2, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminAddAbsence,
  decideLeave,
  loadAdminLeaveBoard,
  setLeaveAllowance,
  type Absence,
  type AdminLeaveBoard,
  type PendingLeave,
} from "@/lib/data/espace";
import { LEAVE_TYPES, fmtLeavePeriod, leavePreview, leaveStatusLabel, leaveTypeLabel, plural, type LeaveType } from "@/lib/conges";
import { createClient } from "@/lib/supabase/client";

const ROLE_LABEL: Record<string, string> = { ADMIN: "Administrateur", CAISSIER: "Caissier", LIVREUR: "Livreur" };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function fmtDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
}

/**
 * Onglet « Congés » de l'administration : demandes à valider (avec les
 * chevauchements dans l'équipe), soldes de congés payés modifiables,
 * absences à venir et saisie directe d'une absence.
 */
export function CongesTab({ onPendingCount }: { onPendingCount?: (n: number) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const [board, setBoard] = useState<AdminLeaveBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusing, setRefusing] = useState<{ id: string; note: string } | null>(null);
  const [allowances, setAllowances] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [add, setAdd] = useState<{ userId: string; type: LeaveType; from: string; to: string; note: string }>({
    userId: "",
    type: "CONGE_PAYE",
    from: "",
    to: "",
    note: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const b = await loadAdminLeaveBoard(supabase);
      setBoard(b);
      setAllowances({});
      onPendingCount?.(b.pending.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase, onPendingCount]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = board?.today ?? "";
  const absentToday = useMemo(
    () => (board?.absences ?? []).filter((a) => a.status === "APPROVED" && a.dateFrom <= today && a.dateTo >= today),
    [board, today],
  );
  const upcoming = useMemo(
    () => (board?.absences ?? []).filter((a) => a.dateTo >= today).sort((a, b) => a.dateFrom.localeCompare(b.dateFrom)),
    [board, today],
  );
  const nextAbsence = useMemo(() => upcoming.find((a) => a.status === "APPROVED" && a.dateFrom > today) ?? null, [upcoming, today]);
  const thisMonth = useMemo(() => {
    const key = today.slice(0, 7);
    const rows = (board?.absences ?? []).filter((a) => monthKey(a.dateFrom) === key);
    return {
      approved: rows.filter((a) => a.status === "APPROVED").reduce((s, a) => s + a.days, 0),
      pending: rows.filter((a) => a.status === "PENDING").reduce((s, a) => s + a.days, 0),
    };
  }, [board, today]);
  const oldestPending = board?.pending[0] ?? null;

  async function decide(r: PendingLeave, approve: boolean, note?: string) {
    setBusy(r.id);
    setError(null);
    try {
      await decideLeave(supabase, r.id, approve, note);
      setNotice(approve ? `Congé de ${r.name} validé. ${r.name} est prévenu.` : `Demande de ${r.name} refusée. ${r.name} est prévenu.`);
      setRefusing(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function saveAllowance(userId: string) {
    const raw = allowances[userId];
    if (raw === undefined || !board) return;
    const days = Number(raw.replace(",", "."));
    if (!Number.isFinite(days) || days < 0 || days > 99) {
      setError("Nombre de jours invalide (0 à 99).");
      return;
    }
    setBusy(`allow:${userId}`);
    setError(null);
    try {
      await setLeaveAllowance(supabase, userId, board.year, days);
      setNotice("Droits à congés mis à jour.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const addPreview = useMemo(() => leavePreview(add.type, add.from, add.to, null), [add.type, add.from, add.to]);
  const canAdd = !!add.userId && !!add.from && !!add.to && add.to >= add.from && addPreview.tone !== "warn" && busy === null;

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    setBusy("add");
    setError(null);
    try {
      await adminAddAbsence(supabase, { userId: add.userId, type: add.type, from: add.from, to: add.to, note: add.note });
      setNotice("Absence enregistrée. La personne est prévenue.");
      setAdd({ userId: "", type: "CONGE_PAYE", from: "", to: "", note: "" });
      setAdding(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const upcomingByMonth = useMemo(() => {
    const groups = new Map<string, Absence[]>();
    for (const a of upcoming) {
      const k = monthKey(a.dateFrom < today ? today : a.dateFrom);
      const list = groups.get(k) ?? [];
      list.push(a);
      groups.set(k, list);
    }
    return [...groups.entries()];
  }, [upcoming, today]);

  if (loading && !board) {
    return <p className="me-empty"><Loader2 className="h-4 w-4 nc-spin" /> Chargement des congés…</p>;
  }

  return (
    <div className="me-stack me-admin">
      {error && <div className="nc-error">{error}</div>}
      {notice && (
        <div className="me-note me-note--info me-notice" role="status">
          {notice}
          <button type="button" className="me-notice-close" aria-label="Fermer" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      <section aria-label="Résumé des congés" className="me-kpis">
        <div className="me-kpi">
          <span className="me-kpi-icon"><Hourglass /></span>
          <span className="me-kpi-label">Demandes à valider</span>
          <span className="me-kpi-value">{board?.pending.length ?? 0}</span>
          <span className="me-kpi-sub">{oldestPending ? `La plus ancienne : ${fmtDate(oldestPending.createdAt)}` : "Rien en attente"}</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><UserRound /></span>
          <span className="me-kpi-label">Absents aujourd&apos;hui</span>
          <span className="me-kpi-value">{absentToday.length}</span>
          <span className="me-kpi-sub">{absentToday.length > 0 ? absentToday.map((a) => a.name).join(", ") : "Équipe au complet"}</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><CalendarCheck /></span>
          <span className="me-kpi-label">Prochaine absence</span>
          <span className="me-kpi-value">{nextAbsence ? fmtDate(nextAbsence.dateFrom) : "—"}</span>
          <span className="me-kpi-sub">{nextAbsence ? `${nextAbsence.name} · ${plural(nextAbsence.days, "jour")}` : "Aucune absence validée à venir"}</span>
        </div>
        <div className="me-kpi">
          <span className="me-kpi-icon"><CalendarDays /></span>
          <span className="me-kpi-label">Jours posés ce mois</span>
          <span className="me-kpi-value">{thisMonth.approved}</span>
          <span className="me-kpi-sub">{thisMonth.pending > 0 ? `+ ${thisMonth.pending} en attente` : "Absences validées démarrant ce mois"}</span>
        </div>
      </section>

      <div className="me-grid">
        <section className="me-card" aria-labelledby="me-pending-title">
          <div className="me-card-head">
            <h2 id="me-pending-title" className="me-card-title"><Hourglass /> Demandes à valider</h2>
            <span className="me-hint">{board?.pending.length ?? 0} en attente</span>
          </div>
          {!board || board.pending.length === 0 ? (
            <p className="me-empty">Aucune demande en attente.</p>
          ) : (
            <div className="me-pending">
              {board.pending.map((r) => {
                const isBusy = busy === r.id;
                const refuse = refusing?.id === r.id;
                return (
                  <article key={r.id} className="me-req">
                    <div className="me-req-head">
                      <span className="me-avatar">{initials(r.name)}</span>
                      <div className="me-row-main">
                        <div className="me-req-name">{r.name}</div>
                        <div className="me-req-meta">{ROLE_LABEL[r.role] ?? r.role} · demandé le {fmtDate(r.createdAt)}</div>
                      </div>
                      <span className="rt-badge rt-badge--amber">En attente</span>
                    </div>
                    <div className="me-req-facts">
                      <div>Type · <strong>{leaveTypeLabel(r.type)}</strong></div>
                      <div>Dates · <strong>{fmtLeavePeriod(r.dateFrom, r.dateTo)}</strong></div>
                      <div>Durée · <strong>{plural(r.days, "jour")}</strong></div>
                      {r.remaining !== null && (
                        <div>Reste après · <strong className={r.remaining < 0 ? "me-neg" : ""}>{plural(r.remaining, "jour")}</strong></div>
                      )}
                    </div>
                    {r.comment && <div className="me-req-quote">« {r.comment} »</div>}
                    {r.overlaps.length > 0 ? (
                      <div className="me-note me-note--warn">
                        <AlertTriangle className="h-4 w-4" />
                        <span>
                          Chevauche {r.overlaps.map((o) => `${o.name} (${fmtLeavePeriod(o.dateFrom, o.dateTo)}${o.status === "PENDING" ? ", en attente" : ""})`).join(", ")}.
                        </span>
                      </div>
                    ) : (
                      <div className="me-note me-note--muted">Aucun chevauchement avec une autre absence.</div>
                    )}
                    {refuse ? (
                      <div className="me-req-refuse">
                        <label htmlFor={`refuse-${r.id}`} className="od-label">Motif du refus (facultatif, transmis à {r.name})</label>
                        <textarea
                          id={`refuse-${r.id}`}
                          className="me-textarea"
                          rows={2}
                          value={refusing.note}
                          onChange={(e) => setRefusing({ id: r.id, note: e.target.value })}
                          placeholder="Ex. : effectif insuffisant ce jour-là"
                          maxLength={500}
                        />
                        <div className="me-req-actions">
                          <button type="button" className="od-btn od-btn--ghost" onClick={() => setRefusing(null)} disabled={isBusy}>Retour</button>
                          <button type="button" className="od-btn od-btn--danger" onClick={() => void decide(r, false, refusing.note)} disabled={isBusy}>
                            {isBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <X className="h-4 w-4" />}
                            Confirmer le refus
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="me-req-actions">
                        <button type="button" className="od-btn od-btn--ghost" onClick={() => setRefusing({ id: r.id, note: "" })} disabled={isBusy}>
                          <X className="h-4 w-4" /> Refuser
                        </button>
                        <button type="button" className="od-btn od-btn--primary" onClick={() => void decide(r, true)} disabled={isBusy}>
                          {isBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                          Valider
                        </button>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="me-card" aria-labelledby="me-balances-title">
          <div className="me-card-head">
            <h2 id="me-balances-title" className="me-card-title"><CalendarCheck /> Soldes de congés payés {board?.year}</h2>
          </div>
          {!board || board.balances.length === 0 ? (
            <p className="me-empty">Aucun membre dans l&apos;équipe.</p>
          ) : (
            <div className="me-table-wrap">
              <table className="me-table">
                <thead>
                  <tr>
                    <th>Membre</th>
                    <th>Droits</th>
                    <th>Pris</th>
                    <th>Posés</th>
                    <th>Attente</th>
                    <th>Reste</th>
                  </tr>
                </thead>
                <tbody>
                  {board.balances.map((b) => {
                    const edited = allowances[b.userId];
                    const dirty = edited !== undefined && Number(edited.replace(",", ".")) !== b.balance.allowance;
                    return (
                      <tr key={b.userId}>
                        <td>
                          <div className="me-req-name">{b.name}</div>
                          <div className="me-req-meta">{ROLE_LABEL[b.role] ?? b.role}</div>
                        </td>
                        <td>
                          <span className="me-allow">
                            <input
                              type="number"
                              min={0}
                              max={99}
                              step={0.5}
                              value={edited ?? String(b.balance.allowance)}
                              onChange={(e) => setAllowances((prev) => ({ ...prev, [b.userId]: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveAllowance(b.userId);
                              }}
                              aria-label={`Droits à congés de ${b.name}`}
                              disabled={busy === `allow:${b.userId}`}
                            />
                            {dirty && (
                              <button type="button" className="od-btn od-btn--primary" onClick={() => void saveAllowance(b.userId)} disabled={busy === `allow:${b.userId}`} title="Enregistrer">
                                {busy === `allow:${b.userId}` ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                              </button>
                            )}
                          </span>
                        </td>
                        <td>{b.balance.taken}</td>
                        <td>{b.balance.planned}</td>
                        <td>{b.balance.pending}</td>
                        <td><strong className={b.balance.remaining < 0 ? "me-neg" : ""}>{b.balance.remaining}</strong></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="me-hint">En jours ouvrés. Le reste tient compte des demandes en attente. Modifiez les droits puis validez avec ✓.</p>
        </section>
      </div>

      <section className="me-card" aria-labelledby="me-upcoming-title">
        <div className="me-card-head">
          <h2 id="me-upcoming-title" className="me-card-title"><CalendarDays /> Absences à venir</h2>
          <button type="button" className="od-btn od-btn--ghost" onClick={() => setAdding((v) => !v)}>
            <CalendarPlus className="h-4 w-4" /> {adding ? "Fermer" : "Saisir une absence"}
          </button>
        </div>

        {adding && (
          <form className="me-form me-add" onSubmit={(e) => void submitAdd(e)}>
            <div className="me-form-row me-form-row--3">
              <div className="me-field">
                <label htmlFor="me-add-user" className="od-label">Membre</label>
                <select id="me-add-user" className="od-select-native" value={add.userId} onChange={(e) => setAdd({ ...add, userId: e.target.value })} required>
                  <option value="">Choisir…</option>
                  {(board?.balances ?? []).map((b) => (
                    <option key={b.userId} value={b.userId}>{b.name} · {ROLE_LABEL[b.role] ?? b.role}</option>
                  ))}
                </select>
              </div>
              <div className="me-field">
                <label htmlFor="me-add-type" className="od-label">Type</label>
                <select id="me-add-type" className="od-select-native" value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value as LeaveType })}>
                  {LEAVE_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="me-field">
                <label htmlFor="me-add-note" className="od-label">Note (facultatif)</label>
                <input id="me-add-note" className="od-input" value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} maxLength={500} placeholder="Ex. : arrêt reçu le 3" />
              </div>
            </div>
            <div className="me-form-row">
              <div className="me-field">
                <label htmlFor="me-add-from" className="od-label">Du</label>
                <input
                  id="me-add-from"
                  type="date"
                  className="od-input"
                  value={add.from}
                  onChange={(e) => setAdd({ ...add, from: e.target.value, to: !add.to || e.target.value > add.to ? e.target.value : add.to })}
                  required
                />
              </div>
              <div className="me-field">
                <label htmlFor="me-add-to" className="od-label">Au</label>
                <input id="me-add-to" type="date" className="od-input" value={add.to} min={add.from || undefined} onChange={(e) => setAdd({ ...add, to: e.target.value })} required />
              </div>
            </div>
            <div className={`me-note me-note--${addPreview.tone}`}>
              {addPreview.text.replace("votre absence", "l'absence")} L&apos;absence est validée d&apos;office et la personne est prévenue.
            </div>
            <div className="me-req-actions">
              <button type="submit" className="od-btn od-btn--primary" disabled={!canAdd}>
                {busy === "add" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                Enregistrer l&apos;absence
              </button>
            </div>
          </form>
        )}

        {upcoming.length === 0 ? (
          <p className="me-empty">Aucune absence en cours ni à venir.</p>
        ) : (
          <div className="me-list">
            {upcomingByMonth.map(([key, rows]) => (
              <div key={key}>
                <p className="me-month">{monthLabel(key)}</p>
                {rows.map((a) => {
                  const st = leaveStatusLabel(a.status);
                  const current = a.dateFrom <= today && a.dateTo >= today;
                  return (
                    <div key={a.id} className="me-row">
                      <span className="me-avatar me-avatar--sm">{initials(a.name)}</span>
                      <div className="me-row-main">
                        <div className="me-row-title">{a.name} · {fmtLeavePeriod(a.dateFrom, a.dateTo)}</div>
                        <div className="me-row-sub">{leaveTypeLabel(a.type)} · {plural(a.days, "jour")}{current ? " · en cours" : ""}</div>
                      </div>
                      <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
