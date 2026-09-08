"use client";

import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { InvoiceDocument } from "@/components/print/InvoiceDocument";
import { createClient } from "@/lib/supabase/client";
import { loadInvoice, type Invoice } from "@/lib/data/invoices";

export default function InvoicePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const supabase = useMemo(() => createClient(), []);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    loadInvoice(supabase, id)
      .then((i) => {
        if (!cancelled) setInvoice(i);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, id]);

  function print() {
    if (!invoice) return;
    const prev = document.title;
    document.title = invoice.number;
    const reset = () => {
      document.title = prev;
      window.removeEventListener("afterprint", reset);
    };
    window.addEventListener("afterprint", reset);
    window.setTimeout(() => window.print(), 60);
  }

  return (
    <div className="od-page">
      <nav className="od-breadcrumb inv-noprint">
        <Link href="/dashboard/factures" className="od-breadcrumb-back"><ArrowLeft className="h-3.5 w-3.5" /> Factures</Link>
      </nav>
      {loading && <div className="od-card rc-empty"><p>Chargement…</p></div>}
      {(error || (!loading && !invoice)) && <div className="od-card rc-empty"><p>{error ?? "Document introuvable."}</p></div>}
      {invoice && (
        <>
          <div className="inv-toolbar inv-noprint">
            <div>
              <h1 className="rl-title">{invoice.kind === "AVOIR" ? "Avoir" : "Facture"} {invoice.number}</h1>
              <p className="rl-subtitle">Document immuable émis le {new Date(invoice.issuedAt).toLocaleDateString("fr-FR")}. Toute réimpression est un duplicata.</p>
            </div>
            <div className="cx-actions">
              {invoice.orderId && <Link href={`/dashboard/commandes/${invoice.orderId}`} className="od-btn od-btn--ghost">Voir la commande</Link>}
              <button type="button" className="od-btn od-btn--primary" onClick={print}><Printer className="h-4 w-4" /> Imprimer / PDF</button>
            </div>
          </div>
          <div className="inv-print">
            <InvoiceDocument invoice={invoice} />
          </div>
        </>
      )}
    </div>
  );
}
