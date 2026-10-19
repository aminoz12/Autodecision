"use client";

import { AlertTriangle } from "lucide-react";
import { smsPhoneCheck } from "@/lib/sms";

/**
 * Under a phone input: says at once when no SMS could reach this number
 * (landline, or a number with a digit missing), so the cashier fixes it while
 * the client is still at the counter instead of discovering it at « Tout
 * reçu » (journal 2026-10-19: Twilio 21635 landline / 21211 invalid).
 * Silent while the number is empty or still being typed (< 8 digits), and
 * never blocks: a landline is a fine number to call.
 */
export function PhoneHint({ value }: { value: string | null | undefined }) {
  const digits = (value ?? "").replace(/\D/g, "").length;
  if (digits < 8) return null;
  const check = smsPhoneCheck(value);
  if (check.ok) return null;
  return (
    <span className="phone-hint" role="status">
      <AlertTriangle className="h-3.5 w-3.5" />
      {check.reason === "LANDLINE"
        ? "Numéro fixe : ce client ne recevra pas de SMS."
        : "Numéro incomplet (10 chiffres attendus) : pas de SMS possible."}
    </span>
  );
}
