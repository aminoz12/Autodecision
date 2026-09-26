"use client";

import { AlarmClock, Camera, Check, Coins, Loader2, MessageSquareText, PackageCheck, RefreshCw, RotateCcw, Truck, Wallet, X } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import { fmtDate, fmtMoney } from "@/lib/data/saas";
import { loadConsignes, markConsigneReturned, reopenConsigne, type ConsigneRow } from "@/lib/data/consignes";
import {
  SavUnavailableError,
  consigneToSupplierReturn,
  notifyClient,
  returnConsigneCore,
  sendResultText,
  setConsigneSupplierStatus,
  uploadSavFile,
} from "@/lib/data/sav";
import { CONSIGNE_SUPPLIER_LABEL, CORE_STATE_LABEL, daysBetween, parisToday, parseDay } from "@/lib/sav";

const STATUS_CLASS: Record<string, string> = { ACTIF: "encours", RENDUE: "utilise" };
const STATUS_LABEL: Record<string, string> = { ACTIF: "À rapporter", RENDUE: "Cœur rendu" };
const SUPPLIER_TONE: Record<string, string> = { A_RENVOYER: "amber", RENVOYE: "blue", AVOIR_RECU: "green", REFUSE: "red" };

type Filter = "TOUTES" | "CLIENT" | "FOURNISSEUR" | "RISQUE";

/** Days until a date (negative = overdue); null without a date. */
function daysTo(date: string | null): number | null {
  const d = parseDay(date);
  return d ? daysBetween(parisToday(), d) : null;
}

