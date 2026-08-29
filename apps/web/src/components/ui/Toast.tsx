"use client";

import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useEffect } from "react";

type Tone = "success" | "error" | "info";

/**
 * Bottom-right toast (Stripe style). Auto-dismisses after `duration` ms;
 * pass `onClose` to clear the message in the parent state.
 */
export function Toast({
  message,
  tone = "success",
  onClose,
  duration = 5000,
}: {
  message: string | null;
  tone?: Tone;
  onClose: () => void;
  duration?: number;
}) {
  useEffect(() => {
    if (!message || duration <= 0) return;
    const id = window.setTimeout(onClose, duration);
    return () => window.clearTimeout(id);
  }, [message, duration, onClose]);

  if (!message) return null;
  const Icon = tone === "error" ? AlertTriangle : tone === "info" ? Info : CheckCircle2;
  return (
    <div className={`ui-toast ui-toast--${tone}`} role="status" aria-live="polite">
      <Icon className="h-4 w-4 ui-toast-icon" />
      <span className="ui-toast-text">{message}</span>
      <button type="button" className="ui-toast-close" onClick={onClose} aria-label="Fermer">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
