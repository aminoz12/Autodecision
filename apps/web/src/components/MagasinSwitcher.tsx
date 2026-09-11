"use client";

import { ChevronDown, Loader2, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { loadMagasins, switchMagasin, type MagasinRow } from "@/lib/data/admin";

/**
 * Owner-only select to open another of their magasins. Renders nothing for
 * caissiers, livreurs and garagistes, or when the owner has a single magasin.
 * Switching updates the session's magasin server-side, then reloads the app
 * so every screen reads the new one.
 */
export function MagasinSwitcher({ className = "" }: { className?: string }) {
  const { profile } = useAuth();
  const isOwner = !!profile && profile.role === "ADMIN" && !profile.client_id && !profile.livreur_id;
  const [magasins, setMagasins] = useState<MagasinRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    loadMagasins()
      .then((r) => {
        if (!cancelled) setMagasins(r.magasins);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOwner, profile?.organization_id]);

  if (!isOwner || magasins.length < 2) return null;
  const current = magasins.find((m) => m.isCurrent)?.id ?? profile?.organization_id ?? "";

  async function open(id: string) {
    if (!id || id === current) return;
    setBusy(true);
    try {
      await switchMagasin(id);
      window.location.reload();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <label className={`od-select ms-switch ${className}`.trim()} title="Changer de magasin">
      {busy ? <Loader2 className="h-4 w-4 nc-spin ms-switch-icon" /> : <Store className="h-4 w-4 ms-switch-icon" />}
      <select value={current} onChange={(e) => void open(e.target.value)} disabled={busy} aria-label="Magasin ouvert">
        {magasins.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.city ? ` — ${m.city}` : ""}
          </option>
        ))}
      </select>
      <ChevronDown className="h-4 w-4" />
    </label>
  );
}
