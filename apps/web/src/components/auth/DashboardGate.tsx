"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { isBuiltinSuperAdmin } from "@/lib/superadmin";

export function DashboardGate({
  children,
  loginHref = "/caissier/login",
}: {
  children: React.ReactNode;
  /** Each space bounces anonymous visitors to its own login page. */
  loginHref?: string;
}) {
  const { user, profile, profileLoadError, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!ready) {
      return;
    }
    if (!user) {
      router.replace(loginHref);
      return;
    }
    // The SaaS owner has no magasin profile — their space is /superadmin.
    if (!profile && isBuiltinSuperAdmin(user.email)) {
      router.replace("/superadmin");
      return;
    }
    // A garagiste session in the magasin store is an anomaly (wrong login) —
    // this space's login page signs it out cleanly.
    if (profile?.client_id) {
      router.replace(loginHref);
      return;
    }
    // A livreur works in their own mobile space.
    if (profile?.role === "LIVREUR") {
      router.replace("/livreur");
    }
  }, [ready, user, profile, router, loginHref]);

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
          Ce compte n&apos;est rattaché à aucun magasin. Contactez l&apos;administrateur
          de votre magasin pour qu&apos;il vous crée un accès, ou reconnectez-vous
          avec le bon compte.
        </p>
        {process.env.NODE_ENV !== "production" && (
          <p className="text-xs text-zinc-500">
            Dev : le profil est créé par le trigger{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">handle_new_user</code>
            {" "}(migrations Supabase). Ne jamais exécuter les SQL legacy de{" "}
            <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">supabase/</code> sur un projet migré.
          </p>
        )}
      </div>
    );
  }

  return <>{children}</>;
}
