"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Check, ChevronDown, Info, Loader2, Plus, Printer, Trash2, X, Zap } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useAuth } from "@/components/providers/AuthProvider";
import { OrderTicket } from "@/components/print/OrderTicket";
import { matchClientByPhone } from "@/lib/data/clients";
import { createOrderWithLines } from "@/lib/data/orders";
import { PAYMENT_MODE_LABEL, PAYMENT_MODES } from "@/lib/data/payments";
import { finalizeOrderSav, type SavSettings } from "@/lib/data/sav";
import {
  createClientRecord,
  loadClients,
  type ClientOption,
  type GarageSummary,
  type OrganizationSettings,
  type SupplierOption,
} from "@/lib/data/saas";
import {
  emptyQuickRow,
  eur,
  isQuickRowFilled,
  parseMoney,
  printTicketDoc,
  quickReglements,
  quickRowProblem,
  quickRowTotal,
  REGLEMENT_LABEL,
  todayISO,
  type QuickPourQui,
  type QuickResult,
  type QuickRow,
  type Reglement,
} from "@/lib/order-form";
import { RETURN_CONDITIONS_TEXT } from "@/lib/return-conditions";
import type { CreateOrderPayload } from "@/lib/types/api";

/*
 * « Rajout rapide » of the Nouvelle commande page: several parts typed in a
 * modal, ONE standalone order per row, then a screen with each order's ticket.
 * The page keeps the state through useQuickAdd and shows QuickAddModal /
 * QuickAddDone; the ticket screen replaces the page while it is open.
 */