export default function ConsignesPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<ConsigneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("TOUTES");

  // « Cœur rendu » : état constaté au comptoir (+ photo), puis « avoir consigne reçu ».
  const [coreRow, setCoreRow] = useState<ConsigneRow | null>(null);
  const [coreState, setCoreState] = useState("COMPLET");
  const [corePhoto, setCorePhoto] = useState<File | null>(null);
  const [creditRow, setCreditRow] = useState<ConsigneRow | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      setRows(await loadConsignes(createClient(), profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run an action on a row; before the SAV migration the simple « rendue » toggle still works. */
  const run = useCallback(
    async (row: ConsigneRow, action: () => Promise<string | void>) => {
      setBusyId(row.id);
      setError(null);
      try {
        const msg = await action();
        if (msg) setNotice(msg);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const submitCore = async () => {
    if (!coreRow || !profile?.organization_id) return;
    const row = coreRow;
    const orgId = profile.organization_id;
    setCoreRow(null);
    await run(row, async () => {
      const sb = createClient();
      try {
        const path = corePhoto ? await uploadSavFile(sb, orgId, `consignes/${row.id}`, corePhoto) : null;
        await returnConsigneCore(sb, row.id, coreState, path);
      } catch (e) {
        if (!(e instanceof SavUnavailableError)) throw e;
        await markConsigneReturned(sb, orgId, row.id);
      }
      return coreState === "COMPLET"
        ? "Cœur repris : caution à rendre au client."
        : `Cœur repris « ${CORE_STATE_LABEL[coreState]?.toLowerCase()} » : le fournisseur peut le refuser — c'est tracé.`;
    });
    setCorePhoto(null);
  };

  const submitCredit = async () => {
    if (!creditRow) return;
    const row = creditRow;
    const amount = Number(creditAmount.replace(",", "."));
    setCreditRow(null);
    await run(row, async () => {
      await setConsigneSupplierStatus(createClient(), row.id, "AVOIR_RECU", { creditAmount: Number.isFinite(amount) && amount > 0 ? amount : null });
      return "Avoir consigne enregistré : la boucle est fermée.";
    });
  };

  const totals = useMemo(() => {
    const active = rows.filter((r) => r.status === "ACTIF");
    const toSend = rows.filter((r) => r.supplierStatus === "A_RENVOYER" || r.supplierStatus === "RENVOYE");
    const atRisk = rows.filter((r) => r.supplierStatus === "A_RENVOYER" && (daysTo(r.supplierDeadline) ?? 99) <= 15);
    const sum = (list: ConsigneRow[]) => list.reduce((s, r) => s + r.amount, 0);
    return {
      held: sum(active),
      activeCount: active.length,
      lateClients: active.filter((r) => (daysTo(r.clientDeadline) ?? 1) < 0).length,
      supplier: sum(toSend),
      supplierCount: toSend.length,
      risk: sum(atRisk),
      riskCount: atRisk.length,
      credited: rows.reduce((s, r) => s + (r.supplierStatus === "AVOIR_RECU" ? r.supplierCreditAmount ?? r.amount : 0), 0),
    };
  }, [rows]);

  const visible = useMemo(
    () =>
      rows.filter((r) =>
        filter === "CLIENT"
          ? r.status === "ACTIF"
          : filter === "FOURNISSEUR"
            ? r.supplierStatus === "A_RENVOYER" || r.supplierStatus === "RENVOYE"
            : filter === "RISQUE"
              ? r.supplierStatus === "A_RENVOYER" && (daysTo(r.supplierDeadline) ?? 99) <= 15
              : true,
      ),
    [rows, filter],
  );

  return (
    <div className="rl-page">
      <header className="rl-header">
        <div className="rl-header-left">
          <h1 className="rl-title rl-title--upper">Consignes</h1>
          <p className="rl-subtitle">
            Deux boucles, deux délais : le client rapporte le vieux (caution rendue), puis le cœur repart chez le fournisseur avant sa date
            limite (avoir consigne). C&apos;est la seconde qui coûte le plus cher.
          </p>
        </div>
        <div className="rl-header-actions">
          <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            Actualiser
          </button>
        </div>
      </header>

      <div className="av-summary">
        <div className="av-sum-card av-sum-card--orange">
          <span className="av-sum-icon av-sum-icon--orange"><Wallet className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Consignes en cours (caution retenue)</p>
            <p className="av-sum-value av-sum-value--orange">{fmtMoney(totals.held)}</p>
            <p className="sav-sub">{totals.activeCount} pièce(s) à récupérer{totals.lateClients > 0 ? ` · ${totals.lateClients} hors délai` : ""}</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--blue">
          <span className="av-sum-icon av-sum-icon--blue"><Truck className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Cœurs à renvoyer au fournisseur</p>
            <p className="av-sum-value av-sum-value--blue">{fmtMoney(totals.supplier)}</p>
            <p className="sav-sub">{totals.supplierCount} cœur(s) au magasin ou en route</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--amber">
          <span className="av-sum-icon av-sum-icon--amber"><AlarmClock className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Dont délai fournisseur sous 15 jours</p>
            <p className="av-sum-value av-sum-value--amber">{fmtMoney(totals.risk)}</p>
            <p className="sav-sub">{totals.riskCount} cœur(s) — passé ce délai, la consigne est perdue</p>
          </div>
        </div>
        <div className="av-sum-card av-sum-card--green">
          <span className="av-sum-icon av-sum-icon--green"><Coins className="h-6 w-6" /></span>
          <div>
            <p className="av-sum-label">Avoirs consigne reçus</p>
            <p className="av-sum-value av-sum-value--green">{fmtMoney(totals.credited)}</p>
          </div>
        </div>
      </div>

      {error && <div className="nc-error">{error}</div>}
      <Toast message={notice} onClose={() => setNotice(null)} />

      <section className="od-card rl-table-card">
        <div className="sav-toolbar">
          <div className="lp-reasons" role="radiogroup" aria-label="Filtrer les consignes">
            {(
              [
                { id: "TOUTES", label: `Toutes · ${rows.length}` },
                { id: "CLIENT", label: `À rapporter par le client · ${totals.activeCount}` },
                { id: "FOURNISSEUR", label: `À renvoyer au fournisseur · ${totals.supplierCount}` },
                { id: "RISQUE", label: `Délai sous 15 j · ${totals.riskCount}` },
              ] as { id: Filter; label: string }[]
            ).map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={`nc-chip${filter === f.id ? " nc-chip--on" : ""}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="rl-table-wrap">
          <table className="rl-table av-table sav-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>N° Consigne</th>
                <th>Client</th>
                <th>Pièce</th>
                <th className="av-th-right">Caution</th>
                <th>Boucle client</th>
                <th>Boucle fournisseur</th>
                <th aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const clientLeft = row.status === "ACTIF" ? daysTo(row.clientDeadline) : null;
                const supplierLeft = row.supplierStatus === "A_RENVOYER" ? daysTo(row.supplierDeadline) : null;
                const busy = busyId === row.id;
                return (
                  <tr key={row.id}>
                    <td className="rl-muted-strong">{fmtDate(row.createdAt)}</td>
                    <td>
                      <span className="av-num av-num--consigne">{row.num}</span>
                      <p className="sav-sub">{row.orderRef ?? ""}</p>
                    </td>
                    <td><p className="rl-client">{row.client}</p></td>
                    <td>
                      <p className="av-motif">{row.description}</p>
                      <p className="sav-sub">{row.reference} · {row.quantity} pièce(s)</p>
                    </td>
                    <td className="av-th-right av-montant av-montant--consigne">{fmtMoney(row.amount)}</td>
                    <td>
                      <span className={`av-statut av-statut--${STATUS_CLASS[row.status] ?? "encours"}`}>{STATUS_LABEL[row.status] ?? row.status}</span>
                      {row.status === "ACTIF" && row.clientDeadline && (
                        <p className={`sav-promise${clientLeft != null && clientLeft <= 10 ? " sav-promise--late" : ""}`}>
                          {clientLeft != null && clientLeft < 0 ? `Délai dépassé depuis ${-clientLeft} j` : `À rapporter avant le ${fmtDate(row.clientDeadline)}`}
                        </p>
                      )}
                      {row.status === "RENDUE" && (
                        <p className="sav-sub">
                          {row.returnedAt ? `le ${fmtDate(row.returnedAt)}` : ""}
                          {row.coreState ? ` · ${CORE_STATE_LABEL[row.coreState]?.toLowerCase()}` : ""}
                          {row.hasCorePhoto ? " · photo" : ""}
                        </p>
                      )}
                    </td>
                    <td>
                      {row.supplierStatus ? (
                        <>
                          <span className={`rt-badge rt-badge--${SUPPLIER_TONE[row.supplierStatus] ?? "gray"}`}>{CONSIGNE_SUPPLIER_LABEL[row.supplierStatus]}</span>
                          <p className="sav-sub">
                            {row.supplierName ?? "Fournisseur"}
                            {row.supplierStatus === "AVOIR_RECU" && row.supplierCreditAmount != null ? ` · ${fmtMoney(row.supplierCreditAmount)}` : ""}
                          </p>
                          {row.supplierStatus === "A_RENVOYER" && row.supplierDeadline && (
                            <p className={`sav-promise${supplierLeft != null && supplierLeft <= 15 ? " sav-promise--late" : ""}`}>
                              {supplierLeft != null && supplierLeft < 0 ? `Délai dépassé depuis ${-supplierLeft} j` : `Avant le ${fmtDate(row.supplierDeadline)} (${supplierLeft} j)`}
                            </p>
                          )}
                          {row.returnId && row.supplierStatus === "A_RENVOYER" && (
                            <Link className="sav-sub sav-link" href="/dashboard/retours">Confié à la tournée →</Link>
                          )}
                        </>
                      ) : (
                        <span className="sav-sub">{row.status === "RENDUE" ? "Pièce du stock : rien à renvoyer" : "—"}</span>
                      )}
                    </td>
                    <td className="od-td-right">
                      <div className="rt-acts">
                        {busy && <Loader2 className="h-4 w-4 nc-spin" />}
                        {!busy && row.status === "ACTIF" && (
                          <>
                            <button
                              type="button"
                              className="rc-act rc-act--recu"
                              onClick={() => {
                                setCoreState("COMPLET");
                                setCorePhoto(null);
                                setCoreRow(row);
                              }}
                            >
                              <PackageCheck className="h-3.5 w-3.5" /> Cœur rendu
                            </button>
                            {row.clientId && (
                              <button
                                type="button"
                                className="rc-act rc-act--quiet"
                                title="SMS : « pensez à rapporter l'ancienne pièce »"
                                onClick={() => void run(row, async () => sendResultText(await notifyClient(createClient(), "CONSIGNE_REMINDER", row.id)))}
                              >
                                <MessageSquareText className="h-3.5 w-3.5" /> Rappeler
                              </button>
                            )}
                          </>
                        )}
                        {!busy && row.supplierStatus === "A_RENVOYER" && (
                          <>
                            {!row.returnId && (
                              <button
                                type="button"
                                className="rc-act rc-act--retour"
                                title="Crée le retour fournisseur : à confier au livreur depuis « Retours »"
                                onClick={() =>
                                  void run(row, async () => {
                                    await consigneToSupplierReturn(createClient(), row.id);
                                    return "Retour fournisseur créé : confiez-le au livreur depuis « Retours ».";
                                  })
                                }
                              >
                                <Truck className="h-3.5 w-3.5" /> Par la tournée
                              </button>
                            )}
                            <button type="button" className="rc-act rc-act--quiet" onClick={() => void run(row, async () => void (await setConsigneSupplierStatus(createClient(), row.id, "RENVOYE")))}>
                              Renvoyé
                            </button>
                          </>
                        )}
                        {!busy && row.supplierStatus === "RENVOYE" && (
                          <>
                            <button
                              type="button"
                              className="rc-act rc-act--recu"
                              onClick={() => {
                                setCreditAmount(String(row.amount || ""));
                                setCreditRow(row);
                              }}
                            >
                              <Coins className="h-3.5 w-3.5" /> Avoir reçu
                            </button>
                            <button type="button" className="rc-act rc-act--quiet" onClick={() => void run(row, async () => void (await setConsigneSupplierStatus(createClient(), row.id, "REFUSE")))}>
                              Cœur refusé
                            </button>
                          </>
                        )}
                        {!busy && row.status === "RENDUE" && (!row.supplierStatus || row.supplierStatus === "A_RENVOYER") && !row.returnId && (
                          <button
                            type="button"
                            className="rc-act rc-act--quiet"
                            title="Rendue par erreur"
                            onClick={() => profile?.organization_id && void run(row, () => reopenConsigne(createClient(), profile.organization_id, row.id))}
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Rouvrir
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={8} className="text-muted">{rows.length === 0 ? "Aucune consigne." : "Aucune consigne dans ce filtre."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="av-foot">
          <span className="av-foot-count">{visible.length} consigne(s)</span>
        </div>
      </section>

      {coreRow && (
        <div className="ga-modal-overlay" onClick={() => setCoreRow(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><PackageCheck className="h-4 w-4" /> Reprise du cœur — {coreRow.num}</span>
              <button type="button" className="ga-modal-close" onClick={() => setCoreRow(null)} aria-label="Fermer"><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              <p className="st-cmd-hint">{coreRow.description} · {coreRow.client} · caution {fmtMoney(coreRow.amount)}</p>
              <div className="od-field">
                <span className="od-label">État du cœur rendu</span>
                <div className="lp-reasons" role="radiogroup">
                  {Object.entries(CORE_STATE_LABEL).map(([code, label]) => (
                    <button key={code} type="button" role="radio" aria-checked={coreState === code} className={`nc-chip${coreState === code ? " nc-chip--on" : ""}`} onClick={() => setCoreState(code)}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {coreState !== "COMPLET" && (
                <p className="sav-hint sav-hint--warn">
                  Un cœur refusé par l&apos;équipementier revient au magasin, pas au client, s&apos;il n&apos;est pas tracé à la reprise. Prenez la photo.
                </p>
              )}
              <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden onChange={(e) => setCorePhoto(e.target.files?.[0] ?? null)} />
              <button type="button" className="od-btn od-btn--ghost" onClick={() => photoInput.current?.click()}>
                <Camera className="h-4 w-4" /> {corePhoto ? `Photo : ${corePhoto.name}` : "Photo du cœur au comptoir"}
              </button>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setCoreRow(null)}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitCore()}>
                  <Check className="h-4 w-4" /> Cœur repris, caution rendue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {creditRow && (
        <div className="ga-modal-overlay" onClick={() => setCreditRow(null)}>
          <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="ga-modal-head">
              <span className="ga-modal-title"><Coins className="h-4 w-4" /> Avoir consigne reçu — {creditRow.num}</span>
              <button type="button" className="ga-modal-close" onClick={() => setCreditRow(null)} aria-label="Fermer"><X className="h-4 w-4" /></button>
            </div>
            <div className="ga-modal-form">
              <p className="st-cmd-hint">{creditRow.description} · {creditRow.supplierName ?? "fournisseur"}</p>
              <label className="od-field">
                <span className="od-label">Montant de l&apos;avoir fournisseur (€)</span>
                <input className="od-input" inputMode="decimal" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} />
              </label>
              <div className="ga-modal-actions">
                <button type="button" className="od-btn od-btn--ghost" onClick={() => setCreditRow(null)}>Annuler</button>
                <button type="button" className="od-btn od-btn--primary" onClick={() => void submitCredit()}>
                  <Check className="h-4 w-4" /> Enregistrer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
