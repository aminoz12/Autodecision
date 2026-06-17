"use client";

import {
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Package,
  Plus,
  ShoppingCart,
  Trash2,
  Truck,
  Upload,
  User,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { createOrderWithLines } from "@/lib/data/orders";
import {
  createClientRecord,
  loadClients,
  loadSupplierOptions,
  type ClientOption,
  type SupplierOption,
} from "@/lib/data/saas";
import type { CreateOrderPayload } from "@/lib/types/api";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CANAUX = ["MAGASIN", "TÉLÉPHONE", "INTERNET", "B2B", "AUTRE"] as const;
const PAIEMENTS = [
  { value: "NON_PAYÉ", label: "Non payé" },
  { value: "PARTIEL", label: "Partiel" },
  { value: "PAYÉ", label: "Payé" },
] as const;

const NEW_CLIENT = "__new__";

interface LineForm {
  nom_produit: string;
  reference: string;
  fournisseur_id: string;
  quantity: number;
  prix_achat: number;
  prix_vente: number;
}

const emptyLine: LineForm = {
  nom_produit: "",
  reference: "",
  fournisseur_id: "",
  quantity: 1,
  prix_achat: 0,
  prix_vente: 0,
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function eur(value: number): string {
  return `${value.toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} €`;
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

export default function NouvelleCommandePage() {
  const { user, profile } = useAuth();
  const supabase = useMemo(() => createClient(), []);

  const [clients, setClients] = useState<ClientOption[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);

  /* ---- Client ---- */
  const [clientId, setClientId] = useState<string>(NEW_CLIENT);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [immatriculation, setImmatriculation] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");

  /* ---- Document ---- */
  const [dateCommande, setDateCommande] = useState(todayISO());
  const [canalVente, setCanalVente] = useState<string>("MAGASIN");

  /* ---- Lines ---- */
  const [lines, setLines] = useState<LineForm[]>([{ ...emptyLine }]);

  /* ---- Payment & delivery ---- */
  const [statutPaiement, setStatutPaiement] = useState<string>("NON_PAYÉ");
  const [montantPaye, setMontantPaye] = useState(0);
  const [avancePayee, setAvancePayee] = useState(0);
  const [envoyerAuLivreur, setEnvoyerAuLivreur] = useState(false);

  /* ---- Status ---- */
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRef, setCreatedRef] = useState<string | null>(null);
  const [createdTour, setCreatedTour] = useState<{ name: string; deliveryAt: string | null } | null>(null);

  /* ---- PDF auto-fill ---- */
  const fileRef = useRef<HTMLInputElement>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfInfo, setPdfInfo] = useState<string | null>(null);

  /* ---- Load reference data ---- */
  useEffect(() => {
    if (!profile?.organization_id) return;
    let cancelled = false;
    const orgId = profile.organization_id;
    Promise.all([loadClients(supabase, orgId), loadSupplierOptions(supabase, orgId)])
      .then(([cls, sups]) => {
        if (cancelled) return;
        setClients(cls);
        setSuppliers(sups);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, profile?.organization_id]);

  /* ---- Pick an existing client → prefill snapshot fields ---- */
  const pickClient = useCallback(
    (value: string) => {
      setClientId(value);
      if (value === NEW_CLIENT) return;
      const c = clients.find((x) => x.id === value);
      if (!c) return;
      setClientName(c.name);
      setClientPhone(c.phone ?? "");
      setClientEmail(c.email ?? "");
      setImmatriculation(c.immatriculation ?? "");
      setVehicleModel(c.vehicleModel ?? "");
    },
    [clients],
  );

  /* ---- Line helpers ---- */
  const setLine = useCallback(
    (idx: number, field: keyof LineForm, value: string | number) => {
      setLines((prev) =>
        prev.map((l, i) => (i === idx ? { ...l, [field]: value } : l)),
      );
    },
    [],
  );
  const addLine = useCallback(
    () => setLines((prev) => [...prev, { ...emptyLine }]),
    [],
  );
  const removeLine = useCallback(
    (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx)),
    [],
  );

  /* ---- Money ---- */
  const total = useMemo(
    () => lines.reduce((s, l) => s + l.quantity * l.prix_vente, 0),
    [lines],
  );
  const remaining = Math.max(0, total - montantPaye - avancePayee);

  /* ---- PDF auto-fill: parse an uploaded bon de commande ---- */
  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPdfBusy(true);
    setError(null);
    setPdfInfo(null);
    try {
      const { extractOrderFromPdf } = await import("@/lib/pdf/order-pdf");
      const parsed = await extractOrderFromPdf(file);
      if (parsed.filled.length === 0) {
        setError(
          "Aucune donnée reconnue dans ce PDF. Vérifiez qu'il contient bien un bon de commande avec du texte (pas un scan image).",
        );
        return;
      }
      if (parsed.clientName) {
        const existing = clients.find(
          (c) =>
            c.name.trim().toLowerCase() ===
            parsed.clientName!.trim().toLowerCase(),
        );
        setClientId(existing?.id ?? NEW_CLIENT);
        setClientName(parsed.clientName);
      }
      if (parsed.phone) setClientPhone(parsed.phone);
      if (parsed.email) setClientEmail(parsed.email);
      if (parsed.plate) setImmatriculation(parsed.plate);
      if (parsed.vehicle) setVehicleModel(parsed.vehicle);
      if (parsed.date) setDateCommande(parsed.date);
      if (parsed.canal) setCanalVente(parsed.canal);
      if (parsed.lines.length > 0) {
        // Fournisseur is intentionally not read from the PDF.
        setLines(
          parsed.lines.map((l) => ({
            nom_produit: l.designation,
            reference: l.reference,
            fournisseur_id: "",
            quantity: l.quantity,
            prix_achat: l.prixAchat,
            prix_vente: l.prixVente,
          })),
        );
      }
      setPdfInfo(`PDF lu — rempli : ${parsed.filled.join(", ")}.`);
    } catch (err) {
      setError(
        err instanceof Error
          ? `Lecture du PDF impossible : ${err.message}`
          : "Lecture du PDF impossible.",
      );
    } finally {
      setPdfBusy(false);
    }
  }

  /* ---- Submit ---- */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Resolve the user live from Supabase — the context `user` can lag behind
    // a valid session right after navigation, which previously surfaced a
    // misleading "Utilisateur non connecté." on submit.
    const {
      data: { user: liveUser },
    } = await supabase.auth.getUser();
    const userId = liveUser?.id ?? user?.id;
    if (!userId) {
      setError("Session expirée. Reconnectez-vous puis réessayez.");
      return;
    }
    if (!profile?.organization_id) {
      setError(
        "Aucun magasin associé à ce compte (profil introuvable). Reconnectez-vous ou contactez l'administrateur.",
      );
      return;
    }
    if (!clientName.trim()) {
      setError("Renseignez le nom du client.");
      return;
    }
    const validLines = lines.filter(
      (l) => l.nom_produit.trim() && l.reference.trim(),
    );
    if (validLines.length === 0) {
      setError(
        "Ajoutez au moins une pièce avec une désignation et une référence.",
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const orgId = profile.organization_id;

      // Resolve the client id — create a new client record if needed.
      let resolvedClientId: string | undefined =
        clientId === NEW_CLIENT ? undefined : clientId;
      if (!resolvedClientId) {
        const created = await createClientRecord(supabase, orgId, {
          name: clientName,
          phone: clientPhone,
          email: clientEmail,
          immatriculation,
          vehicleModel,
        });
        resolvedClientId = created.id;
      }

      const payload: CreateOrderPayload = {
        date_commande: dateCommande || todayISO(),
        canal_vente: canalVente,
        client_id: resolvedClientId,
        client_phone: clientPhone.trim() || "-",
        client_email: clientEmail.trim() || undefined,
        immatriculation: immatriculation.trim() || undefined,
        vehicle_model: vehicleModel.trim() || undefined,
        lines: validLines.map((l) => ({
          nom_produit: l.nom_produit.trim(),
          reference: l.reference.trim(),
          fournisseur_id: l.fournisseur_id || undefined,
          quantity: l.quantity || 1,
          a_commander_pour_livreur: Boolean(l.fournisseur_id),
          depuis_magasin: !l.fournisseur_id,
          prix_achat_unitaire: l.prix_achat || 0,
          prix_vente_unitaire: l.prix_vente || 0,
        })),
        devis: false,
        statut_paiement: statutPaiement,
        montant_paye: montantPaye || 0,
        avance_payee: avancePayee || 0,
        envoyer_au_livreur: envoyerAuLivreur,
        statut_livreur: "EN_ATTENTE",
        bl: false,
      };

      const order = await createOrderWithLines(
        supabase,
        userId,
        orgId,
        payload,
      );
      setCreatedRef(order.ref_demande);
      setCreatedTour({ name: order.tourName, deliveryAt: order.deliveryAt });
      // Refresh client list in case a new one was created.
      void loadClients(supabase, orgId).then(setClients).catch(() => {});
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Erreur lors de la création de la commande.",
      );
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setClientId(NEW_CLIENT);
    setClientName("");
    setClientPhone("");
    setClientEmail("");
    setImmatriculation("");
    setVehicleModel("");
    setDateCommande(todayISO());
    setCanalVente("MAGASIN");
    setLines([{ ...emptyLine }]);
    setStatutPaiement("NON_PAYÉ");
    setMontantPaye(0);
    setAvancePayee(0);
    setEnvoyerAuLivreur(false);
    setError(null);
    setCreatedRef(null);
    setCreatedTour(null);
  }

  /* ---------------------------------------------------------------- */
  /*  Success screen                                                   */
  /* ---------------------------------------------------------------- */

  if (createdRef) {
    return (
      <div className="od-page">
        <div className="od-card nc-success">
          <span className="nc-success-icon">
            <Check className="h-8 w-8" />
          </span>
          <h2 className="nc-success-title">Commande créée</h2>
          <p className="nc-success-sub">
            La commande <strong>{createdRef}</strong> a bien été enregistrée.
          </p>
          {createdTour?.deliveryAt && (
            <p className="nc-success-tour">
              <Truck className="h-4 w-4" />
              {createdTour.name} — livraison prévue le{" "}
              {new Date(createdTour.deliveryAt).toLocaleString("fr-FR", {
                weekday: "long",
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </p>
          )}
          <div className="nc-success-actions">
            <button
              type="button"
              className="od-btn od-btn--primary"
              onClick={resetForm}
            >
              <Plus className="h-4 w-4" />
              Nouvelle commande
            </button>
            <Link href="/dashboard" className="od-btn od-btn--ghost">
              Retour au tableau de bord
            </Link>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Form                                                             */
  /* ---------------------------------------------------------------- */

  return (
    <form className="od-page" onSubmit={handleSubmit}>
      {/* Breadcrumb + title */}
      <nav className="od-breadcrumb">
        <Link href="/dashboard">Tableau de bord</Link>
        <span className="od-breadcrumb-sep">
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
        <span className="od-breadcrumb-current">Nouvelle commande</span>
      </nav>

      <div className="od-title-row">
        <div>
          <h1 className="od-title">
            <ShoppingCart className="h-6 w-6" style={{ color: "#22C55E" }} />
            Nouvelle commande client
          </h1>
          <div className="od-meta">
            <span className="od-meta-item">
              <Calendar className="h-4 w-4" />
              {new Date(dateCommande || todayISO()).toLocaleDateString("fr-FR")}
            </span>
          </div>
        </div>
        <div className="od-title-actions">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={handlePdfUpload}
          />
          <button
            type="button"
            className="od-btn od-btn--ghost"
            onClick={() => fileRef.current?.click()}
            disabled={pdfBusy}
          >
            {pdfBusy ? (
              <Loader2 className="h-4 w-4 nc-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {pdfBusy ? "Lecture du PDF…" : "Nouvelle Commande"}
          </button>
          <Link href="/dashboard" className="od-btn od-btn--ghost">
            Annuler
          </Link>
          <button
            type="submit"
            className="od-btn od-btn--primary"
            disabled={saving}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 nc-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {saving ? "Enregistrement…" : "Enregistrer la commande"}
          </button>
        </div>
      </div>

      {error && <div className="nc-error">{error}</div>}
      {pdfInfo && <div className="nc-ok">{pdfInfo}</div>}

      {/* ---- Client ---- */}
      <section className="od-card">
        <div className="od-card-title">
          <User className="h-4 w-4" />
          Client
        </div>
        <div className="nc-grid">
          <div className="od-field nc-col-2">
            <span className="od-label">Client existant</span>
            <div className="od-select">
              <select
                value={clientId}
                onChange={(e) => pickClient(e.target.value)}
              >
                <option value={NEW_CLIENT}>— Nouveau client —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.immatriculation ? ` · ${c.immatriculation}` : ""}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
          <div className="od-field nc-col-2">
            <span className="od-label">Nom du client *</span>
            <input
              className="od-input"
              placeholder="GARAGE MARTIN"
              value={clientName}
              onChange={(e) => {
                setClientName(e.target.value);
                if (clientId !== NEW_CLIENT) setClientId(NEW_CLIENT);
              }}
            />
          </div>
          <div className="od-field">
            <span className="od-label">Téléphone</span>
            <input
              className="od-input"
              placeholder="01 23 45 67 89"
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
            />
          </div>
          <div className="od-field">
            <span className="od-label">Email</span>
            <input
              className="od-input"
              type="email"
              placeholder="contact@garage.fr"
              value={clientEmail}
              onChange={(e) => setClientEmail(e.target.value)}
            />
          </div>
          <div className="od-field">
            <span className="od-label">Immatriculation</span>
            <input
              className="od-input"
              placeholder="AA-123-BB"
              value={immatriculation}
              onChange={(e) => setImmatriculation(e.target.value)}
            />
          </div>
          <div className="od-field">
            <span className="od-label">Véhicule</span>
            <input
              className="od-input"
              placeholder="Renault Master"
              value={vehicleModel}
              onChange={(e) => setVehicleModel(e.target.value)}
            />
          </div>
        </div>
        {clientId === NEW_CLIENT && clientName.trim() && (
          <p className="nc-hint">
            <Info className="h-3.5 w-3.5" />
            Ce client sera enregistré dans votre fichier clients.
          </p>
        )}
      </section>

      {/* ---- Document ---- */}
      <section className="od-card">
        <div className="od-card-title">
          <Calendar className="h-4 w-4" />
          Informations
        </div>
        <div className="nc-grid">
          <div className="od-field">
            <span className="od-label">Date de commande</span>
            <input
              className="od-input"
              type="date"
              value={dateCommande}
              onChange={(e) => setDateCommande(e.target.value)}
            />
          </div>
          <div className="od-field">
            <span className="od-label">Canal de vente</span>
            <div className="od-select">
              <select
                value={canalVente}
                onChange={(e) => setCanalVente(e.target.value)}
              >
                {CANAUX.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
        </div>
      </section>

      {/* ---- Lines ---- */}
      <section className="od-card">
        <div className="od-card-title">
          <Package className="h-4 w-4" />
          Pièces
        </div>
        <div className="od-table-wrap">
          <table className="od-table nc-lines">
            <thead>
              <tr>
                <th>Désignation</th>
                <th>Référence</th>
                <th>Fournisseur</th>
                <th className="od-th-center">Qté</th>
                <th className="od-th-right">Prix achat</th>
                <th className="od-th-right">Prix vente</th>
                <th className="od-th-right">Total</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={idx}>
                  <td>
                    <input
                      className="od-input nc-cell-input"
                      placeholder="Plaquette de frein"
                      value={l.nom_produit}
                      onChange={(e) =>
                        setLine(idx, "nom_produit", e.target.value)
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="od-input nc-cell-input nc-cell-ref"
                      placeholder="GDB1322"
                      value={l.reference}
                      onChange={(e) =>
                        setLine(idx, "reference", e.target.value)
                      }
                    />
                  </td>
                  <td>
                    <div className="od-select nc-cell-select">
                      <select
                        value={l.fournisseur_id}
                        onChange={(e) =>
                          setLine(idx, "fournisseur_id", e.target.value)
                        }
                      >
                        <option value="">Stock magasin</option>
                        {suppliers.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="h-4 w-4" />
                    </div>
                  </td>
                  <td className="od-td-center">
                    <input
                      className="od-input nc-cell-input nc-cell-num"
                      type="number"
                      min={1}
                      value={l.quantity || ""}
                      onChange={(e) =>
                        setLine(idx, "quantity", Number(e.target.value))
                      }
                    />
                  </td>
                  <td className="od-td-right">
                    <input
                      className="od-input nc-cell-input nc-cell-num"
                      type="number"
                      min={0}
                      step="0.01"
                      value={l.prix_achat || ""}
                      onChange={(e) =>
                        setLine(idx, "prix_achat", Number(e.target.value))
                      }
                    />
                  </td>
                  <td className="od-td-right">
                    <input
                      className="od-input nc-cell-input nc-cell-num"
                      type="number"
                      min={0}
                      step="0.01"
                      value={l.prix_vente || ""}
                      onChange={(e) =>
                        setLine(idx, "prix_vente", Number(e.target.value))
                      }
                    />
                  </td>
                  <td className="od-td-right od-num od-num-strong">
                    {eur(l.quantity * l.prix_vente)}
                  </td>
                  <td className="od-td-menu">
                    <button
                      type="button"
                      className="od-icon-btn"
                      onClick={() => removeLine(idx)}
                      disabled={lines.length === 1}
                      aria-label="Supprimer la ligne"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button type="button" className="nc-add-line" onClick={addLine}>
          <Plus className="h-4 w-4" />
          Ajouter une pièce
        </button>

        <div className="od-lines-total">
          Total commande <strong>{eur(total)}</strong>
        </div>
      </section>

      {/* ---- Payment & delivery ---- */}
      <section className="od-card">
        <div className="od-card-title">Paiement &amp; livraison</div>
        <div className="nc-grid">
          <div className="od-field">
            <span className="od-label">Statut du paiement</span>
            <div className="od-select">
              <select
                value={statutPaiement}
                onChange={(e) => setStatutPaiement(e.target.value)}
              >
                {PAIEMENTS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
          <div className="od-field">
            <span className="od-label">Montant payé</span>
            <input
              className="od-input"
              type="number"
              min={0}
              step="0.01"
              value={montantPaye || ""}
              onChange={(e) => setMontantPaye(Number(e.target.value))}
            />
          </div>
          <div className="od-field">
            <span className="od-label">Avance</span>
            <input
              className="od-input"
              type="number"
              min={0}
              step="0.01"
              value={avancePayee || ""}
              onChange={(e) => setAvancePayee(Number(e.target.value))}
            />
          </div>
          <div className="od-field">
            <span className="od-label">Reste à payer</span>
            <input
              className="od-input nc-readonly"
              readOnly
              value={eur(remaining)}
            />
          </div>
        </div>

        <button
          type="button"
          className={`od-toggle nc-toggle${
            envoyerAuLivreur ? " od-toggle--on" : ""
          }`}
          onClick={() => setEnvoyerAuLivreur((v) => !v)}
        >
          <Truck className="h-5 w-5" />
          <span>
            <strong>Envoyer au livreur</strong>
            <em>Crée une tâche de livraison à préparer</em>
          </span>
        </button>
      </section>

      {/* ---- Footer actions ---- */}
      <div className="nc-footer">
        <button type="button" className="od-btn od-btn--ghost" onClick={resetForm}>
          Réinitialiser
        </button>
        <button
          type="submit"
          className="od-btn od-btn--primary"
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 nc-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {saving ? "Enregistrement…" : "Enregistrer la commande"}
        </button>
      </div>
    </form>
  );
}
