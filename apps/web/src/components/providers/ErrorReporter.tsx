"use client";

import { useEffect } from "react";
import { installFetchReporter, reportEvent } from "@/lib/telemetry";

// Installed as soon as the bundle loads, before the first data call of any page.
installFetchReporter();

/** Messages browsers emit that say nothing about the app. */
const NOISE = /^(Script error\.?|ResizeObserver loop)/i;

/**
 * Files every uncaught error of the browser in the journal (/superadmin/journal):
 * exceptions, rejected promises, and — through the fetch watcher — failed calls
 * to the database and to /api. Renders nothing.
 */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      const message = e.message || (e.error instanceof Error ? e.error.message : "");
      if (!message || NOISE.test(message)) return;
      reportEvent({
        source: "client",
        message,
        stack: e.error instanceof Error ? e.error.stack : null,
        context: e.filename ? { file: e.filename, line: e.lineno, col: e.colno } : null,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason: unknown = e.reason;
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      const message = reason instanceof Error ? reason.message : String(reason);
      if (!message || NOISE.test(message)) return;
      reportEvent({ source: "promise", message, stack: reason instanceof Error ? reason.stack : null });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
