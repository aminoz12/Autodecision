"use client";

import {
  Ban,
  Banknote,
  Check,
  Clock,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Wallet,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Toast } from "@/components/ui/Toast";
import { createClient } from "@/lib/supabase/client";
import {
  createWalkInReturn,
  fmtDate,
  fmtMoney,
  loadRefundableOrders,
  loadReturns,
  settleClientReturn,
  updateReturnTreatment,
  type RefundableOrder,
  type ReturnRow,
  type ReturnTreatment,
} from "@/lib/data/saas";

const TREATMENT_LABEL: Record<string, string> = {
  A_TRAITER: "À traiter",
  DEMANDE_ENVOYEE: "Demande envoyée",
  A_RECUPERER: "À récupérer",
  ACCEPTE: "Accepté",
  REFUSE: "Refusé",
  REMBOURSE: "Remboursé",
  AVOIR: "Avoir émis",
};

const FILTER_CHIPS: { id: string; label: string }[] = [
  { id: "TOUS", label: "Tous" },
  { id: "A_TRAITER", label: "À traiter" },
  { id: "DEMANDE_ENVOYEE", label: "Demande envoyée" },
  { id: "A_RECUPERER", label: "À récupérer" },
  { id: "ACCEPTE", label: "Acceptés" },
  { id: "REFUSE", label: "Refusés" },
  { id: "REMBOURSE", label: "Remboursés" },
  { id: "AVOIR", label: "Avoirs" },
];

/** Next steps of the supplier-return pipeline, keyed by current treatment. */
const NEXT_STEPS: Record<
  string,
  { to: ReturnTreatment; label: string; cls: string }[]
> = {
  A_TRAITER: [{ to: "DEMANDE_ENVOYEE", label: "Envoyer la demande", cls: "send" }],
  DEMANDE_ENVOYEE: [{ to: "A_RECUPERER", label: "À récupérer", cls: "pickup" }],
  A_RECUPERER: [
    { to: "ACCEPTE", label: "Accepté", cls: "accept" },
    { to: "REFUSE", label: "Refusé", cls: "refuse" },
  ],
  ACCEPTE: [{ to: "REMBOURSE", label: "Remboursé", cls: "accept" }],
};

function treatmentTone(status: string) {
  if (status === "ACCEPTE" || status === "REMBOURSE" || status === "AVOIR") return "green";
  if (status === "REFUSE") return "red";
  if (status === "DEMANDE_ENVOYEE") return "blue";
  if (status === "A_RECUPERER") return "violet";
  return "amber";
}

