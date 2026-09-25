"use client";

import { BellRing, CarFront, Gift, LifeBuoy, Loader2, MessageSquareText, Receipt } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtMoney } from "@/lib/data/saas";
import { isSavMissing, loadSavCases, notifyClient, sendResultText, type SavCaseRow } from "@/lib/data/sav";
import { CASE_TYPE_LABEL, CLIENT_STATUS_LABEL, clientStatusTone, formatPlate, normalizePlate } from "@/lib/sav";

/**
 * Fiche client — l'après-vente d'un coup d'œil : le solde d'avoir (visible au
 * comptoir sans chercher dans la compta), ses véhicules, ses dossiers ouverts,
 * et son accord pour les rappels par SMS.
 */
export function ClientSavStrip({
  orgId,
  clientId,
  credits,
  plates,
  isGarage,
}: {
  orgId: string;
  clientId: string;
  credits: { id: string; amount: number; used: number; statut: string; echeance: string | null }[];
  plates: (string | null)[];
  isGarage: boolean;
}) {
  const [consent, setConsent] = useState<boolean | null>(null);
  const [optOut, setOptOut] = useState(false);
  const [cases, setCases] = useState<SavCaseRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = createClient();
    const { data, error } = await sb.from("clients").select("sms_marketing_consent, sms_opt_out_at").eq("id", clientId).maybeSingle();
    if (error) {
      if (!isSavMissing(error)) setNote(error.message);
      return; // module not migrated: only the balance below is shown
    }
    const row = data as { sms_marketing_consent?: boolean; sms_opt_out_at?: string | null } | null;
    setConsent(row?.sms_marketing_consent === true);
    setOptOut(row?.sms_opt_out_at != null);
    try {
      setCases(await loadSavCases(sb, orgId, { clientId }));
    } catch {
      /* dossiers are a bonus here */
    }
  }, [orgId, clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = credits.filter((c) => (c.statut === "EN_COURS" || c.statut === "PARTIEL") && c.amount - c.used > 0);
  const balance = open.reduce((s, c) => s + (c.amount - c.used), 0);
  const nextExpiry = open.map((c) => c.echeance).filter(Boolean).sort()[0] ?? null;
  const uniquePlates = [...new Map(plates.filter(Boolean).map((p) => [normalizePlate(p), p as string])).entries()].filter(([k]) => k).slice(0, 6);
  const openCases = cases.filter((c) => !c.closedAt);

  const toggleConsent = async (next: boolean) => {
    setBusy(true);
    setNote(null);
    const sb = createClient();
    const { error } = await sb
      .from("clients")
      .update({
        sms_marketing_consent: next,
        sms_marketing_consent_at: next ? new Date().toISOString() : null,
        ...(next ? { sms_opt_out_at: null } : {}),
      })
      .eq("id", clientId)
      .eq("organization_id", orgId);
    if (error) setNote(error.message);
    else {
      setConsent(next);
      if (next) setOptOut(false);
    }
    setBusy(false);
  };

  const announce = async () => {
    if (open.length === 0) return;
    setBusy(true);
    setNote(null);
    try {
      setNote(sendResultText(await notifyClient(createClient(), "AVOIR_BALANCE", open[0].id)));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (balance <= 0 && consent === null && uniquePlates.length === 0) return null;

  return (
    <section className="od-card sav-client">
      <div className={`sav-client-balance${balance > 0 ? " sav-client-balance--on" : ""}`}>
        <Receipt className="h-5 w-5" />
        <div>
          <p className="sav-client-label">Solde d&apos;avoir</p>
          <p className="sav-client-value">{fmtMoney(balance)}</p>
          {balance > 0 && nextExpiry && <p className="sav-sub">à utiliser avant le {fmtDate(nextExpiry)}</p>}
        </div>
        {balance > 0 && (
          <div className="sav-client-actions">
            <Link href={`/dashboard/nouvelle-commande?client=${clientId}&avoir=${open[0].id}`} className="od-btn od-btn--primary">
              <Gift className="h-4 w-4" /> Utiliser
            </Link>
            {consent !== null && (
              <button type="button" className="od-btn od-btn--ghost" disabled={busy} onClick={() => void announce()} title="SMS : « vous avez X € d'avoir chez nous »">
                {busy ? <Loader2 className="h-4 w-4 nc-spin" /> : <MessageSquareText className="h-4 w-4" />} Le lui rappeler
              </button>
            )}
          </div>
        )}
      </div>

      {uniquePlates.length > 0 && (
        <div className="sav-client-block">
          <p className="sav-client-label"><CarFront className="h-4 w-4" /> Carnets véhicule</p>
          <div className="sav-tags">
            {uniquePlates.map(([norm, plate]) => (
              <Link key={norm} href={`/dashboard/vehicules?q=${encodeURIComponent(plate)}`} className="sav-plate sav-plate--sm">
                {formatPlate(plate)}
              </Link>
            ))}
          </div>
        </div>
      )}

      {consent !== null && (
        <div className="sav-client-block">
          <p className="sav-client-label"><LifeBuoy className="h-4 w-4" /> Dossiers SAV</p>
          {openCases.length === 0 ? (
            <p className="sav-sub">{cases.length > 0 ? `${cases.length} dossier(s) clos` : "Aucun dossier"}</p>
          ) : (
            <div className="sav-tags">
              {openCases.slice(0, 4).map((c) => (
                <Link key={c.id} href={`/dashboard/sav/${c.id}`} className={`rt-badge rt-badge--${clientStatusTone(c.clientStatus)}`}>
                  {CASE_TYPE_LABEL[c.type]} {c.ref} · {CLIENT_STATUS_LABEL[c.clientStatus]}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}

      {consent !== null && !isGarage && (
        <div className="sav-client-block">
          <p className="sav-client-label"><BellRing className="h-4 w-4" /> Rappels par SMS</p>
          <label className="sav-check">
            <input type="checkbox" checked={consent} disabled={busy} onChange={(e) => void toggleConsent(e.target.checked)} />
            Accepte les rappels d&apos;entretien
          </label>
          {optOut && <p className="sav-promise sav-promise--late">S&apos;est désinscrit par le lien STOP</p>}
        </div>
      )}
      {note && <p className="sav-sub sav-client-note">{note}</p>}
    </section>
  );
}
