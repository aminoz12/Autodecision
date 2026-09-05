"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { homeSpace } from "@/lib/spaces";

/**
 * Wraps an ADMIN-only page: any other account is sent back to its own
 * space. Rendering is client-side — the real enforcement lives in RLS and
 * the server-only API routes.
 */
export function AdminGate({ children }: { children: React.ReactNode }) {
  const { user, profile, ready } = useAuth();
  const router = useRouter();
  const allowed = !!profile && profile.role === "ADMIN" && !profile.client_id;

  useEffect(() => {
    if (!ready) return;
    if (!allowed) router.replace(homeSpace(profile, user?.email));
  }, [ready, allowed, profile, user?.email, router]);

  if (!allowed) return null;
  return <>{children}</>;
}
