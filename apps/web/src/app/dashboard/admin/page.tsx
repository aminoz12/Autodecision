"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** The admin space moved to /admin — kept for old bookmarks. */
export default function AdminRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin");
  }, [router]);
  return null;
}
