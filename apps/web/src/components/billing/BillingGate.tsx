"use client";

import { AlertTriangle, Clock, Lock } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import {
  computeBillingState,
  loadBilling,
  type BillingState,
} from "@/lib/data/billing";

/** Routes that stay reachable even when the trial has expired. */
const ALLOWED_WHEN_LOCKED = ["/dashboard/parametres"];

export function BillingGate({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  const pathname = usePathname();
  const [billing, setBilling] = useState<BillingState | null>(null);

  useEffect(() => {
    const orgId = profile?.organization_id;
    if (!orgId) return;
    let cancelled = false;
    const sb = createClient();
    loadBilling(sb, orgId)
      .then((row) => {
        if (!cancelled) setBilling(computeBillingState(row));
      })
      .catch(() => {
        // Billing read failures must never block the app.
        if (!cancelled) setBilling(null);
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.organization_id]);

  const locked =
    billing?.locked && !ALLOWED_WHEN_LOCKED.some((p) => pathname?.startsWith(p));

  if (locked) {
    return (
      <div className="bill-lock">
        <div className="bill-lock-card">
          <span className="bill-lock-icon">
            <Lock className="h-8 w-8" />
          </span>
          <h1 className="bill-lock-title">Votre essai gratuit est terminé</h1>
          <p className="bill-lock-sub">
            Pour continuer à utiliser {profile?.display_name ? "votre magasin" : "Autodecision"},
            choisissez un abonnement. Vos données sont conservées en sécurité.
          </p>
          <div className="bill-lock-actions">
            <button type="button" className="od-btn od-btn--primary" disabled>
              Choisir un abonnement (bientôt)
            </button>
            <Link href="/dashboard/parametres" className="od-btn od-btn--ghost">
              Paramètres
            </Link>
          </div>
          <p className="bill-lock-foot">
            Besoin d&apos;aide ? Contactez-nous à contact@ematricule.fr
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {billing?.phase === "trialing" && <TrialBanner state={billing} />}
      {children}
    </>
  );
}

function TrialBanner({ state }: { state: BillingState }) {
  const d = state.trialDaysLeft;
  const urgent = d != null && d <= 3;
  return (
    <div className={`bill-banner${urgent ? " bill-banner--urgent" : ""}`}>
      {urgent ? (
        <AlertTriangle className="h-4 w-4" />
      ) : (
        <Clock className="h-4 w-4" />
      )}
      <span className="bill-banner-text">
        {d == null
          ? "Vous êtes en période d'essai gratuit."
          : d === 0
            ? "Dernier jour d'essai gratuit."
            : `Essai gratuit — ${d} jour${d > 1 ? "s" : ""} restant${d > 1 ? "s" : ""}.`}
      </span>
      <button type="button" className="bill-banner-cta" disabled>
        Passer à un abonnement (bientôt)
      </button>
    </div>
  );
}
