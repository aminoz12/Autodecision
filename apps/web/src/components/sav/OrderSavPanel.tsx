"use client";

import { Camera, Check, ExternalLink, LifeBuoy, Loader2, MessageSquareText, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { OpenCaseDialog, type OpenCasePreset } from "@/components/sav/OpenCaseDialog";
import { WarrantyLight } from "@/components/sav/WarrantyLight";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtDateTime } from "@/lib/data/saas";
import {
  SavUnavailableError,
  loadClientMessages,
  loadOrderSavInfo,
  setOrderSavFields,
  signedSavUrl,
  uploadSavFile,
  type ClientMessage,
  type OrderSavInfo,
} from "@/lib/data/sav";
import { CASE_TYPE_LABEL, CLIENT_STATUS_LABEL, clientStatusTone, familyLabel, lineWarranty, parisToday, parseDay } from "@/lib/sav";
import { QUEUED_SMS_LABEL, type QueuedSmsKind } from "@/lib/sms";

/**
 * Le volet après-vente d'une commande : ce qui a été promis au client, où la
 * pièce l'attend (casier), la garantie de chaque ligne, les dossiers ouverts
 * et les messages partis. Renders nothing until the SAV migrations are applied.
 */
export type OrderSavPanelLine = { id: string; designation: string; reference: string; quantity: number; handedOver: number };

