"use client";

import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { OrganizationSettings } from "@/lib/data/saas";
import { printTicket } from "@/lib/print-ticket";
import { OrderTicket, type TicketData } from "./OrderTicket";

/**
 * A button that prints one 80 mm ticket (bon de livraison, ticket de
 * rangement…). The ticket is only rendered, hidden, at the moment of the
 * click — a list of orders never carries dozens of invisible barcodes.
 */
export function PrintTicketButton({
  ticket,
  kind,
  org,
  title,
  className,
  disabled,
  children,
}: {
  ticket: TicketData | null;
  kind: "commande" | "livraison" | "rangement" | "reception";
  org: Pick<OrganizationSettings, "name" | "phone" | "address" | "city" | "tvaRate"> | null;
  /** Suggested file name when printing to PDF. */
  title: string;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled || !ticket}
        onClick={() => {
          if (!ticket) return;
          flushSync(() => setArmed(true));
          printTicket(title, ref.current?.querySelector<HTMLElement>(".tk-doc"));
          setArmed(false);
        }}
      >
        {children}
      </button>
      {armed && ticket && (
        <div className="tk-print-only" ref={ref}>
          <OrderTicket org={org} data={ticket} kind={kind} />
        </div>
      )}
    </>
  );
}
