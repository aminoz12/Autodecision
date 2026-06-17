"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/providers/AuthProvider";

export function DashboardGate({ children }: { children: React.ReactNode }) {
  const { user, profile, profileLoadError, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (!user) {
      router.replace("/login");
      return;
    }
    // A garagiste session in the magasin store is an anomaly (wrong login) —
    // send to /login, which signs it out cleanly.
    if (profile?.client_id) {
      router.replace("/login");
    }
  }, [ready, user, profile, router]);

  if (!ready || !user) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-zinc-500">
        Chargement…
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="mx-auto max-w-lg space-y-3 p-6 text-center text-sm text-zinc-600">
        <p className="font-medium text-zinc-900">Profil introuvable</p>
        {profileLoadError ? (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-left text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <span className="font-medium">Erreur lecture </span>
            <code className="text-xs">profiles</code>
            <span className="font-medium"> : </span>
            {profileLoadError}
          </p>
        ) : null}
        <p>
          1) Exécutez{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">supabase/schema.sql</code>{" "}
          dans le SQL Editor (trigger{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">handle_new_user</code>).
        </p>
        <p>
          2) Si le compte existait déjà avant le trigger, exécutez aussi{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">supabase/backfill_profiles.sql</code>.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
