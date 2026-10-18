"use client";

import { CalendarDays, Loader2, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cancelLeave, loadMyLeaveSpace, requestLeave, type LeaveRequest, type LeaveSpace } from "@/lib/data/espace";
import {
  LEAVE_TYPES,
  fmtLeavePeriod,
  leavePreview,
  leaveStatusLabel,
  leaveTypeLabel,
  plural,
  ymd,
  type LeaveType,
} from "@/lib/conges";

const SHOWN_BY_DEFAULT = 5;

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function fmtDays(n: number): string {
  return plural(n, "jour");
}

/** « Congé payé · 10 jours · validé le 2 sept. » */
function requestSub(r: LeaveRequest, today: string): string {
  const parts = [leaveTypeLabel(r.type), fmtDays(r.days)];
  switch (r.status) {
    case "APPROVED":
      parts.push(r.dateTo < today ? "pris" : r.decidedAt ? `validé le ${fmtDate(r.decidedAt)}` : "validé");
      break;
    case "REFUSED":
      parts.push(r.decidedAt ? `refusé le ${fmtDate(r.decidedAt)}` : "refusé");
      break;
    case "CANCELLED":
      parts.push("annulée");
      break;
    default:
      parts.push(`envoyée le ${fmtDate(r.createdAt)}`);
  }
  return parts.join(" · ");
}

/**
 * Congés d'un membre de l'équipe (caissier ou livreur) : solde de l'année,
 * formulaire de demande avec le décompte en jours ouvrés, et l'historique
 * des demandes avec la réponse du responsable. Même composant dans le
 * tableau de bord du comptoir et dans l'espace livreur sur téléphone.
 */
