"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * /caissier — the counter space's address. The caissier's tools live in the
 * operational dashboard, so this simply lands there (auth is enforced by the
 * dashboard's own gate).
 */
export default function CaissierRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);
  return null;
}
