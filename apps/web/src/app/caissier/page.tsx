"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { homeSpace } from "@/lib/spaces";

/**
 * /caissier — the counter space's address. A caissier lands on the
 * operational dashboard; any other account is sent to its own space.
 */
export default function CaissierRedirect() {
  const { user, profile, ready } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!ready) return;
    router.replace(homeSpace(profile, user?.email));
  }, [ready, profile, user?.email, router]);
  return null;
}
