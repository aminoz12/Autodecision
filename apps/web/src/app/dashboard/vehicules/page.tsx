"use client";

import { CarFront, Gauge, History, Loader2, Phone, Search, ShieldCheck, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { OpenCaseDialog, type OpenCasePreset } from "@/components/sav/OpenCaseDialog";
import { WarrantyLight } from "@/components/sav/WarrantyLight";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtMoney } from "@/lib/data/saas";
import { SavUnavailableError, buildVehicleFiles, searchSales, type SaleLine, type VehicleFile } from "@/lib/data/sav";
import { CASE_TYPE_LABEL, MAINTENANCE_RULES, addMonths, familyLabel, formatPlate, parseDay, toDayString } from "@/lib/sav";

/** « Prochain besoin » of a sold part: the date the reminder rules point to. */
function nextNeed(line: SaleLine): { label: string; date: string } | null {
  const rule = MAINTENANCE_RULES[line.famille ?? ""];
  const start = parseDay(line.warranty?.start ?? line.orderDate);
  if (!rule || !start) return null;
  return { label: rule.need, date: toDayString(addMonths(start, rule.relanceMonths)) };
}

function LinesTable({ lines, onOpenCase }: { lines: SaleLine[]; onOpenCase: (l: SaleLine) => void }) {
  return (
    <div className="rl-table-wrap">
      <table className="rl-table sav-table">
        <thead>
          <tr>
            <th>Vendue le</th>
            <th>Pièce</th>
            <th>Commande</th>
            <th>Client</th>
            <th>Garantie</th>
            <th>Prochain besoin</th>
            <th>Suivi</th>
            <th aria-label="Action" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const need = nextNeed(l);
            return (
              <tr key={l.lineId}>
                <td className="rl-muted-strong">{fmtDate(l.warranty?.start ?? l.orderDate)}</td>
                <td>
                  <p className="rl-client">
                    {l.quantity > 1 ? `${l.quantity} × ` : ""}
                    {l.designation}
                  </p>
                  <p className="sav-sub">
                    {l.reference}
                    {l.marque ? ` · ${l.marque}` : ""}
                    {l.supplier ? ` · ${l.supplier}` : ""}
                    {l.serialNumber ? ` · n° ${l.serialNumber}` : ""}
                  </p>
                  <p className="sav-sub">{familyLabel(l.famille)} · {fmtMoney(l.unitPrice)}</p>
                </td>
                <td>
                  <Link className="sav-link" href={`/dashboard/commandes/${l.orderId}`}>
                    {l.orderRef}
                  </Link>
                  {l.km != null && l.km > 0 && <p className="sav-sub">{l.km.toLocaleString("fr-FR")} km</p>}
                </td>
                <td>
                  <p className="rl-client">{l.clientName}</p>
                  {l.garagePoseur && <p className="sav-sub">Posée par {l.garagePoseur}</p>}
                </td>
                <td>
                  <WarrantyLight warranty={l.warranty} compact />
                  {l.warranty && l.warranty.daysLeft >= 0 && <p className="sav-sub">encore {l.warranty.daysLeft} j</p>}
                </td>
                <td>
                  {need ? (
                    <>
                      <p className="sav-need">{fmtDate(need.date)}</p>
                      <p className="sav-sub">{need.label}</p>
                    </>
                  ) : (
                    <span className="sav-sub">—</span>
                  )}
                </td>
                <td>
                  <div className="sav-tags">
                    {l.returned && <span className="rt-badge rt-badge--blue">Retournée</span>}
                    {l.consigne && (
                      <span className={`rt-badge rt-badge--${l.consigneStatus === "RENDUE" ? "green" : "amber"}`}>
                        Consigne {l.consigneStatus === "RENDUE" ? "rendue" : "à rendre"}
                      </span>
                    )}
                    {l.openCase && (
                      <Link href={`/dashboard/sav/${l.openCase.id}`} className={`rt-badge rt-badge--${l.openCase.closed ? "gray" : "violet"}`}>
                        {CASE_TYPE_LABEL[l.openCase.type] ?? "Dossier"} {l.openCase.ref}
                      </Link>
                    )}
                  </div>
                </td>
                <td className="od-td-right">
                  {!l.openCase || l.openCase.closed ? (
                    <button type="button" className="od-btn od-btn--outline" onClick={() => onOpenCase(l)}>
                      <ShieldCheck className="h-4 w-4" /> Ouvrir un dossier
                    </button>
                  ) : (
                    <Link href={`/dashboard/sav/${l.openCase.id}`} className="od-btn od-btn--ghost">
                      Voir le dossier
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VehicleCard({ v, onOpenCase }: { v: VehicleFile; onOpenCase: (l: SaleLine) => void }) {
  const underWarranty = v.lines.filter((l) => l.warranty && l.warranty.daysLeft >= 0 && !l.returned).length;
  return (
    <section className="od-card sav-vehicle">
      <header className="sav-vehicle-head">
        <span className="sav-plate">{formatPlate(v.plate)}</span>
        <div className="sav-vehicle-id">
          <p className="sav-vehicle-model">{v.model ?? "Véhicule non renseigné"}</p>
          <p className="sav-sub">
            {v.lines.length} pièce(s) vendue(s) · {underWarranty} encore sous garantie
          </p>
        </div>
        <div className="sav-vehicle-facts">
          {v.kms.length > 0 && (
            <span className="sav-fact" title={v.kms.map((k) => `${fmtDate(k.date)} : ${k.km.toLocaleString("fr-FR")} km`).join("\n")}>
              <Gauge className="h-4 w-4" /> {v.kms[0].km.toLocaleString("fr-FR")} km
              <em>le {fmtDate(v.kms[0].date)}</em>
            </span>
          )}
          {v.owners.slice(0, 3).map((o) => (
            <span key={(o.clientId ?? "") + o.name} className="sav-fact">
              {o.isGarage ? <Wrench className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
              {o.clientId ? (
                <Link className="sav-link" href={o.isGarage ? `/dashboard/garages/${o.clientId}` : `/dashboard/clients/${o.clientId}`}>
                  {o.name}
                </Link>
              ) : (
                o.name
              )}
              {o.phone && <em>{o.phone}</em>}
            </span>
          ))}
        </div>
      </header>
      {v.kms.length > 1 && (
        <p className="sav-kms">
          <History className="h-4 w-4" /> Kilométrages relevés :{" "}
          {v.kms
            .slice(0, 6)
            .map((k) => `${k.km.toLocaleString("fr-FR")} km (${fmtDate(k.date)})`)
            .join(" · ")}
        </p>
      )}
      <LinesTable lines={v.lines} onOpenCase={onOpenCase} />
    </section>
  );
}

function VehiculesInner() {
  const { profile } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("q") ?? "";
  const [query, setQuery] = useState(initial);
  const [submitted, setSubmitted] = useState(initial);
  const [lines, setLines] = useState<SaleLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [preset, setPreset] = useState<OpenCasePreset | null>(null);

  const run = useCallback(
    async (q: string) => {
      if (!profile?.organization_id || q.trim().length < 3) return;
      setLoading(true);
      setError(null);
      try {
        setLines(await searchSales(createClient(), q.trim()));
      } catch (e) {
        if (e instanceof SavUnavailableError) setUnavailable(true);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [profile?.organization_id],
  );

  useEffect(() => {
    if (submitted) void run(submitted);
  }, [submitted, run]);

  const { vehicles, noPlate } = useMemo(() => {
    const all = lines ?? [];
    return { vehicles: buildVehicleFiles(all), noPlate: all.filter((l) => !l.plateNorm) };
  }, [lines]);

  const openCase = (l: SaleLine) =>
    setPreset({
      type: "GARANTIE",
      orderLineId: l.lineId,
      orderId: l.orderId,
      clientId: l.clientId,
      designation: l.designation,
      reference: l.reference,
      immatriculation: l.plate,
      serialNumber: l.serialNumber,
      garagePoseur: l.garagePoseur,
      kmMontage: l.km,
      clientName: l.clientName,
      orderRef: l.orderRef,
      warranty: l.warranty,
    });

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">
            Carnet véhicule
          </h1>
          <p className="rl-subtitle">
            « J&apos;ai acheté un alternateur chez vous l&apos;an dernier » — tapez la plaque, retrouvez la vente, la référence, la date et la
            garantie. Sans facture.
          </p>
        </div>
      </header>

      <form
        className="od-card sav-search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(query.trim());
          router.replace(`/dashboard/vehicules?q=${encodeURIComponent(query.trim())}`);
        }}
      >
        <CarFront className="h-6 w-6 sav-search-icon" />
        <input
          className="sav-search-input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Immatriculation, téléphone, nom du client, n° de commande, référence ou n° de série"
          aria-label="Rechercher une vente"
        />
        <button type="submit" className="od-btn od-btn--primary" disabled={loading || query.trim().length < 3}>
          {loading ? <Loader2 className="h-4 w-4 nc-spin" /> : <Search className="h-4 w-4" />} Rechercher
        </button>
      </form>

      {error && <div className="nc-error">{error}</div>}
      {unavailable && (
        <p className="sav-hint">Appliquez les migrations 20260920010000 et 20260920020000 (supabase db push) pour activer le module après-vente.</p>
      )}

      {lines && lines.length === 0 && !loading && (
        <section className="od-card sav-empty">
          <CarFront className="h-8 w-8" />
          <p>Aucune vente trouvée pour « {submitted} ».</p>
          <p className="sav-sub">Essayez le téléphone du client ou son nom : la plaque n&apos;a peut-être pas été saisie à la vente.</p>
        </section>
      )}

      {vehicles.map((v) => (
        <VehicleCard key={v.plateNorm} v={v} onOpenCase={openCase} />
      ))}

      {noPlate.length > 0 && (
        <section className="od-card sav-vehicle">
          <header className="sav-vehicle-head">
            <div className="sav-vehicle-id">
              <p className="sav-vehicle-model">Ventes sans immatriculation</p>
              <p className="sav-sub">{noPlate.length} pièce(s) — la plaque n&apos;a pas été saisie au comptoir.</p>
            </div>
          </header>
          <LinesTable lines={noPlate} onOpenCase={openCase} />
        </section>
      )}

      <OpenCaseDialog preset={preset} onClose={() => setPreset(null)} onCreated={(id) => router.push(`/dashboard/sav/${id}`)} />
    </div>
  );
}

export default function VehiculesPage() {
  return (
    <Suspense fallback={null}>
      <VehiculesInner />
    </Suspense>
  );
}