export function useQuickAdd({
  supabase,
  clients,
  garages,
  savSettings,
  onClientsChanged,
}: {
  supabase: SupabaseClient;
  clients: ClientOption[];
  garages: GarageSummary[];
  savSettings: SavSettings | null;
  /** The client list after a run (it may have created counter clients). */
  onClientsChanged: (clients: ClientOption[]) => void;
}) {
  const { user, profile } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [rows, setRows] = useState<QuickRow[]>([{ ...emptyQuickRow }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Orders already created by a run that stopped half-way (a retry adds the rest). */
  const [pending, setPending] = useState<QuickResult[]>([]);
  /** Ticket screen shown once the quick orders are created. */
  const [done, setDone] = useState<QuickResult[] | null>(null);
  const [ticketIdx, setTicketIdx] = useState(0);

  const open = useCallback(() => {
    setRows([{ ...emptyQuickRow }]);
    setError(null);
    setPending([]);
    setIsOpen(true);
  }, []);

  // The top bar opens this page with ?rajout=1 straight into the quick-add modal.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("rajout") !== "1") return;
    const id = window.setTimeout(open, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  /** Closing the modal after a run that stopped half-way still shows the tickets of the orders created. */
  const close = useCallback(() => {
    if (saving) return;
    setIsOpen(false);
    if (pending.length > 0) {
      setDone(pending);
      setPending([]);
      setTicketIdx(0);
    }
  }, [saving, pending]);

  const patchRow = useCallback((idx: number, patch: Partial<QuickRow>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }, []);
  const setRow = useCallback(
    (idx: number, field: keyof QuickRow, value: string | number | boolean) => patchRow(idx, { [field]: value }),
    [patchRow],
  );
  const addRow = useCallback(() => setRows((prev) => [...prev, { ...emptyQuickRow }]), []);
  const removeRow = useCallback(
    (idx: number) => setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx))),
    [],
  );

  // Rajout rapide creates ONE standalone order per row: each row carries its
  // own client/garage, price and règlement, so it cannot share the single-client
  // main form. Rows are inserted straight into the database.
  const submit = useCallback(async () => {
    const filled = rows.filter(isQuickRowFilled);
    if (filled.length === 0) return;
    // A half-filled row is never skipped silently: say what is missing.
    const problems = rows
      .map((r, i) => {
        if (!isQuickRowFilled(r)) return null;
        const missing = quickRowProblem(r);
        return missing ? `Pièce ${i + 1} : indiquez ${missing}.` : null;
      })
      .filter(Boolean);
    if (problems.length > 0) {
      setError(problems.join(" "));
      return;
    }

    const {
      data: { user: liveUser },
    } = await supabase.auth.getUser();
    const userId = liveUser?.id ?? user?.id;
    if (!userId) {
      setError("Session expirée. Reconnectez-vous puis réessayez.");
      return;
    }
    if (!profile?.organization_id) {
      setError("Aucun magasin associé à ce compte.");
      return;
    }
    const orgId = profile.organization_id;

    setSaving(true);
    setError(null);
    const results: QuickResult[] = [];
    let failedAt = -1;
    let failure = "";
    // Particuliers are recognised by phone, as in the main form; a client created
    // by an earlier row of this run is reused by the next ones.
    const accountIds = new Set(garages.map((g) => g.id));
    const particuliers: { id: string; phone: string | null }[] = clients.filter((c) => !accountIds.has(c.id));
    for (let k = 0; k < filled.length; k++) {
      const r = filled[k];
      try {
        // Resolve the client for this quick order.
        let clientIdForOrder: string | undefined;
        let phoneForOrder = "-";
        let who = "Réappro stock";
        let termsDays = 30;
        const forStock = r.pourQui === "STOCK";
        if (forStock) {
          // Restock order: no client, the part goes on the shelf on reception.
        } else if (r.pourQui === "GARAGE" || r.pourQui === "PRO") {
          const account = garages.find((g) => g.id === r.garageId);
          clientIdForOrder = r.garageId;
          phoneForOrder = account?.phone ?? "-";
          who = account?.name ?? "Client";
          termsDays = account?.paymentTermsDays ?? 30;
        } else {
          phoneForOrder = r.clientPhone.trim() || "-";
          who = r.clientName.trim();
          const existing = matchClientByPhone(particuliers, r.clientPhone);
          if (existing) {
            clientIdForOrder = existing.id;
          } else {
            const created = await createClientRecord(supabase, orgId, {
              name: r.clientName.trim(),
              phone: r.clientPhone.trim(),
            });
            clientIdForOrder = created.id;
            particuliers.push({ id: created.id, phone: r.clientPhone.trim() });
          }
        }

        const qty = r.qty || 1;
        const unit = forStock ? 0 : parseMoney(r.price);
        const total = forStock ? 0 : quickRowTotal(r);
        const reglement: Reglement | null = forStock
          ? null
          : r.pourQui === "GARAGE"
            ? "EN_COMPTE"
            : r.reglement || "NON_PAYEE";
        const mode = reglement === "PAYEE" && r.mode ? r.mode : null;
        const paid = reglement === "PAYEE" ? total : 0;
        const statut = paid > 0 && paid >= total ? "PAYÉ" : "NON_PAYÉ";
        const taken = !forStock && !r.fournisseur && r.clientAPris;

        const payload: CreateOrderPayload = {
          date_commande: todayISO(),
          canal_vente: "MAGASIN",
          client_id: clientIdForOrder,
          client_phone: phoneForOrder,
          lines: [
            {
              nom_produit: r.ref.trim(),
              reference: r.ref.trim(),
              fournisseur_id: r.fournisseur || undefined,
              quantity: qty,
              a_commander_pour_livreur: Boolean(r.fournisseur),
              depuis_magasin: forStock || !r.fournisseur,
              retour_impossible: r.retoursImpossible,
              consigne: r.consigne,
              consigne_price: r.consigne ? r.consignePrice || 0 : undefined,
              qte_remise: taken ? qty : 0,
              prix_achat_unitaire: 0,
              prix_brut_unitaire: unit,
              prix_vente_unitaire: unit,
            },
          ],
          devis: false,
          statut_paiement: statut,
          mode_paiement: reglement === "EN_COMPTE" ? "EN_COMPTE" : (mode ?? undefined),
          montant_paye: paid,
          avance_payee: 0,
          // Client / garage rows go straight to the delivery flow; a stock
          // replenishment has nothing to deliver.
          envoyer_au_livreur: !forStock,
          statut_livreur: "EN_ATTENTE",
          bl: false,
          // A stock replenishment has no client; shown as "Réappro stock".
          is_restock: forStock,
        };
        const order = await createOrderWithLines(supabase, userId, orgId, payload);
        if (!forStock) void finalizeOrderSav(supabase, order.id).catch(() => {});

        results.push({
          ref: order.ref_demande,
          who,
          total,
          reglementLabel:
            reglement === "PAYEE" && mode
              ? `Payée · ${PAYMENT_MODE_LABEL[mode]}`
              : reglement
                ? REGLEMENT_LABEL[reglement]
                : "",
          ticket: forStock
            ? null
            : {
                ref: order.ref_demande,
                createdAt: new Date().toISOString(),
                vendeur: profile.display_name || null,
                tourName: order.tourName || null,
                deliveryAt: order.deliveryAt,
                clientName: who,
                clientPhone: phoneForOrder !== "-" ? phoneForOrder : null,
                plate: null,
                vehicleModel: null,
                kilometrage: null,
                lines: [
                  {
                    reference: r.ref.trim(),
                    designation: r.ref.trim(),
                    quantity: qty,
                    prixVente: unit,
                    retourPossible: !r.retoursImpossible,
                    taken,
                  },
                ],
                total,
                avoirApplique: 0,
                paye: paid,
                reste: Math.max(0, total - paid),
                statutPaiement: statut,
                modePaiement: reglement === "EN_COMPTE" ? "EN_COMPTE" : mode,
                echeance:
                  reglement === "EN_COMPTE"
                    ? new Date(Date.now() + termsDays * 86_400_000).toISOString().slice(0, 10)
                    : null,
                promisedDate: null,
                returnPolicy: savSettings?.returnPolicyText || RETURN_CONDITIONS_TEXT,
                consigneDeadline:
                  savSettings && r.consigne
                    ? new Date(Date.now() + savSettings.consigneClientDays * 86_400_000).toISOString().slice(0, 10)
                    : null,
              },
        });
      } catch (err) {
        failedAt = k;
        failure = err instanceof Error ? err.message : "Erreur lors de la création de la commande.";
        break;
      }
    }

    setSaving(false);
    void loadClients(supabase, orgId).then(onClientsChanged).catch(() => {});
    if (failedAt >= 0) {
      // Rows already created leave the modal: a retry never creates them twice.
      setRows(filled.slice(failedAt));
      setPending((prev) => [...prev, ...results]);
      setError(
        results.length > 0
          ? `${results.map((x) => x.ref).join(", ")} créée(s). La pièce suivante n'a pas pu être créée : ${failure}`
          : failure,
      );
      return;
    }
    setIsOpen(false);
    setRows([{ ...emptyQuickRow }]);
    setDone([...pending, ...results]);
    setPending([]);
    setTicketIdx(0);
  }, [
    rows,
    pending,
    supabase,
    user?.id,
    profile,
    garages,
    clients,
    savSettings,
    onClientsChanged,
  ]);

  /** Show that order's ticket (only one is on screen), then print it. */
  const printTicket = useCallback(
    (idx: number) => {
      const t = done?.[idx]?.ticket;
      if (!t) return;
      flushSync(() => setTicketIdx(idx));
      printTicketDoc(t.ref);
    },
    [done],
  );

  /** Leave the ticket screen, back to the main form. */
  const dismissDone = useCallback(() => setDone(null), []);

  return {
    isOpen,
    open,
    close,
    rows,
    saving,
    error,
    done,
    ticketIdx,
    setTicketIdx,
    patchRow,
    setRow,
    addRow,
    removeRow,
    submit,
    printTicket,
    dismissDone,
  };
}

