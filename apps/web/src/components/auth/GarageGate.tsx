"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/providers/AuthProvider";

/** Gate for the garagiste portal: requires a session with a linked garage. */
export function GarageGate({ children }: { children: React.ReactNode }) {
  const { user, profile, ready } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      router.replace("/garagiste");
      return;
    }
    // Staff (no client_id) belong in the management dashboard.
    if (profile && !profile.client_id) {
      router.replace("/dashboard");
    }
  }, [ready, user, profile, router]);

  if (!ready || !user || (profile && !profile.client_id)) {
    return (
      <div className="gp-loading">
        <span>Chargement…</span>
      </div>
    );
  }

  return <>{children}</>;
}
