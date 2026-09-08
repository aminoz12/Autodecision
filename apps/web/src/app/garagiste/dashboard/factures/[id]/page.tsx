"use client";

import { ArrowLeft, Printer } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { InvoiceDocument } from "@/components/print/InvoiceDocument";
import { useAuth } from "@/components/providers/AuthProvider";
import { loadInvoice, type Invoice } from "@/lib/data/invoices";

export default function GarageInvoicePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const { supabase } = useAuth();
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
    <div className="gp-page">
      <header className="gp-header gp-header--row inv-noprint">
        <div>
          <Link href="/garagiste/dashboard/factures" className="od-breadcrumb-back"><ArrowLeft className="h-3.5 w-3.5" /> Mon compte</Link>
          <h1 className="gp-title" style={{ marginTop: 8 }}>{invoice ? `${invoice.kind === "AVOIR" ? "Avoir" : "Facture"} ${invoice.number}` : "Document"}</h1>
        </div>
        {invoice && (
          <button type="button" className="od-btn od-btn--primary" onClick={print}><Printer className="h-4 w-4" /> Imprimer / PDF</button>
        )}
      </header>
      {loading && <div className="gp-loading">Chargement…</div>}
      {(error || (!loading && !invoice)) && <div className="nc-error">{error ?? "Document introuvable."}</div>}
      {invoice && (
        <div className="inv-print">
          <InvoiceDocument invoice={invoice} />
        </div>
      )}
    </div>
  );
}
