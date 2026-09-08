"use client";

import { CreditCard, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * Starts a Stripe Checkout (or opens the portal when already subscribed).
 * When online payment is not configured the API answers 503: the button
 * then shows the fallback message instead of failing silently.
 */
export function SubscribeButton({
  interval = "monthly",
  label = "S'abonner",
  className = "od-btn od-btn--primary",
  portal = false,
}: {
  interval?: "monthly" | "yearly";
  label?: string;
  className?: string;
  /** Open the customer portal (invoices, card, cancellation) instead of a checkout. */
  portal?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(portal ? "/api/billing/portal" : "/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (res.status === 503) {
        setMessage("Le paiement en ligne n'est pas encore activé : contactez-nous pour souscrire.");
        return;
      }
      if (res.status === 401) {
        window.location.href = "/caissier/login";
        return;
      }
      if (!res.ok || !body.url) {
        setMessage(body.error ?? "Impossible d'ouvrir le paiement.");
        return;
      }
      window.location.href = body.url;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="sb-wrap">
      <button type="button" className={className} onClick={() => void go()} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <CreditCard className="h-4 w-4" />}
        {label}
      </button>
      {message && <span className="sb-message">{message}</span>}
    </span>
  );
}
