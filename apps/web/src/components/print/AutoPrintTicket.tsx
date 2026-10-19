"use client";

import { useEffect, useRef } from "react";
import type { OrganizationSettings } from "@/lib/data/saas";
import { printTicket } from "@/lib/print-ticket";
import { OrderTicket, type TicketData } from "./OrderTicket";

/**
 * Prints one 80 mm ticket as soon as it is mounted, without a click: the
 * « commande prête » ticket that comes out by itself when the last part of
 * a walk-in order is pointed (2026-10-19). `onDone` fires once the print
 * dialog closes (printed or cancelled) so the parent can unmount it.
 */
export function AutoPrintTicket({
  ticket,
  kind,
  org,
  title,
  onDone,
}: {
  ticket: TicketData;
  kind: "commande" | "livraison" | "rangement" | "reception" | "pret";
  org: Pick<OrganizationSettings, "name" | "phone" | "address" | "city" | "tvaRate"> | null;
  /** Suggested file name when printing to PDF. */
  title: string;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const finish = () => {
      window.removeEventListener("afterprint", finish);
      done.current();
    };
    window.addEventListener("afterprint", finish);
    // Next frame: fonts and layout are settled before the ticket is measured.
    const frame = window.requestAnimationFrame(() => {
      printTicket(title, ref.current?.querySelector<HTMLElement>(".tk-doc"));
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("afterprint", finish);
    };
  }, [title]);

  return (
    <div className="tk-print-only" ref={ref}>
      <OrderTicket org={org} data={ticket} kind={kind} />
    </div>
  );
}
