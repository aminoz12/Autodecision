"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Nouvelle version déployée — un onglet laissé ouvert (caisse, garage)
    garde l'ancien bundle jusqu'à un rechargement. Ce composant compare
    la version compilée dans CE bundle (NEXT_PUBLIC_APP_VERSION) à celle
    que /api/version publie (figée à chaque déploiement) et propose de
    recharger. Jamais de reload automatique : le caissier peut être en
    pleine saisie. */
/* ------------------------------------------------------------------ */

const CHECK_EVERY_MS = 5 * 60 * 1000;

/** Version du bundle que cet onglet exécute (inlinée au build). */
const RUNNING = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";

async function fetchDeployed(): Promise<string | null> {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { build?: unknown };
    return typeof data.build === "string" && data.build ? data.build : null;
  } catch {
    return null; // hors ligne ou déploiement en cours : on réessaiera
  }
}

export function NewVersionNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (RUNNING === "dev") return; // dev local : jamais de bandeau
    let stopped = false;

    const check = async () => {
      const deployed = await fetchDeployed();
      if (stopped || !deployed || deployed === "dev") return;
      if (deployed !== RUNNING) setStale(true);
    };

    void check();
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    // Un onglet qui revient au premier plan vérifie tout de suite.
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="nv-banner" role="status">
      <span>Une nouvelle version de l&apos;application est disponible.</span>
      <button type="button" className="od-btn od-btn--primary" onClick={() => window.location.reload()}>
        <RefreshCw className="h-4 w-4" />
        Recharger
      </button>
    </div>
  );
}