export default function RetoursPage() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ---- Table filters & row actions ---- */
  const [tableSearch, setTableSearch] = useState("");
  const [treatFilter, setTreatFilter] = useState("TOUS");
  const [actingId, setActingId] = useState<string | null>(null);

  /* ---- Walk-in refund modal ---- */
  const [modalOpen, setModalOpen] = useState(false);
  const [refundOrders, setRefundOrders] = useState<RefundableOrder[]>([]);
  const [refundLoading, setRefundLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [compensation, setCompensation] = useState<"REMBOURSEMENT" | "AVOIR">("REMBOURSEMENT");
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /* ---- Settle a client return: refund or avoir ---- */
  const [settle, setSettle] = useState<{ row: ReturnRow; mode: "REMBOURSEMENT" | "AVOIR" } | null>(null);
  const [settleAmount, setSettleAmount] = useState("");
  const [settleReason, setSettleReason] = useState("");
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  const openSettle = useCallback((row: ReturnRow, mode: "REMBOURSEMENT" | "AVOIR") => {
    setSettle({ row, mode });
    setSettleAmount(String(row.amount > 0 ? row.amount : row.lineValue > 0 ? row.lineValue : ""));
    setSettleReason("");
    setSettleError(null);
  }, []);

  const load = useCallback(async () => {
    if (!profile?.organization_id) return;
    setLoading(true);
    setError(null);
    try {
      const sb = createClient();
      setRows(await loadReturns(sb, profile.organization_id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [profile?.organization_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = useCallback(
    async (row: ReturnRow, to: ReturnTreatment) => {
      if (!profile?.organization_id) return;
      setActingId(row.id);
      setError(null);
      try {
        const sb = createClient();
        await updateReturnTreatment(sb, profile.organization_id, row.id, to);
        setRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, treatment: to } : r)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setActingId(null);
      }
    },
    [profile?.organization_id],
  );

  const submitSettle = useCallback(async () => {
    if (!settle) return;
    const amount = Number(String(settleAmount).replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      setSettleError("Indiquez le montant remboursé au client.");
      return;
    }
    setSettleBusy(true);
    setSettleError(null);
    try {
      const sb = createClient();
      const avoirNum = await settleClientReturn(sb, settle.row.id, {
        mode: settle.mode,
        amount,
        reason: settleReason,
      });
      setNotice(
        settle.mode === "AVOIR"
          ? `Avoir ${avoirNum ?? ""} de ${fmtMoney(amount)} émis pour ${settle.row.client} (valable 1 an).`
          : `${fmtMoney(amount)} remboursés à ${settle.row.client}.`,
      );
      setSettle(null);
      await load();
    } catch (e) {
      setSettleError(e instanceof Error ? e.message : String(e));
    } finally {
      setSettleBusy(false);
    }
  }, [settle, settleAmount, settleReason, load]);

  const visibleRows = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    return rows.filter((row) => {
      if (treatFilter !== "TOUS" && row.treatment !== treatFilter) return false;
      if (!q) return true;
      return [row.ref, row.supplier, row.client, row.reference, row.reason]
        .some((v) => v.toLowerCase().includes(q));
    });
  }, [rows, tableSearch, treatFilter]);

  const chipCounts = useMemo(() => {
    const counts = new Map<string, number>([["TOUS", rows.length]]);
    for (const row of rows) {
      counts.set(row.treatment, (counts.get(row.treatment) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const openModal = useCallback(async () => {
    setModalOpen(true);
    setSearch("");
    setSelectedOrderId(null);
    setSelectedLineIds(new Set());
    setReason("");
    setCompensation("REMBOURSEMENT");
    setModalError(null);
    setNotice(null);
    if (!profile?.organization_id) return;
    setRefundLoading(true);
    try {
      const sb = createClient();
      setRefundOrders(await loadRefundableOrders(sb, profile.organization_id));
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefundLoading(false);
    }
  }, [profile?.organization_id]);

  const selectedOrder = useMemo(
    () => refundOrders.find((o) => o.id === selectedOrderId) ?? null,
    [refundOrders, selectedOrderId],
  );

  const filteredOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return refundOrders;
    return refundOrders.filter(
      (o) =>
        o.ref.toLowerCase().includes(q) || o.client.toLowerCase().includes(q),
    );
  }, [refundOrders, search]);

  const refundTotal = useMemo(() => {
    if (!selectedOrder) return 0;
    return selectedOrder.lines
      .filter((l) => selectedLineIds.has(l.id))
      .reduce((s, l) => s + l.lineTotal, 0);
  }, [selectedOrder, selectedLineIds]);

  const pickOrder = useCallback((order: RefundableOrder) => {
    setSelectedOrderId(order.id);
    // Pre-select every refundable line.
    setSelectedLineIds(
      new Set(
        order.lines
          .filter((l) => !l.retourImpossible && !l.alreadyReturned)
          .map((l) => l.id),
      ),
    );
  }, []);

  const toggleLine = useCallback((lineId: string) => {
    setSelectedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }, []);

  const submitRefund = useCallback(async () => {
    if (!profile?.organization_id || !selectedOrder) return;
    const lines = selectedOrder.lines.filter((l) => selectedLineIds.has(l.id));
    if (lines.length === 0) {
      setModalError("Sélectionnez au moins une ligne à rembourser.");
      return;
    }
    setSubmitting(true);
    setModalError(null);
    try {
      const sb = createClient();
      const { avoirNum } = await createWalkInReturn(sb, profile.organization_id, {
        orderId: selectedOrder.id,
        clientId: selectedOrder.clientId,
        reason,
        lines,
        compensation,
      });
      setNotice(
        avoirNum
          ? `Avoir ${avoirNum} créé — valable 1 an, utilisable sur une prochaine commande.`
          : null,
      );
      setModalOpen(false);
      await load();
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [profile?.organization_id, selectedOrder, selectedLineIds, reason, compensation, load]);

  const stats = useMemo(() => {
    const byStatus = (status: string) => rows.filter((row) => row.treatment === status).length;
    const sum = (status: string) => rows.filter((r) => r.treatment === status).reduce((s, r) => s + r.amount, 0);
    const open = rows.filter((r) => !["REMBOURSE", "AVOIR", "REFUSE"].includes(r.treatment)).length;
    return [
      { label: "À traiter", value: String(open), icon: Clock, color: "#983705", bg: "#FCEDB9" },
      { label: `Remboursés (${byStatus("REMBOURSE")})`, value: fmtMoney(sum("REMBOURSE")), icon: Banknote, color: "#0E6245", bg: "#D7F7C2" },
      { label: `Avoirs émis (${byStatus("AVOIR")})`, value: fmtMoney(sum("AVOIR")), icon: FileText, color: "#4B2FD8", bg: "#EEEDFF" },
      { label: "Total retours", value: String(rows.length), icon: RotateCcw, color: "#0055BC", bg: "#D6ECFF" },
    ];
  }, [rows]);

  return (
    <>
    <div className="rt-layout">
      <div className="rt-main">
        <header className="rt-header">
          <div className="rt-title-wrap">
            <span className="rt-title-icon"><RotateCcw className="h-6 w-6" /></span>
            <div>
              <h1 className="rt-title rl-title--upper">Retours &amp; <span className="nc-title-accent">remboursements</span></h1>
              <p className="rt-subtitle">Pièces rendues par les clients et garages, suivi des retours fournisseur et des remboursements.</p>
            </div>
          </div>
          <div className="rt-header-actions">
            <button type="button" className="od-btn od-btn--ghost" onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              Actualiser
            </button>
            <button type="button" className="od-btn od-btn--primary" onClick={() => void openModal()}>
              <Plus className="h-4 w-4" />
              Nouveau retour / remboursement
            </button>
          </div>
        </header>

        {error && <p className="stat-change" style={{ color: "var(--clr-danger)" }}>{error}</p>}
        <Toast message={notice} onClose={() => setNotice(null)} duration={8000} />

        <div className="rt-stats">
          {stats.map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.label} className="rt-stat">
                <span className="rt-stat-icon" style={{ background: stat.bg, color: stat.color }}><Icon className="h-5 w-5" /></span>
                <p className="rt-stat-value">{stat.value}</p>
                <p className="rt-stat-label">{stat.label}</p>
              </div>
            );
          })}
        </div>

        <section className="od-card rt-table-card">
          <div className="rt-filterbar">
            <div className="rt-search">
              <Search className="h-4 w-4" />
              <input
                className="od-input"
                placeholder="Rechercher (ref, fournisseur, client, motif)…"
                value={tableSearch}
                onChange={(e) => setTableSearch(e.target.value)}
              />
            </div>
            <div className="rt-chips">
              {FILTER_CHIPS.map((chip) => {
                const count = chipCounts.get(chip.id) ?? 0;
                if (chip.id !== "TOUS" && count === 0) return null;
                return (
                  <button
                    key={chip.id}
                    type="button"
                    className={`rt-chip${treatFilter === chip.id ? " rt-chip--active" : ""}`}
                    onClick={() => setTreatFilter(chip.id)}
                  >
                    {chip.label}
                    <span className="rt-chip-count">{count}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="rt-table-wrap">
            <table className="rt-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Commande</th>
                  <th>Client / Garage</th>
                  <th>Pièce</th>
                  <th>Motif</th>
                  <th>Type</th>
                  <th>Traitement</th>
                  <th className="rl-th-center">Montant</th>
                  <th className="rl-th-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => {
                  const steps = NEXT_STEPS[row.treatment] ?? [];
                  const busy = actingId === row.id;
                  return (
                    <tr key={row.id}>
                      <td className="rt-cell-date">{fmtDate(row.createdAt)}</td>
                      <td className="rt-cell-ref">
                        {row.orderId ? <Link href={`/dashboard/commandes/${row.orderId}`} className="rc-cmd">{row.ref}</Link> : row.ref}
                      </td>
                      <td>
                        {row.clientId && !row.isGarage ? (
                          <Link href={`/dashboard/clients/${row.clientId}`} className="av-client-link">{row.client}</Link>
                        ) : (
                          <span className="rl-client">{row.client}</span>
                        )}
                        {row.isGarage && <span className="rc-type rc-type--garage rc-type--inline">Garage</span>}
                        {row.hasSupplier && <p className="rl-muted">Retour fournisseur · {row.supplier}</p>}
                      </td>
                      <td className="rt-cell-motif" title={row.reference}>{row.reference}</td>
                      <td className="rt-cell-motif" title={row.reason}>{row.reason}</td>
                      <td><span className={`rt-badge rt-badge--${row.type === "RETOURNABLE" ? "green" : "red"}`}>{row.type === "RETOURNABLE" ? "Retournable" : row.type === "NON_RETOURNABLE" ? "Non retournable" : row.type}</span></td>
                      <td><span className={`rt-badge rt-badge--${treatmentTone(row.treatment)}`}>{TREATMENT_LABEL[row.treatment] ?? row.treatment}</span></td>
                      <td className="rt-decote">{row.amount > 0 ? fmtMoney(row.amount) : <span className="rl-muted">—</span>}</td>
                      <td>
                        {!row.hasSupplier && !["REMBOURSE", "AVOIR", "REFUSE"].includes(row.treatment) ? (
                          <div className="rt-acts">
                            <button type="button" className="rc-act rc-act--recu" onClick={() => openSettle(row, "REMBOURSEMENT")}>
                              <Banknote className="h-3.5 w-3.5" /> Rembourser
                            </button>
                            <button type="button" className="rc-act rc-act--retour" onClick={() => openSettle(row, "AVOIR")}>
                              <FileText className="h-3.5 w-3.5" /> Avoir
                            </button>
                          </div>
                        ) : steps.length === 0 || !row.hasSupplier ? (
                          <span className="rt-dash">—</span>
                        ) : busy ? (
                          <Loader2 className="h-4 w-4 nc-spin" />
                        ) : (
                          <div className="rt-acts">
                            {steps.map((step) => (
                              <button
                                key={step.to}
                                type="button"
                                className={`rt-act rt-act--${step.cls}`}
                                disabled={actingId !== null}
                                onClick={() => void act(row, step.to)}
                              >
                                {step.label}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!loading && visibleRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="rc-empty-cell">
                      {rows.length === 0 ? "Aucun retour." : "Aucun retour ne correspond au filtre."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="av-foot">
            <span className="av-foot-count">{visibleRows.length} résultat(s)</span>
          </div>
        </section>

      </div>
    </div>

    {settle && (
      <div className="ga-modal-overlay" onClick={() => !settleBusy && setSettle(null)}>
        <div className="ga-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
          <div className="ga-modal-head">
            <span className="ga-modal-title">
              {settle.mode === "AVOIR" ? <FileText className="h-4 w-4" /> : <Banknote className="h-4 w-4" />}
              {settle.mode === "AVOIR" ? "Émettre un avoir" : "Rembourser le client"}
            </span>
            <button type="button" className="ga-modal-close" onClick={() => setSettle(null)} aria-label="Fermer" disabled={settleBusy}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="ga-modal-form">
            {settleError && <div className="nc-error">{settleError}</div>}
            <div className="rt-picked">
              <div>
                <p className="rt-order-ref">{settle.row.ref} · {settle.row.client}</p>
                <p className="rt-order-client">{settle.row.reference} — {settle.row.reason}</p>
              </div>
            </div>
            <div className="ga-modal-row">
              <div className="od-field">
                <span className="od-label">{settle.mode === "AVOIR" ? "Montant de l'avoir" : "Montant remboursé"} <span className="od-req">*</span></span>
                <div className="nc-pay-input">
                  <input className="od-input nc-pay-amount" type="number" min={0} step="0.01" value={settleAmount} onChange={(e) => setSettleAmount(e.target.value)} autoFocus />
                  <span className="nc-pay-unit">€</span>
                </div>
                {settle.row.lineValue > 0 && (
                  <span className="st-cmd-hint">Valeur de la pièce sur la commande : {fmtMoney(settle.row.lineValue)}.</span>
                )}
              </div>
              <div className="od-field">
                <span className="od-label">Motif</span>
                <input className="od-input" value={settleReason} onChange={(e) => setSettleReason(e.target.value)} placeholder={settle.row.reason} />
              </div>
            </div>
            <div className="od-note">
              <Wallet className="h-4 w-4" />
              <p>
                {settle.mode === "AVOIR"
                  ? "Un avoir valable 1 an est créé pour ce client ; il pourra le déduire sur une prochaine commande."
                  : "Le client est remboursé en caisse : le retour passe en « Remboursé »."}
              </p>
            </div>
            <div className="ga-modal-actions">
              <button type="button" className="od-btn od-btn--ghost" onClick={() => setSettle(null)} disabled={settleBusy}>Annuler</button>
              <button type="button" className="od-btn od-btn--primary" onClick={() => void submitSettle()} disabled={settleBusy}>
                {settleBusy ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                {settle.mode === "AVOIR" ? "Émettre l'avoir" : "Valider le remboursement"}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {modalOpen && (
      <div className="ga-modal-overlay" onClick={() => !submitting && setModalOpen(false)}>
        <div
          className="ga-modal ga-modal--wide"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ga-modal-head">
            <span className="ga-modal-title">
              <RotateCcw className="h-4 w-4" style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Retour / remboursement comptoir
            </span>
            <button
              type="button"
              className="ga-modal-close"
              onClick={() => setModalOpen(false)}
              aria-label="Fermer"
              disabled={submitting}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="ga-modal-form">
            {modalError && <div className="nc-error">{modalError}</div>}

            {!selectedOrder ? (
              <>
                <div className="od-field">
                  <span className="od-label">Rechercher une commande</span>
                  <div className="rt-search">
                    <Search className="h-4 w-4" />
                    <input
                      className="od-input"
                      placeholder="Référence ou client…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>
                {refundLoading ? (
                  <p className="text-muted">Chargement des commandes…</p>
                ) : (
                  <div className="rt-order-list">
                    {filteredOrders.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        className="rt-order-item"
                        onClick={() => pickOrder(o)}
                      >
                        <span className="rt-order-ref">{o.ref}</span>
                        <span className="rt-order-client">{o.client}</span>
                        <span className="rt-order-meta">
                          {fmtDate(o.date)} · {fmtMoney(o.total)}
                        </span>
                      </button>
                    ))}
                    {filteredOrders.length === 0 && (
                      <p className="text-muted">Aucune commande trouvée.</p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="rt-picked">
                  <div>
                    <p className="rt-order-ref">{selectedOrder.ref}</p>
                    <p className="rt-order-client">{selectedOrder.client}</p>
                  </div>
                  <button
                    type="button"
                    className="od-btn od-btn--ghost"
                    onClick={() => setSelectedOrderId(null)}
                  >
                    Changer
                  </button>
                </div>

                <div className="rt-line-list">
                  {selectedOrder.lines.map((l) => {
                    const blocked = l.retourImpossible || l.alreadyReturned;
                    return (
                      <label
                        key={l.id}
                        className={`rt-line-item${blocked ? " rt-line-item--blocked" : ""}`}
                      >
                        <input
                          type="checkbox"
                          disabled={blocked}
                          checked={selectedLineIds.has(l.id)}
                          onChange={() => toggleLine(l.id)}
                        />
                        <span className="rt-line-desc">
                          <strong>{l.designation || l.reference}</strong>
                          <em>
                            {l.reference} · {l.quantity}× {fmtMoney(l.unitPrice)}
                          </em>
                        </span>
                        {l.retourImpossible ? (
                          <span className="rt-badge rt-badge--red">
                            <Ban className="h-3.5 w-3.5" /> Retour impossible
                          </span>
                        ) : l.alreadyReturned ? (
                          <span className="rt-badge rt-badge--blue">Déjà remboursé</span>
                        ) : (
                          <span className="rt-line-amount">{fmtMoney(l.lineTotal)}</span>
                        )}
                      </label>
                    );
                  })}
                </div>

                <div className="od-field">
                  <span className="od-label">Motif du remboursement</span>
                  <input
                    className="od-input"
                    placeholder="Pièce non utilisée, erreur de référence…"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>

                <div className="od-field">
                  <span className="od-label">Compensation</span>
                  <div className="od-toggle-group">
                    <button
                      type="button"
                      className={`od-toggle${compensation === "REMBOURSEMENT" ? " od-toggle--on" : ""}`}
                      onClick={() => setCompensation("REMBOURSEMENT")}
                    >
                      <Banknote className="h-5 w-5" />
                      <span>
                        <strong>Remboursement</strong>
                        <em>Le client est remboursé immédiatement</em>
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`od-toggle${compensation === "AVOIR" ? " od-toggle--on" : ""}`}
                      onClick={() => setCompensation("AVOIR")}
                    >
                      <FileText className="h-5 w-5" />
                      <span>
                        <strong>Avoir</strong>
                        <em>Bon d&apos;achat valable 1 an</em>
                      </span>
                    </button>
                  </div>
                </div>

                <div className="rt-refund-total">
                  {compensation === "AVOIR" ? "Montant de l'avoir" : "Montant remboursé"}{" "}
                  <strong>{fmtMoney(refundTotal)}</strong>
                </div>
              </>
            )}

            <div className="ga-modal-actions">
              <button
                type="button"
                className="od-btn od-btn--ghost"
                onClick={() => setModalOpen(false)}
                disabled={submitting}
              >
                Annuler
              </button>
              <button
                type="button"
                className="od-btn od-btn--primary"
                onClick={() => void submitRefund()}
                disabled={submitting || !selectedOrder || selectedLineIds.size === 0}
              >
                {submitting ? <Loader2 className="h-4 w-4 nc-spin" /> : <Check className="h-4 w-4" />}
                {submitting
                  ? "Enregistrement…"
                  : compensation === "AVOIR"
                    ? "Émettre l'avoir"
                    : "Valider le remboursement"}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
