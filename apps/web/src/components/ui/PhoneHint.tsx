"use client";

import { AlertTriangle } from "lucide-react";
import { phoneEntryError } from "@/lib/sms";

/**
 * Under a phone input: says at once when no SMS could reach this number
 * (landline, or a number with a digit missing), so the cashier fixes it while
 * the client is still at the counter instead of discovering it at « Tout
 * reçu » (journal 2026-10-19: Twilio 21635 landline / 21211 invalid).
 * Silent while the number is empty or still being typed (< 8 digits). The
 * words are those of the rule the form enforces on save (phoneEntryError), so
 * the cashier is never surprised by the error; `mobile={false}` for a
 * garage / client PRO, whose landline is accepted.
 */
export function PhoneHint({ value, mobile = true }: { value: string | null | undefined; mobile?: boolean }) {
  const digits = (value ?? "").replace(/\D/g, "").length;
  if (digits < 8) return null;
  const problem = phoneEntryError(value, { mobile });
  if (!problem) return null;
  return (
    <span className="phone-hint" role="status">
      <AlertTriangle className="h-3.5 w-3.5" />
      {problem}
    </span>
  );
}
