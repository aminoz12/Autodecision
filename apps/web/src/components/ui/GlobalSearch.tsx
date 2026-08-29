"use client";

import {
  Boxes,
  Building2,
  ClipboardList,
  Loader2,
  Package,
  Search,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { globalSearch, type SearchHit, type SearchResults } from "@/lib/data/search";

const GROUPS: { key: keyof Omit<SearchResults, "total">; label: string; icon: LucideIcon }[] = [
  { key: "orders", label: "Commandes", icon: ClipboardList },
  { key: "clients", label: "Clients particuliers", icon: User },
  { key: "garages", label: "Garages", icon: Building2 },
  { key: "parts", label: "Pièces commandées", icon: Package },
  { key: "stock", label: "Stock magasin", icon: Boxes },
];

/**
 * Header search box: one query → orders, clients, garages, parts, stock.
 * Debounced, keyboard friendly (↑ ↓ Enter Esc), closes on outside click.
 */
export function GlobalSearch({ placeholder = "Rechercher : commande, pièce, client, plaque…" }: { placeholder?: string }) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const flat = useMemo<SearchHit[]>(
    () => (results ? GROUPS.flatMap((g) => results[g.key]) : []),
    [results],
  );

  // Debounced query
  useEffect(() => {
    if (!orgId) return;
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const id = window.setTimeout(() => {
      globalSearch(supabase, orgId, term)
        .then((r) => {
          setResults(r);
          setCursor(0);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    }, 220);
    return () => window.clearTimeout(id);
  }, [q, orgId, supabase]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // "/" focuses the search anywhere on the page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback(
    (hit: SearchHit) => {
      setOpen(false);
      setQ("");
      router.push(hit.href);
    },
    [router],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!flat.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flat[cursor] ?? flat[0]);
    }
  }

  const showPanel = open && q.trim().length >= 2;

  return (
    <div className="gs" ref={boxRef}>
      <div className={`gs-box${open ? " gs-box--open" : ""}`}>
        <Search className="gs-icon h-4 w-4" />
        <input
          ref={inputRef}
          className="gs-input"
          type="search"
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label="Recherche globale"
          autoComplete="off"
        />
        {loading ? (
          <Loader2 className="gs-spin h-4 w-4 nc-spin" />
        ) : q ? (
          <button type="button" className="gs-clear" onClick={() => { setQ(""); inputRef.current?.focus(); }} aria-label="Effacer">
            <X className="h-4 w-4" />
          </button>
        ) : (
          <kbd className="gs-kbd">/</kbd>
        )}
      </div>

      {showPanel && (
        <div className="gs-panel" role="listbox">
          {error && <div className="gs-empty gs-empty--error">{error}</div>}
          {!error && results && results.total === 0 && !loading && (
            <div className="gs-empty">Aucun résultat pour « {q.trim()} ».</div>
          )}
          {!error && results && results.total > 0 && (() => {
            let index = -1;
            return GROUPS.map((g) => {
              const hits = results[g.key];
              if (hits.length === 0) return null;
              const Icon = g.icon;
              return (
                <div key={g.key} className="gs-group">
                  <div className="gs-group-label">
                    <Icon className="h-3.5 w-3.5" />
                    {g.label}
                    <span className="gs-group-count">{hits.length}</span>
                  </div>
                  {hits.map((h) => {
                    index += 1;
                    const active = index === cursor;
                    return (
                      <button
                        key={`${h.kind}-${h.id}`}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`gs-hit${active ? " gs-hit--active" : ""}`}
                        onMouseEnter={() => setCursor(flat.indexOf(h))}
                        onClick={() => go(h)}
                      >
                        <span className="gs-hit-text">
                          <span className="gs-hit-title">{h.title}</span>
                          {h.subtitle && <span className="gs-hit-sub">{h.subtitle}</span>}
                        </span>
                        {h.tag && <span className="gs-hit-tag">{h.tag}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            });
          })()}
          {!error && !results && loading && <div className="gs-empty">Recherche…</div>}
          <div className="gs-foot">↑ ↓ pour naviguer · Entrée pour ouvrir · Échap pour fermer</div>
        </div>
      )}
    </div>
  );
}
