"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { reportEvent } from "@/lib/telemetry";

/**
 * Route-level error boundary: a render/runtime error in any page shows this
 * instead of a blank tab. Segment layouts (sidebar, nav) stay mounted.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface it in the console and file it in the journal (/superadmin/journal).
    console.error("[page error]", error);
    reportEvent({ source: "render", message: error.message, stack: error.stack, context: error.digest ? { digest: error.digest } : null });
  }, [error]);

  return (
    <div className="err-page" role="alert">
      <div className="err-card">
        <span className="err-icon"><AlertTriangle className="h-6 w-6" /></span>
        <h1 className="err-title">Une erreur est survenue</h1>
        <p className="err-text">
          La page n&apos;a pas pu s&apos;afficher. Vos données sont intactes : réessayez,
          et si le problème persiste, rechargez la page ou contactez le support.
        </p>
        <div className="err-actions">
          <button type="button" className="od-btn od-btn--primary" onClick={reset}>
            <RotateCcw className="h-4 w-4" /> Réessayer
          </button>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full reload is the point: it clears the broken client state */}
          <a href="/" className="od-btn od-btn--ghost">Retour à l&apos;accueil</a>
        </div>
        {error.digest && <p className="err-digest">Référence : {error.digest}</p>}
      </div>
    </div>
  );
}
