"use client";

import { Check, KeyRound, Loader2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useAuth } from "@/components/providers/AuthProvider";

const MIN = 8;

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called once the password is saved, with the message to show. */
  onDone?: (message: string) => void;
};

/**
 * « Mon mot de passe » — the signed-in person (caissier, admin, garagiste or
 * livreur) replaces the password the magasin gave them. The current one is
 * checked first, so an unlocked screen is not enough to take over a login.
 */
export function ChangePasswordDialog({ open, onClose, onDone }: Props) {
  const { user, supabase } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setCurrent("");
    setNext("");
    setConfirm("");
    setShow(false);
    setError(null);
  };
  const close = () => {
    if (saving) return;
    reset();
    onClose();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < MIN) {
      setError(`Le nouveau mot de passe doit contenir au moins ${MIN} caractères.`);
      return;
    }
    if (next !== confirm) {
      setError("Les deux mots de passe ne sont pas identiques.");
      return;
    }
    if (next === current) {
      setError("Choisissez un mot de passe différent de l'actuel.");
      return;
    }
    const email = user?.email;
    if (!email) {
      setError("Session introuvable : reconnectez-vous puis réessayez.");
      return;
    }
    setSaving(true);
    try {
      const check = await supabase.auth.signInWithPassword({ email, password: current });
      if (check.error) {
        setError("Mot de passe actuel incorrect.");
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password: next });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      reset();
      onDone?.("Mot de passe enregistré : utilisez-le dès votre prochaine connexion.");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const type = show ? "text" : "password";
  return (
    <div className="ga-modal-overlay" onClick={close}>
      <div className="ga-modal" role="dialog" aria-modal="true" aria-labelledby="pwd-dialog-title" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title" id="pwd-dialog-title">
            <KeyRound className="h-4 w-4" /> Mon mot de passe
          </span>
          <button type="button" className="ga-modal-close" onClick={close} aria-label="Fermer" disabled={saving}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <form className="ga-modal-form" onSubmit={submit}>
          {error && <div className="nc-error">{error}</div>}
          <label className="od-field">
            <span className="od-label">Mot de passe actuel</span>
            <input
              id="pwd-current"
              className="od-input"
              type={type}
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoFocus
            />
          </label>
          <div className="ga-modal-row">
            <label className="od-field">
              <span className="od-label">Nouveau mot de passe</span>
              <input
                id="pwd-next"
                className="od-input"
                type={type}
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder={`Au moins ${MIN} caractères`}
              />
            </label>
            <label className="od-field">
              <span className="od-label">Confirmer</span>
              <input
                id="pwd-confirm"
                className="od-input"
                type={type}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          </div>
          <label className="admin-toggle">
            <input id="pwd-show" type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span>Afficher les mots de passe</span>
          </label>
          <div className="ga-modal-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={close} disabled={saving}>
              Annuler
            </button>
            <button
              type="submit"
              className="od-btn od-btn--primary"
              disabled={saving || !current || next.length < MIN || !confirm}
            >
              {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
              Enregistrer
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