export type QuickAddState = ReturnType<typeof useQuickAdd>;

/** Ticket screen once the quick orders are created: it replaces the page. */
export function QuickAddDone({ quick, orgSettings }: { quick: QuickAddState; orgSettings: OrganizationSettings | null }) {
  const done = quick.done ?? [];
  const shown = done[quick.ticketIdx]?.ticket ?? null;
  return (
    <div className="od-page">
      <div className="od-card nc-success">
        <span className="nc-success-icon">
          <Check className="h-8 w-8" />
        </span>
        <h2 className="nc-success-title">Rajout rapide enregistré</h2>
        <p className="nc-success-sub">
          {done.length === 1 ? (
            <>
              La commande <strong>{done[0].ref}</strong> a été créée.
            </>
          ) : (
            `${done.length} commandes créées.`
          )}
        </p>
        <ul className="nc-quick-done">
          {done.map((q, i) => (
            <li key={q.ref} className={q.ticket && i === quick.ticketIdx ? "is-shown" : undefined}>
              <button
                type="button"
                className="nc-quick-done-main"
                onClick={() => q.ticket && quick.setTicketIdx(i)}
                disabled={!q.ticket}
                title={q.ticket ? "Afficher le ticket" : undefined}
              >
                <strong>{q.ref}</strong>
                <span>
                  {q.who}
                  {q.ticket ? ` · ${eur(q.total)} · ${q.reglementLabel}` : ""}
                </span>
              </button>
              {q.ticket ? (
                <button type="button" className="od-btn od-btn--primary" onClick={() => quick.printTicket(i)}>
                  <Printer className="h-4 w-4" />
                  Imprimer le ticket
                </button>
              ) : (
                <span className="nc-quick-done-none">Pas de ticket</span>
              )}
            </li>
          ))}
        </ul>
        <div className="nc-success-actions">
          <button
            type="button"
            className="od-btn od-btn--ghost"
            onClick={() => {
              quick.dismissDone();
              quick.open();
            }}
          >
            <Zap className="h-4 w-4" />
            Nouveau rajout rapide
          </button>
          <button type="button" className="od-btn od-btn--ghost" onClick={quick.dismissDone}>
            <Plus className="h-4 w-4" />
            Nouvelle commande
          </button>
          <Link href="/dashboard" className="od-btn od-btn--ghost">
            Retour au tableau de bord
          </Link>
        </div>
      </div>
      {shown && (
        <div className="tk-preview">
          <OrderTicket org={orgSettings} data={shown} />
        </div>
      )}
    </div>
  );
}

