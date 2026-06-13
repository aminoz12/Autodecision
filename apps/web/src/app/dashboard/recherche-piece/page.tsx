"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { searchParts, type PartSearchResult } from "@/lib/data/saas";

export default function RecherchePiecePage() {
  const { profile } = useAuth();
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
          <h1 className="rl-title">Recherche piece</h1>
          <p className="rl-subtitle">
            Recherche dans le stock et les lignes de commandes Supabase.
          </p>
        </div>
      </header>

      <div className="rt-search" style={{ maxWidth: 720 }}>
        <Search className="rt-search-icon h-4 w-4" />
        <input
          className="rt-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Reference, designation, SKU..."
        />
      </div>

      {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}

      <section className="od-card rl-table-card">
        <div className="rl-table-wrap">
          <table className="rl-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Reference</th>
                <th>Designation</th>
                <th className="rl-th-center">Quantite</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}-${row.id}`}>
                  <td>
                    <span className={`av-type av-type--${row.kind === "stock" ? "consigne" : "avoir"}`}>
                      {row.kind === "stock" ? "Stock" : "Commande"}
                    </span>
                  </td>
                  <td className="rl-reffour">{row.reference}</td>
                  <td className="rl-client">{row.designation}</td>
                  <td className="rl-th-center rl-qte">{row.quantity}</td>
                  <td className="rl-muted-strong">{row.source}</td>
                </tr>
              ))}
              {!loading && query.trim().length >= 2 && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted">Aucun resultat.</td>
                </tr>
              )}
              {query.trim().length < 2 && (
                <tr>
                  <td colSpan={5} className="text-muted">Tapez au moins 2 caracteres.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
