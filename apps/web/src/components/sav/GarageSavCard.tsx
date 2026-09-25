"use client";

import { Check, Loader2, Scale } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtMoney } from "@/lib/data/saas";
import { SavUnavailableError, isSavMissing, loadSavCases, type SavCaseRow } from "@/lib/data/sav";
import { CASE_TYPE_LABEL, CLIENT_STATUS_LABEL, clientStatusTone, familyLabel } from "@/lib/sav";

/**
 * Fiche garage — l'historique des litiges : combien, pour quel montant de
 * gestes, sur quelles familles de pièces. Un garage qui ouvre dix litiges par
 * an n'est pas le même client qu'un garage qui n'en ouvre jamais.
 */
export function GarageSavCard({ orgId, clientId }: { orgId: string; clientId: string }) {
  const [cases, setCases] = useState<SavCaseRow[]>([]);
  const [rate, setRate] = useState("");
  const [savedRate, setSavedRate] = useState("");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const sb = createClient();
    Promise.all([loadSavCases(sb, orgId, { clientId }), sb.from("clients").select("labor_rate").eq("id", clientId).maybeSingle()])
      .then(([list, client]) => {
        if (!alive) return;
        if (client.error && isSavMissing(client.error)) return setHidden(true);
        setCases(list);
        const r = (client.data as { labor_rate?: number | null } | null)?.labor_rate;
        setRate(r != null ? String(r) : "");
        setSavedRate(r != null ? String(r) : "");
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof SavUnavailableError) setHidden(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [orgId, clientId]);

  const stats = useMemo(() => {
    const yearAgo = now - 365 * 86_400_000;
    const recent = cases.filter((c) => new Date(c.openedAt).getTime() >= yearAgo);
    const byFamily = new Map<string, number>();
    for (const c of recent) byFamily.set(c.famille ?? "AUTRE", (byFamily.get(c.famille ?? "AUTRE") ?? 0) + 1);
    return {
      year: recent.length,
      open: cases.filter((c) => !c.closedAt).length,
      gestures: cases.reduce((s, c) => s + (c.gestureAmount ?? 0), 0),
      labor: cases.reduce((s, c) => s + c.laborAmount, 0),
      recurring: [...byFamily.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3),
    };
  }, [cases, now]);

  if (hidden) return null;

  const saveRate = async () => {
    setBusy(true);
    setError(null);
    const n = Number(rate.replace(",", "."));
    const { error: e } = await createClient()
      .from("clients")
      .update({ labor_rate: rate.trim() === "" || !Number.isFinite(n) ? null : n })
      .eq("id", clientId)
      .eq("organization_id", orgId);
    if (e) setError(e.message);
    else setSavedRate(rate);
    setBusy(false);
  };

  return (
    <section className="od-card">
      <div className="od-card-title"><Scale className="h-4 w-4" /> Litiges &amp; garanties</div>
      {error && <div className="nc-error">{error}</div>}
      <div className="sav-strip" style={{ marginTop: 10 }}>
        <span className="sav-strip-item"><strong>{stats.year}</strong> dossier(s) sur 12 mois</span>
        <span className="sav-strip-item"><strong>{stats.open}</strong> en cours</span>
        <span className="sav-strip-item"><strong>{fmtMoney(stats.labor)}</strong> de main d&apos;œuvre réclamée</span>
        <span className="sav-strip-item"><strong>{fmtMoney(stats.gestures)}</strong> de gestes accordés</span>
        {stats.recurring.map(([fam, n]) => (
          <span key={fam} className="sav-strip-item"><em>Récurrent :</em> {familyLabel(fam)} × {n}</span>
        ))}
      </div>
      <div className="sav-inline" style={{ marginBottom: 12 }}>
        <label className="od-label" htmlFor="garage-rate" style={{ margin: 0 }}>Taux horaire du garage (€ HT)</label>
        <input id="garage-rate" className="od-input" style={{ width: 110, height: 36 }} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="65" />
        {rate !== savedRate && (
          <button type="button" className="od-btn od-btn--outline" disabled={busy} onClick={() => void saveRate()}>
            {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Enregistrer
          </button>
        )}
        <span className="sav-sub">Base du chiffrage de la main d&apos;œuvre perdue (taux × temps barémé).</span>
      </div>
      {cases.length > 0 ? (
        <div className="rl-table-wrap">
          <table className="rl-table sav-table">
            <thead>
              <tr><th>Dossier</th><th>Ouvert le</th><th>Pièce</th><th>Statut</th><th className="av-th-right">Main d&apos;œuvre</th><th className="av-th-right">Geste</th></tr>
            </thead>
            <tbody>
              {cases.slice(0, 12).map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link className="sav-link" href={`/dashboard/sav/${c.id}`}>{c.ref}</Link>{" "}
                    <span className={`rt-badge rt-badge--${c.type === "GARANTIE" ? "violet" : "amber"}`}>{CASE_TYPE_LABEL[c.type]}</span>
                  </td>
                  <td className="rl-muted-strong">{fmtDate(c.openedAt)}</td>
                  <td>{c.designation}</td>
                  <td><span className={`rt-badge rt-badge--${clientStatusTone(c.clientStatus)}`}>{CLIENT_STATUS_LABEL[c.clientStatus]}</span></td>
                  <td className="av-th-right">{c.laborAmount > 0 ? fmtMoney(c.laborAmount) : "—"}</td>
                  <td className="av-th-right">{c.gestureAmount != null ? fmtMoney(c.gestureAmount) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="sav-sub">Aucun litige ni dossier garantie pour ce garage.</p>
      )}
    </section>
  );
}
