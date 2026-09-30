"use client";

import { ArrowUpRight, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { searchParts, type PartSearchResult } from "@/lib/data/saas";

/** Where a result opens: the order that holds the line, or the stock page on that reference. */
function hrefOf(row: PartSearchResult): string | null {
  if (row.kind === "order-line") return row.orderId ? `/dashboard/commandes/${row.orderId}` : null;
  return `/dashboard/stock?q=${encodeURIComponent(row.reference)}`;
}

export default function RecherchePiecePage() {
  const { profile } = useAuth();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<PartSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile?.organization_id || query.trim().length < 2) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      const sb = createClient();
      searchParts(sb, profile.organization_id, query)
        .then((data) => {
          if (!cancelled) setRows(data);
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [profile?.organization_id, query]);

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title">Recherche pièce</h1>
          <p className="rl-subtitle">
            Retrouvez une pièce dans le stock magasin et dans toutes les commandes. Cliquez sur une ligne pour ouvrir la commande ou le stock.
          </p>
        </div>
      </header>

      <div className="rt-search" style={{ maxWidth: 720 }}>
        <Search className="rt-search-icon h-4 w-4" />
        <input
          className="rt-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Référence, désignation, SKU…"
          autoFocus
        />
      </div>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Référence</th>
                <th>Désignation</th>
                <th className="rl-th-center">Quantité</th>
                <th>Source</th>
                <th aria-label="Ouvrir" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const href = hrefOf(row);
                const open = () => {
                  if (href) router.push(href);
                };
                return (
                  <tr
                    key={`${row.kind}-${row.id}`}
                    className={href ? "sav-row" : undefined}
                    tabIndex={href ? 0 : undefined}
                    onClick={open}
                    onKeyDown={(e) => {
                      if (href && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        open();
                      }
                    }}
                  >
                    <td>
                      <span className={`av-type av-type--${row.kind === "stock" ? "consigne" : "avoir"}`}>
                        {row.kind === "stock" ? "Stock" : "Commande"}
                      </span>
                    </td>
                    <td className="rl-reffour">
                      {href ? (
                        <Link href={href} className="rc-cmd" onClick={(e) => e.stopPropagation()}>
                          {row.reference}
                        </Link>
                      ) : (
                        row.reference
                      )}
                      {row.referenceCommande && row.referenceCommande !== row.reference && (
                        <span className="rl-ref-cmd"> · cmd. {row.referenceCommande}</span>
                      )}
                    </td>
                    <td className="rl-client">{row.designation}</td>
                    <td className="rl-th-center rl-qte">{row.quantity}</td>
                    <td className="rl-muted-strong">{row.source}</td>
                    <td className="rl-td-open">
                      {href && <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
                    </td>
                  </tr>
                );
              })}
              {!loading && query.trim().length >= 2 && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-muted">Aucun résultat.</td>
                </tr>
              )}
              {query.trim().length < 2 && (
                <tr>
                  <td colSpan={6} className="text-muted">Tapez au moins 2 caractères.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