export function OrderSavPanel({
  orgId,
  order,
  lines,
}: {
  orgId: string;
  order: { id: string; ref: string; date: string | null; clientName: string; plate: string | null; kilometrage: number | null; isGarage: boolean; isRestock: boolean; devis: boolean };
  lines: OrderSavPanelLine[];
}) {
  const router = useRouter();
  const [info, setInfo] = useState<OrderSavInfo | null>(null);
  const [messages, setMessages] = useState<ClientMessage[]>([]);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [promised, setPromised] = useState("");
  const [casier, setCasier] = useState("");
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [marques, setMarques] = useState<Record<string, string>>({});
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [preset, setPreset] = useState<OpenCasePreset | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const photoLine = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const sb = createClient();
      const [i, m] = await Promise.all([loadOrderSavInfo(sb, orgId, order.id), loadClientMessages(sb, orgId, { orderId: order.id, limit: 20 })]);
      setInfo(i);
      setMessages(m);
      setPromised(i.promisedDate ?? "");
      setCasier(i.casier ?? "");
      setSerials(Object.fromEntries([...i.lines.values()].map((l) => [l.id, l.serialNumber ?? ""])));
      setMarques(Object.fromEntries([...i.lines.values()].map((l) => [l.id, l.marque ?? ""])));
      const withPhoto = [...i.lines.values()].filter((l) => l.receptionPhotoPath);
      const urls = await Promise.all(withPhoto.map((l) => signedSavUrl(sb, l.receptionPhotoPath as string)));
      setPhotos(Object.fromEntries(withPhoto.map((l, idx) => [l.id, urls[idx] ?? ""]).filter(([, u]) => u)));
    } catch (e) {
      if (e instanceof SavUnavailableError) setHidden(true);
      else setError(e instanceof Error ? e.message : String(e));
    }
  }, [orgId, order.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden || order.isRestock || order.devis) return null;

  const save = async () => {
    if (!info) return;
    setBusy("save");
    setError(null);
    try {
      const changed = lines
        .filter((l) => (serials[l.id] ?? "") !== (info.lines.get(l.id)?.serialNumber ?? "") || (marques[l.id] ?? "") !== (info.lines.get(l.id)?.marque ?? ""))
        .map((l) => ({ id: l.id, serialNumber: serials[l.id] ?? "", marque: marques[l.id] ?? "" }));
      await setOrderSavFields(createClient(), order.id, { promisedDate: promised || null, casier: casier || null, lines: changed });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const uploadPhoto = async (file: File | undefined) => {
    const lineId = photoLine.current;
    if (!file || !lineId) return;
    setBusy(`photo:${lineId}`);
    setError(null);
    try {
      const sb = createClient();
      const path = await uploadSavFile(sb, orgId, `lines/${lineId}`, file);
      await setOrderSavFields(sb, order.id, { lines: [{ id: lineId, receptionPhotoPath: path }] });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      if (photoInput.current) photoInput.current.value = "";
    }
  };

  const effectivePromise = info?.promiseRevisedDate ?? info?.promisedDate ?? null;
  const promiseDay = parseDay(effectivePromise);
  const promiseLate = promiseDay != null && !info?.readyAt && promiseDay < parisToday();

  return (
    <section className="od-card sav-order">
      <h2 className="od-card-title">
        <LifeBuoy className="h-4 w-4" />
        Après-vente
        {info?.pickedUpAt ? (
          <span className="rt-badge rt-badge--green">Retirée le {fmtDate(info.pickedUpAt)}</span>
        ) : info?.readyAt ? (
          <span className="rt-badge rt-badge--amber">Prête depuis le {fmtDate(info.readyAt)}</span>
        ) : null}
      </h2>
      {error && <div className="nc-error">{error}</div>}

      {!order.isGarage && (
        <div className="sav-order-top">
          <label className="od-field">
            <span className="od-label">Promis au client pour le</span>
            <input className="od-input" type="date" value={promised} onChange={(e) => setPromised(e.target.value)} />
            {info?.promiseRevisedDate && info.promiseRevisedDate !== info.promisedDate && (
              <span className="sav-promise sav-promise--late">Décalé au {fmtDate(info.promiseRevisedDate)} (retard fournisseur)</span>
            )}
            {promiseLate && <span className="sav-promise sav-promise--late">Date dépassée : le client a-t-il été prévenu ?</span>}
          </label>
          <label className="od-field">
            <span className="od-label">Casier de retrait</span>
            <input className="od-input sav-casier-input" value={casier} onChange={(e) => setCasier(e.target.value.toUpperCase())} placeholder="B12" maxLength={8} />
          </label>
          <div className="od-field">
            <span className="od-label">Pose &amp; rappels</span>
            <p className="sav-sub">
              {info?.garagePoseurName ? `Posée par ${info.garagePoseurName}` : "Garage poseur non précisé"}
              {" · "}
              {info?.clientOptOut ? "client désinscrit des rappels" : info?.clientConsent ? "accepte les rappels SMS" : "pas de consentement aux rappels"}
            </p>
          </div>
        </div>
      )}

      <div className="rl-table-wrap">
        <table className="rl-table sav-table">
          <thead>
            <tr>
              <th>Pièce</th>
              <th>Marque</th>
              <th>N° de série</th>
              <th>Garantie</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const s = info?.lines.get(l.id);
              const start = s?.handedOverAt ?? info?.deliveredAt ?? info?.orderDate ?? order.date;
              const w = lineWarranty({ start, warrantyMonths: s?.warrantyMonths, extensionMonths: s?.extensionMonths });
              const existing = info?.cases.find((c) => c.orderLineId === l.id);
              return (
                <tr key={l.id}>
                  <td>
                    <p className="rl-client">{l.designation}</p>
                    <p className="sav-sub">{l.reference} · {familyLabel(s?.famille)}</p>
                    {existing && (
                      <Link
                        href={`/dashboard/sav/${existing.id}`}
                        className={`rt-badge rt-badge--${clientStatusTone(existing.clientStatus)}`}
                        title={`${CASE_TYPE_LABEL[existing.type]} — ${CLIENT_STATUS_LABEL[existing.clientStatus]}`}
                      >
                        {existing.ref} · {CLIENT_STATUS_LABEL[existing.clientStatus]}
                      </Link>
                    )}
                  </td>
                  <td>
                    <input className="od-input" value={marques[l.id] ?? ""} onChange={(e) => setMarques((m) => ({ ...m, [l.id]: e.target.value }))} placeholder="Bosch…" aria-label={`Marque — ${l.designation}`} />
                  </td>
                  <td>
                    <input className="od-input" value={serials[l.id] ?? ""} onChange={(e) => setSerials((m) => ({ ...m, [l.id]: e.target.value }))} placeholder="Scan ou saisie" aria-label={`N° de série — ${l.designation}`} />
                  </td>
                  <td>
                    <WarrantyLight warranty={w} compact />
                    {s?.warrantyMonths ? <p className="sav-sub">équipementier {s.warrantyMonths} mois</p> : null}
                  </td>
                  <td className="od-td-right">
                    <div className="sav-order-acts">
                      {photos[l.id] ? (
                        <a className="od-btn od-btn--ghost" href={photos[l.id]} target="_blank" rel="noreferrer" title="Voir la photo prise a la reception" aria-label="Voir la photo">
                          <Camera className="h-4 w-4" />
                        </a>
                      ) : (
                        <button
                          type="button"
                          className="od-btn od-btn--ghost"
                          disabled={busy !== null}
                          title="Photo de la piece a la reception (jointe au message WhatsApp)"
                          aria-label="Ajouter une photo"
                          onClick={() => {
                            photoLine.current = l.id;
                            photoInput.current?.click();
                          }}
                        >
                          {busy === `photo:${l.id}` ? <Loader2 className="h-4 w-4 nc-spin" /> : <Camera className="h-4 w-4" />}
                        </button>
                      )}
                      {existing ? (
                        <Link href={`/dashboard/sav/${existing.id}`} className="od-btn od-btn--ghost" title="Ouvrir le dossier" aria-label="Ouvrir le dossier">
                          <ExternalLink className="h-4 w-4" />
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="od-btn od-btn--outline"
                          title="Ouvrir un dossier garantie ou litige pour cette piece"
                          aria-label="Ouvrir un dossier"
                          onClick={() =>
                            setPreset({
                              type: "GARANTIE",
                              orderLineId: l.id,
                              orderId: order.id,
                              designation: l.designation,
                              reference: l.reference,
                              immatriculation: order.plate,
                              serialNumber: serials[l.id] || null,
                              garagePoseur: info?.garagePoseurName ?? (order.isGarage ? order.clientName : null),
                              kmMontage: order.kilometrage,
                              clientName: order.clientName,
                              orderRef: order.ref,
                              warranty: w,
                            })
                          }
                        >
                          <ShieldCheck className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={(e) => void uploadPhoto(e.target.files?.[0])} />

      <div className="sav-flow-foot">
        <span className="sav-sub">Garantie légale : 24 mois à compter de la délivrance. Le magasin porte la garantie, même quand le fournisseur traîne.</span>
        <button type="button" className="od-btn od-btn--outline" disabled={busy !== null || !info} onClick={() => void save()}>
          {busy === "save" ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />} Enregistrer
        </button>
      </div>

      {messages.length > 0 && (
        <div className="sav-order-messages">
          <p className="od-label">
            <MessageSquareText className="h-4 w-4" /> Messages au client
          </p>
          <ul>
            {messages.map((m) => (
              <li key={m.id}>
                <strong>{m.kind ? QUEUED_SMS_LABEL[m.kind as QueuedSmsKind] ?? m.kind : "Commande prête"}</strong>
                <span className="sav-sub">
                  {m.status === "ENVOYE"
                    ? `${m.simulated ? "simulé" : "envoyé"} le ${fmtDateTime(m.sentAt ?? m.createdAt)}`
                    : m.status === "A_ENVOYER"
                      ? `en file pour le ${fmtDateTime(m.scheduledFor)}`
                      : m.error?.startsWith("OBSOLETE")
                        ? "devenu inutile"
                        : "non parti"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <OpenCaseDialog preset={preset} onClose={() => setPreset(null)} onCreated={(id) => router.push(`/dashboard/sav/${id}`)} />
    </section>
  );
}