export function LeaveSection({ onNotice }: { onNotice?: (message: string) => void }) {
  const supabase = useMemo(() => createClient(), []);
  const today = useMemo(() => ymd(new Date()), []);
  const [space, setSpace] = useState<LeaveSpace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<LeaveType>("CONGE_PAYE");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSpace(await loadMyLeaveSpace(supabase));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    void load();
  }, [load]);

  const balance = space?.balance ?? null;
  const preview = useMemo(
    () => leavePreview(type, from, to, balance ? balance.remaining : null),
    [type, from, to, balance],
  );
  const canSubmit = !!from && !!to && to >= from && preview.tone !== "warn" && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setFormError(null);
    try {
      await requestLeave(supabase, { type, from, to, comment });
      setFrom("");
      setTo("");
      setComment("");
      onNotice?.("Demande envoyée. Votre responsable est prévenu et vous serez averti dès qu'il répond.");
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(r: LeaveRequest) {
    const label = r.status === "APPROVED" ? "Annuler ce congé déjà validé ?" : "Retirer cette demande ?";
    if (!window.confirm(label)) return;
    setCancelling(r.id);
    try {
      await cancelLeave(supabase, r.id);
      onNotice?.(r.status === "APPROVED" ? "Congé annulé. Votre responsable est prévenu." : "Demande retirée.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(null);
    }
  }

  function canCancel(r: LeaveRequest): boolean {
    return r.status === "PENDING" || (r.status === "APPROVED" && r.dateFrom > today);
  }

  const requests = space?.requests ?? [];
  const shown = showAll ? requests : requests.slice(0, SHOWN_BY_DEFAULT);

  return (
    <div className="me-grid me-leave">
      <section className="me-card" aria-labelledby="me-leave-form-title">
        <div className="me-card-head">
          <h2 id="me-leave-form-title" className="me-card-title">
            <CalendarDays /> Demander un congé
          </h2>
          {balance && <span className="me-hint">Congés payés {balance.year}</span>}
        </div>

        {error && <div className="nc-error">{error}</div>}

        <div className="me-balance" aria-label="Solde de congés payés">
          <div className="me-balance-tile">
            <div className="me-balance-label">Droits</div>
            <div className="me-balance-value">{balance ? `${balance.allowance} j` : "—"}</div>
          </div>
          <div className="me-balance-tile">
            <div className="me-balance-label">Pris</div>
            <div className="me-balance-value">{balance ? `${balance.taken} j` : "—"}</div>
          </div>
          <div className="me-balance-tile">
            <div className="me-balance-label">Posés</div>
            <div className="me-balance-value">{balance ? `${balance.planned} j` : "—"}</div>
            {balance && balance.pending > 0 && <div className="me-balance-sub">+ {balance.pending} j en attente</div>}
          </div>
          <div className="me-balance-tile me-balance-tile--accent">
            <div className="me-balance-label">Reste</div>
            <div className="me-balance-value">{balance ? `${balance.remaining} j` : "—"}</div>
          </div>
        </div>

        <form className="me-form" onSubmit={(e) => void submit(e)}>
          <div className="me-field">
            <label htmlFor="me-leave-type" className="od-label">Type d&apos;absence</label>
            <select
              id="me-leave-type"
              className="od-select-native"
              value={type}
              onChange={(e) => setType(e.target.value as LeaveType)}
              disabled={busy}
            >
              {LEAVE_TYPES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="me-form-row">
            <div className="me-field">
              <label htmlFor="me-leave-from" className="od-label">Du</label>
              <input
                id="me-leave-from"
                type="date"
                className="od-input"
                value={from}
                max={to || undefined}
                onChange={(e) => {
                  setFrom(e.target.value);
                  if (!to || e.target.value > to) setTo(e.target.value);
                }}
                disabled={busy}
                required
              />
            </div>
            <div className="me-field">
              <label htmlFor="me-leave-to" className="od-label">Au</label>
              <input
                id="me-leave-to"
                type="date"
                className="od-input"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.target.value)}
                disabled={busy}
                required
              />
            </div>
          </div>
          <div className={`me-note me-note--${preview.tone}`} aria-live="polite">{preview.text}</div>
          <div className="me-field">
            <label htmlFor="me-leave-comment" className="od-label">Commentaire (facultatif)</label>
            <textarea
              id="me-leave-comment"
              className="me-textarea"
              rows={3}
              placeholder="Un mot pour votre responsable"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              disabled={busy}
              maxLength={500}
            />
          </div>
          {formError && <div className="nc-error">{formError}</div>}
          <button type="submit" className="od-btn od-btn--primary" disabled={!canSubmit}>
            {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Send className="h-4 w-4" />}
            Envoyer la demande
          </button>
          <p className="me-hint">Votre responsable reçoit la demande. Vous êtes prévenu dès qu&apos;il répond.</p>
        </form>
      </section>

      <section className="me-card" aria-labelledby="me-leave-list-title">
        <div className="me-card-head">
          <h2 id="me-leave-list-title" className="me-card-title">Mes demandes</h2>
          {requests.length > SHOWN_BY_DEFAULT && (
            <button type="button" className="od-btn od-btn--ghost" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Réduire" : `Tout voir (${requests.length})`}
            </button>
          )}
        </div>

        {loading && !space ? (
          <p className="me-empty"><Loader2 className="h-4 w-4 nc-spin" /> Chargement…</p>
        ) : requests.length === 0 ? (
          <p className="me-empty">Aucune demande pour l&apos;instant.</p>
        ) : (
          <div className="me-list">
            {shown.map((r) => {
              const st = leaveStatusLabel(r.status);
              return (
                <div key={r.id} className="me-row">
                  <div className="me-row-main">
                    <div className="me-row-title">{fmtLeavePeriod(r.dateFrom, r.dateTo)}</div>
                    <div className="me-row-sub">{requestSub(r, today)}</div>
                    {r.comment && r.status === "PENDING" && <div className="me-row-reply">« {r.comment} »</div>}
                    {r.decisionNote && (
                      <div className="me-row-reply">
                        Réponse{r.decidedBy ? ` de ${r.decidedBy}` : ""} : « {r.decisionNote} »
                      </div>
                    )}
                  </div>
                  <div className="me-row-actions">
                    <span className={`rt-badge rt-badge--${st.cls}`}>{st.label}</span>
                    {canCancel(r) && (
                      <button
                        type="button"
                        className="od-btn od-btn--ghost"
                        onClick={() => void cancel(r)}
                        disabled={cancelling === r.id}
                        title={r.status === "APPROVED" ? "Annuler ce congé" : "Retirer la demande"}
                      >
                        {cancelling === r.id ? <Loader2 className="h-4 w-4 nc-spin" /> : <X className="h-4 w-4" />}
                        Annuler
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
