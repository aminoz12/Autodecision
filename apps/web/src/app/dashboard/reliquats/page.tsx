"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * The standalone Reliquats page duplicated the "Reliquats" tab of Suivi des
 * commandes — it now redirects there (kept for old bookmarks).
 */
export default function ReliquatsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/commandes?tab=reliquats");
  }, [router]);
  return null;
}