/** The modal: one block per part, each with its own client, price and règlement. */
export function QuickAddModal({
  quick,
  suppliers,
  garages,
}: {
  quick: QuickAddState;
  suppliers: SupplierOption[];
  garages: GarageSummary[];
}) {
  const { rows, saving, error, close, patchRow, setRow, addRow, removeRow, submit } = quick;
  return (
    <div className="ga-modal-overlay" onClick={close}>
      <div className="ga-modal ga-modal--wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="ga-modal-head">
          <span className="ga-modal-title">
            <Zap className="h-4 w-4" style={{ verticalAlign: "-2px", marginRight: 6 }} />
            Rajout rapide
          </span>
          <button type="button" className="ga-modal-close" onClick={close} aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="ga-modal-form">
          {rows.map((row, idx) => (
            <div className="nc-quick-row" key={idx}>
              <div className="nc-quick-row-head">
                <span className="nc-quick-row-num">Pièce {idx + 1}</span>
                <button
                  type="button"
                  className="od-icon-btn"
                  onClick={() => removeRow(idx)}
                  disabled={rows.length === 1}
                  aria-label="Supprimer la pièce"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              <div className="od-field">
                <span className="od-label">Référence / Désignation <span className="od-req">*</span></span>
                <input
                  className="od-input"
                  placeholder="GDB1322 — Plaquette de frein"
                  value={row.ref}
                  autoFocus={idx === rows.length - 1}
                  onChange={(e) => setRow(idx, "ref", e.target.value)}
                />
              </div>

              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Quantité</span>
                  <input
                    className="od-input"
                    type="number"
                    min={1}
                    value={row.qty || ""}
                    onChange={(e) => setRow(idx, "qty", Number(e.target.value))}
                  />
                </div>
                <div className="od-field">
                  <span className="od-label">
                    Fournisseur{row.pourQui === "STOCK" ? <span className="od-req"> *</span> : ""}
                  </span>
                  <div className="od-select">
                    <select value={row.fournisseur} onChange={(e) => setRow(idx, "fournisseur", e.target.value)}>
                      <option value="">Stock magasin</option>
                      {suppliers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
              </div>

              <div className="ga-modal-row">
                <div className="od-field">
                  <span className="od-label">Pour qui</span>
                  <div className="od-select">
                    <select
                      value={row.pourQui}
                      onChange={(e) => {
                        const pourQui = e.target.value as QuickPourQui;
                        // The account and the règlement picked before do not follow to another destination.
                        patchRow(idx, {
                          pourQui,
                          garageId: "",
                          reglement: pourQui === "GARAGE" ? "EN_COMPTE" : "",
                          mode: "",
                        });
                      }}
                    >
                      <option value="COMPTOIR">Client comptoir</option>
                      <option value="GARAGE">Garage</option>
                      <option value="PRO">Client PRO</option>
                      <option value="STOCK">Stock magasin</option>
                    </select>
                    <ChevronDown className="h-4 w-4" />
                  </div>
                </div>
                {(row.pourQui === "GARAGE" || row.pourQui === "PRO") && (
                  <div className="od-field">
                    <span className="od-label">{row.pourQui === "PRO" ? "Client PRO" : "Garage"} <span className="od-req">*</span></span>
                    <div className="od-select">
                      <select value={row.garageId} onChange={(e) => setRow(idx, "garageId", e.target.value)}>
                        <option value="">{row.pourQui === "PRO" ? "— Choisir un client PRO —" : "— Choisir un garage —"}</option>
                        {garages.filter((g) => g.kind === row.pourQui).map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                            {g.city ? ` · ${g.city}` : ""}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="h-4 w-4" />
                    </div>
                    {garages.filter((g) => g.kind === row.pourQui).length === 0 && (
                      <span className="nc-hint" style={{ marginTop: 6 }}>
                        <Info className="h-3.5 w-3.5" />
                        {row.pourQui === "PRO" ? "Aucun client PRO enregistré." : "Aucun garage enregistré."}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {row.pourQui === "STOCK" && (
                <span className="nc-hint" style={{ marginTop: 6 }}>
                  <Info className="h-3.5 w-3.5" />
                  Commande pour le stock du magasin : choisissez le fournisseur ; la pièce sera à ranger en stock à la réception.
                </span>
              )}

              {row.pourQui === "COMPTOIR" && (
                <div className="ga-modal-row">
                  <div className="od-field">
                    <span className="od-label">Nom complet <span className="od-req">*</span></span>
                    <input
                      className="od-input"
                      placeholder="Jean Dupont"
                      value={row.clientName}
                      onChange={(e) => setRow(idx, "clientName", e.target.value)}
                    />
                  </div>
                  <div className="od-field">
                    <span className="od-label">Téléphone <span className="od-req">*</span></span>
                    <input
                      className="od-input"
                      placeholder="06 12 34 56 78"
                      value={row.clientPhone}
                      onChange={(e) => setRow(idx, "clientPhone", e.target.value)}
                    />
                  </div>
                </div>
              )}

              {row.pourQui !== "STOCK" && (
                <>
                  <div className="ga-modal-row">
                    <div className="od-field">
                      <span className="od-label">Prix de vente unitaire TTC <span className="od-req">*</span></span>
                      <div className="nc-pay-input">
                        <input
                          className="od-input nc-pay-amount"
                          inputMode="decimal"
                          placeholder="0,00"
                          value={row.price}
                          aria-invalid={row.price.trim() !== "" && !(parseMoney(row.price) > 0)}
                          onChange={(e) => setRow(idx, "price", e.target.value)}
                        />
                        <span className="nc-pay-unit">€</span>
                      </div>
                      {parseMoney(row.price) > 0 && (
                        <span className="st-cmd-hint">
                          Total {eur(quickRowTotal(row))}
                          {(row.qty || 1) > 1 ? ` (${row.qty} × ${eur(parseMoney(row.price))})` : ""}
                          {row.consigne && row.consignePrice > 0 ? " consigne comprise" : ""}
                        </span>
                      )}
                    </div>
                    <div className="od-field">
                      <span className="od-label">Règlement <span className="od-req">*</span></span>
                      <div className="nc-pay-quick" role="radiogroup" aria-label={`Règlement de la pièce ${idx + 1}`}>
                        {quickReglements(row.pourQui).map((r) => (
                          <button
                            key={r}
                            type="button"
                            role="radio"
                            aria-checked={row.reglement === r}
                            className={`nc-chip${row.reglement === r ? " nc-chip--on" : ""}${r === "EN_COMPTE" ? " nc-chip--account" : ""}`}
                            onClick={() => patchRow(idx, { reglement: r, mode: r === "PAYEE" ? row.mode : "" })}
                          >
                            {REGLEMENT_LABEL[r]}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  {row.reglement === "PAYEE" && (
                    <div className="od-field">
                      <span className="od-label">Mode de paiement <span className="od-req">*</span></span>
                      <div className="nc-pay-quick" role="radiogroup" aria-label={`Mode de paiement de la pièce ${idx + 1}`}>
                        {PAYMENT_MODES.map((m) => (
                          <button
                            key={m}
                            type="button"
                            role="radio"
                            aria-checked={row.mode === m}
                            className={`nc-chip${row.mode === m ? " nc-chip--on" : ""}`}
                            onClick={() => setRow(idx, "mode", m)}
                          >
                            {PAYMENT_MODE_LABEL[m]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="od-field">
                <span className="od-label">Actions</span>
                <label className="nc-check">
                  <input
                    type="checkbox"
                    checked={row.retoursImpossible}
                    onChange={(e) => setRow(idx, "retoursImpossible", e.target.checked)}
                  />
                  Retours impossible
                </label>
                <label className="nc-check">
                  <input type="checkbox" checked={row.consigne} onChange={(e) => setRow(idx, "consigne", e.target.checked)} />
                  Consigne
                </label>
                {!row.fournisseur && row.pourQui !== "STOCK" && (
                  <label className="nc-check">
                    <input
                      type="checkbox"
                      checked={row.clientAPris}
                      onChange={(e) => setRow(idx, "clientAPris", e.target.checked)}
                    />
                    Client a pris
                  </label>
                )}
                {row.consigne && (
                  <input
                    className="od-input nc-consigne-price"
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Montant consigne €"
                    value={row.consignePrice || ""}
                    onChange={(e) => setRow(idx, "consignePrice", Number(e.target.value))}
                  />
                )}
              </div>
            </div>
          ))}

          <button type="button" className="nc-add-line" onClick={addRow}>
            <Plus className="h-4 w-4" />
            Ajouter une pièce
          </button>

          {error && <div className="nc-error">{error}</div>}

          <div className="ga-modal-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={close} disabled={saving}>
              Annuler
            </button>
            <button
              type="button"
              className="od-btn od-btn--primary"
              onClick={() => void submit()}
              disabled={saving || !rows.some(isQuickRowFilled)}
            >
              {saving ? <Loader2 className="h-4 w-4 nc-spin" /> : <Plus className="h-4 w-4" />}
              {saving
                ? "Création…"
                : (() => {
                    const n = rows.filter(isQuickRowFilled).length;
                    return `Créer ${n > 1 ? `${n} commandes` : "la commande"}`;
                  })()}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
