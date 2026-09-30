"use client";

import { useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Feeds one query-string parameter into page state — also when only the
 * query changes while the page stays mounted (a bell link opened on the page
 * it points to). Render it inside a <Suspense> boundary.
 */
export function SearchParamEffect({ name, onValue }: { name: string; onValue: (value: string) => void }) {
  const params = useSearchParams();
  const value = params.get(name);
  useEffect(() => {
    if (!value) return;
    const id = window.setTimeout(() => onValue(value), 0);
    return () => window.clearTimeout(id);
  }, [value, onValue]);
  return null;
}
