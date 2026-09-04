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
  Printer,
  ShoppingCart,
  Trash2,
  Send,
  Truck,
  Upload,
  User,
  X,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { createOrderWithLines } from "@/lib/data/orders";
import {
  createClientRecord,
  loadClientCredits,
  loadClients,
  loadGarages,
  loadOrganizationSettings,
  loadSupplierOptions,
  type ClientCredit,
  type ClientOption,
  type GarageSummary,
  type OrganizationSettings,
  type SupplierOption,
} from "@/lib/data/saas";
import { OrderTicket, type TicketData } from "@/components/print/OrderTicket";
import { matchClientByPhone } from "@/lib/data/clients";
import type { CreateOrderPayload } from "@/lib/types/api";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const CANAUX = ["MAGASIN", "TÉLÉPHONE", "INTERNET", "B2B", "AUTRE"] as const;
const PAIEMENT_LABEL: Record<string, { label: string; cls: string }> = {
  "PAYÉ": { label: "Payé", cls: "green" },
  PARTIEL: { label: "Acompte", cls: "amber" },
  "NON_PAYÉ": { label: "Non payé", cls: "red" },
};

const NEW_CLIENT = "__new__";

type PourQui = "COMPTOIR" | "GARAGE";
/** Rajout rapide can also order straight for the magasin stock. */
type QuickPourQui = PourQui | "STOCK";

interface LineForm {
  nom_produit: string;
  reference: string;
  fournisseur_id: string;
  quantity: number;
  prix_achat: number;
  prix_vente: number;
  retours_impossible?: boolean;
  consigne?: boolean;
  consigne_price?: number;
  /** Stock magasin line: the client took the part(s) right away. */
  client_a_pris?: boolean;
  pour_qui?: PourQui;
  garage_id?: string;
  comptoir_name?: string;
  comptoir_phone?: string;
}

const emptyLine: LineForm = {
  nom_produit: "",
  reference: "",
  fournisseur_id: "",
  quantity: 1,
  prix_achat: 0,
  prix_vente: 0,
};

interface QuickRow {
  ref: string;
  qty: number;
  fournisseur: string;
  pourQui: QuickPourQui;
  garageId: string;
  clientName: string;
  clientPhone: string;
  retoursImpossible: boolean;
  consigne: boolean;
  consignePrice: number;
  clientAPris: boolean;
}

const emptyQuickRow: QuickRow = {
  ref: "",
  qty: 1,
  fournisseur: "",
  pourQui: "COMPTOIR",
  garageId: "",
  clientName: "",
  clientPhone: "",
  retoursImpossible: false,
  consigne: false,
  consignePrice: 0,
  clientAPris: false,
};

/** Today's date in the user's local timezone (yyyy-mm-dd), not UTC. */
function todayISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a money input and cap it: the cashier can never type more than due. */
function clampMoney(raw: string, cap: number): number {
  const n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n * 100) / 100, Math.max(0, Math.round(cap * 100) / 100));
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
  const [garages, setGarages] = useState<GarageSummary[]>([]);

  /* ---- Client ---- */
  const [destineA, setDestineA] = useState<PourQui>("COMPTOIR");
  const [clientId, setClientId] = useState<string>(NEW_CLIENT);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [immatriculation, setImmatriculation] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [kilometrage, setKilometrage] = useState("");

  /* ---- Document ---- */
  const [canalVente, setCanalVente] = useState<string>("MAGASIN");

  /* ---- Lines ---- */
  const [lines, setLines] = useState<LineForm[]>([{ ...emptyLine }]);

  /* ---- Rajout rapide (quick-add modal) ---- */
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickRows, setQuickRows] = useState<QuickRow[]>([{ ...emptyQuickRow }]);
  const [quickSaving, setQuickSaving] = useState(false);

  const openQuick = useCallback(() => {
    setQuickRows([{ ...emptyQuickRow }]);
    setQuickOpen(true);
  }, []);

  const setQuickRow = useCallback(
    (idx: number, field: keyof QuickRow, value: string | number | boolean) => {
      setQuickRows((prev) =>
        prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
      );
    },
    [],
  );
  const addQuickRow = useCallback(
    () => setQuickRows((prev) => [...prev, { ...emptyQuickRow }]),
    [],
  );
  const removeQuickRow = useCallback(
    (idx: number) =>
      setQuickRows((prev) =>
        prev.length === 1 ? prev : prev.filter((_, i) => i !== idx),
      ),
    [],
  );

  const isQuickRowValid = useCallback(
    (r: QuickRow) =>
      Boolean(r.ref.trim()) &&
      (r.pourQui === "GARAGE"
        ? Boolean(r.garageId)
        : r.pourQui === "STOCK"
          ? Boolean(r.fournisseur)
          : Boolean(r.clientName.trim()) && Boolean(r.clientPhone.trim())),
    [],
  );

  // Rajout rapide creates ONE standalone order per row: each row carries its
  // own client/garage, so it cannot share the single-client main form. Rows
  // are inserted straight into the database.
  const handleQuickAdd = useCallback(async () => {
    const valid = quickRows.filter(isQuickRowValid);
    if (valid.length === 0) return;

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

    setQuickSaving(true);
    setError(null);
    try {
      const createdRefs: string[] = [];
      for (const r of valid) {
        // Resolve the client for this quick order.
        let clientIdForOrder: string | undefined;
        let phoneForOrder = "-";
        const forStock = r.pourQui === "STOCK";
        if (forStock) {
          // Restock order: no client, the part goes on the shelf on reception.
        } else if (r.pourQui === "GARAGE") {
          clientIdForOrder = r.garageId;
          phoneForOrder = garages.find((g) => g.id === r.garageId)?.phone ?? "-";
        } else {
          phoneForOrder = r.clientPhone.trim() || "-";
          const existing = clients.find(
            (c) =>
              c.name.trim().toLowerCase() === r.clientName.trim().toLowerCase(),
          );
          if (existing) {
            clientIdForOrder = existing.id;
          } else {
            const created = await createClientRecord(supabase, orgId, {
              name: r.clientName.trim(),
              phone: r.clientPhone.trim(),
            });
            clientIdForOrder = created.id;
          }
        }

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
              quantity: r.qty || 1,
              a_commander_pour_livreur: Boolean(r.fournisseur),
              depuis_magasin: forStock || !r.fournisseur,
              retour_impossible: r.retoursImpossible,
              consigne: r.consigne,
              consigne_price: r.consigne ? r.consignePrice || 0 : undefined,
              qte_remise:
                !forStock && !r.fournisseur && r.clientAPris ? r.qty || 1 : 0,
              prix_achat_unitaire: 0,
              prix_vente_unitaire: 0,
            },
          ],
          devis: false,
          statut_paiement: "NON_PAYÉ",
          montant_paye: 0,
          avance_payee: 0,
          // Client / garage rows go straight to the delivery flow; a stock
          // replenishment has nothing to deliver.
          envoyer_au_livreur: !forStock,
          statut_livreur: "EN_ATTENTE",
          bl: false,
        };
        const order = await createOrderWithLines(supabase, userId, orgId, payload);
        if (forStock) {
          // Flag it as a stock replenishment (no client; shown as "Réappro stock").
          await supabase
            .from("orders")
            .update({ is_restock: true })
            .eq("id", order.id)
            .eq("organization_id", orgId);
        }
        createdRefs.push(order.ref_demande);
      }

      setQuickOpen(false);
      setQuickRows([{ ...emptyQuickRow }]);
      setPdfInfo(
        `Rajout rapide — ${createdRefs.length} commande(s) créée(s) : ${createdRefs.join(", ")}.`,
      );
      void loadClients(supabase, orgId).then(setClients).catch(() => {});
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Erreur lors de la création des commandes rapides.",
      );
    } finally {
      setQuickSaving(false);
    }
  }, [
    quickRows,
    isQuickRowValid,
    supabase,
    user?.id,
    profile?.organization_id,
    garages,
    clients,
  ]);

  /* ---- Payment & delivery ---- */
  const [montantPaye, setMontantPaye] = useState(0);

  /* ---- Avoir as payment ---- */
  const [clientCredits, setClientCredits] = useState<ClientCredit[]>([]);
  const [avoirId, setAvoirId] = useState<string>("");
  const [avoirAmount, setAvoirAmount] = useState(0);

  /* ---- Status ---- */
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRef, setCreatedRef] = useState<string | null>(null);
  const [createdTour, setCreatedTour] = useState<{ name: string; deliveryAt: string | null } | null>(null);
  const [avoirWarning, setAvoirWarning] = useState<string | null>(null);
  /** Snapshot printed as a receipt-style ticket right after creation. */
  const [ticket, setTicket] = useState<TicketData | null>(null);
  const [orgSettings, setOrgSettings] = useState<OrganizationSettings | null>(null);

  useEffect(() => {
    if (!profile?.organization_id) return;
    loadOrganizationSettings(supabase, profile.organization_id)
      .then(setOrgSettings)
      .catch(() => {});
  }, [supabase, profile?.organization_id]);

  /* ---- PDF auto-fill ---- */
  const fileRef = useRef<HTMLInputElement>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfInfo, setPdfInfo] = useState<string | null>(null);

  /* ---- Load reference data ---- */
  useEffect(() => {
    if (!profile?.organization_id) return;
    let cancelled = false;
    const orgId = profile.organization_id;
    Promise.all([
      loadClients(supabase, orgId),
      loadSupplierOptions(supabase, orgId),
      loadGarages(supabase, orgId),
    ])
      .then(([cls, sups, gars]) => {
        if (cancelled) return;
        setClients(cls);
        setSuppliers(sups);
        setGarages(gars);
        // Deep link from Avoirs / Clients: /dashboard/nouvelle-commande?client=<id>&avoir=<id>
        const params = new URLSearchParams(window.location.search);
        const wantedClient = params.get("client");
        if (wantedClient) {
          const isGarage = gars.some((g) => g.id === wantedClient);
          const c = cls.find((x) => x.id === wantedClient);
          if (c) {
            setDestineA(isGarage ? "GARAGE" : "COMPTOIR");
            setClientId(c.id);
            setClientName(c.name);
            setClientPhone(c.phone ?? "");
            setClientEmail(c.email ?? "");
            setImmatriculation(c.immatriculation ?? "");
            setVehicleModel(c.vehicleModel ?? "");
          }
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, profile?.organization_id]);

  /* ---- Open avoirs of the selected client (usable as payment) ---- */
  useEffect(() => {
    setClientCredits([]);
    setAvoirId("");
    setAvoirAmount(0);
    if (!profile?.organization_id || clientId === NEW_CLIENT) return;
    let cancelled = false;
    loadClientCredits(supabase, profile.organization_id, clientId)
      .then((credits) => {
        if (cancelled) return;
        setClientCredits(credits);
        // Deep link: preselect the avoir the cashier clicked on the Avoirs page.
        const wanted = new URLSearchParams(window.location.search).get("avoir");
        const credit = wanted ? credits.find((c) => c.id === wanted) : null;
        if (credit) {
          setAvoirId(credit.id);
          setAvoirAmount(credit.remaining);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supabase, profile?.organization_id, clientId]);

  /* ---- Existing records to pick from, filtered by destination ---- */
  const garageIds = useMemo(
    () => new Set(garages.map((g) => g.id)),
    [garages],
  );
  const destRecords = useMemo(() => {
    if (destineA === "GARAGE") {
      return garages.map((g) => ({
        id: g.id,
        name: g.name,
        sub: g.city ?? undefined,
      }));
    }
    // Comptoir = regular clients (exclude garages).
    return clients
      .filter((c) => !garageIds.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        sub: c.immatriculation ?? undefined,
      }));
  }, [destineA, garages, clients, garageIds]);

  /* ---- Switch destination → clear the selected record ---- */
  const pickDestination = useCallback((value: PourQui) => {
    setDestineA(value);
    setClientId(NEW_CLIENT);
  }, []);

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

  /* ---- Particulier recognised by phone → the order joins their file ---- */
  const knownClient = useMemo(() => {
    if (destineA !== "COMPTOIR") return null;
    return matchClientByPhone(
      clients.filter((c) => !garageIds.has(c.id)),
      clientPhone,
    );
  }, [destineA, clients, garageIds, clientPhone]);
  /** The particulier this order will be linked to (phone match or picked). */
  const linkedParticulier = useMemo(() => {
    if (destineA !== "COMPTOIR") return null;
    if (knownClient) return knownClient;
    if (clientId === NEW_CLIENT) return null;
    return clients.find((c) => c.id === clientId && !garageIds.has(c.id)) ?? null;
  }, [destineA, knownClient, clientId, clients, garageIds]);

  // Id set by the phone match (a manual pick from the list is never undone).
  const phoneMatchedId = useRef<string | null>(null);
  useEffect(() => {
    if (destineA !== "COMPTOIR") return;
    if (!knownClient) {
      if (phoneMatchedId.current && clientId === phoneMatchedId.current) {
        setClientId(NEW_CLIENT);
      }
      phoneMatchedId.current = null;
      return;
    }
    phoneMatchedId.current = knownClient.id;
    setClientId(knownClient.id);
    // Prefill only what the cashier has not typed yet.
    if (!clientName.trim()) setClientName(knownClient.name);
    if (!clientEmail.trim() && knownClient.email) setClientEmail(knownClient.email);
    if (!immatriculation.trim() && knownClient.immatriculation) {
      setImmatriculation(knownClient.immatriculation);
    }
    if (!vehicleModel.trim() && knownClient.vehicleModel) setVehicleModel(knownClient.vehicleModel);
  }, [destineA, knownClient, clientId, clientName, clientEmail, immatriculation, vehicleModel]);

  /* ---- Line helpers ---- */
  const setLine = useCallback(
    (idx: number, field: keyof LineForm, value: string | number | boolean) => {
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
  const removeLine = useCallback((idx: number) => {
    setLines((prev) => prev.filter((_, i) => i !== idx));
    setSelectedLines(new Set());
  }, []);

  /* ---- Multi-selection: apply one action to several lines at once ---- */
  const [selectedLines, setSelectedLines] = useState<Set<number>>(new Set());
  const [bulkSupplier, setBulkSupplier] = useState("");
  const allLinesSelected = lines.length > 0 && lines.every((_, i) => selectedLines.has(i));
  const toggleLine = useCallback((idx: number) => {
    setSelectedLines((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);
  const toggleAllLines = useCallback(() => {
    setSelectedLines((prev) =>
      lines.every((_, i) => prev.has(i)) ? new Set() : new Set(lines.map((_, i) => i)),
    );
  }, [lines]);
  /** Patch every selected line with the same fields. */
  const applyToSelected = useCallback(
    (patch: Partial<LineForm>) => {
      setLines((prev) => prev.map((l, i) => (selectedLines.has(i) ? { ...l, ...patch } : l)));
    },
    [selectedLines],
  );
  const removeSelected = useCallback(() => {
    setLines((prev) => {
      const kept = prev.filter((_, i) => !selectedLines.has(i));
      return kept.length > 0 ? kept : [{ ...emptyLine }];
    });
    setSelectedLines(new Set());
  }, [selectedLines]);
  const selectedCount = selectedLines.size;
  const selectedAll = (field: keyof LineForm) =>
    selectedCount > 0 && lines.every((l, i) => !selectedLines.has(i) || Boolean(l[field]));

  /* ---- Money ---- */
  const consigneTotal = useMemo(
    () =>
      lines.reduce(
        (s, l) => s + (l.consigne ? l.quantity * (l.consigne_price || 0) : 0),
        0,
      ),
    [lines],
  );
  // Order total = parts + returnable deposits (consigne) charged to the client.
  const total = useMemo(
    () => lines.reduce((s, l) => s + l.quantity * l.prix_vente, 0) + consigneTotal,
    [lines, consigneTotal],
  );
  const selectedCredit = useMemo(
    () => clientCredits.find((c) => c.id === avoirId) ?? null,
    [clientCredits, avoirId],
  );
  /* ---- Payment maths — one chain, every field derives from it:
   *   total − avoir déduit = reste après avoir
   *   reste après avoir − montant payé = reste à payer
   *   statut = Payé (rien à payer) / Acompte (une partie réglée) / Non payé
   * The avoir is applied first and the cash is capped to what is left, so
   * the amounts can never contradict each other. ---- */
  const avoirApplied = selectedCredit
    ? Math.min(Math.max(0, avoirAmount), selectedCredit.remaining, total)
    : 0;
  const dueAfterAvoir = Math.max(0, total - avoirApplied);
  const paidEffective = Math.min(Math.max(0, montantPaye), dueAfterAvoir);
  const remaining = Math.max(0, dueAfterAvoir - paidEffective);
  const effectiveStatut =
    total > 0 && remaining <= 0
      ? "PAYÉ"
      : paidEffective + avoirApplied > 0
        ? "PARTIEL"
        : "NON_PAYÉ";
  const paiement = PAIEMENT_LABEL[effectiveStatut];
  /** Most the avoir can cover on this order. */
  const avoirCap = selectedCredit ? Math.min(selectedCredit.remaining, total) : 0;

  // Typing is clamped in the inputs, but caps can also shrink afterwards
  // (a line removed, a smaller avoir picked): keep the stored values legal.
  useEffect(() => {
    if (avoirAmount > avoirCap) setAvoirAmount(avoirCap);
  }, [avoirAmount, avoirCap]);
  useEffect(() => {
    if (montantPaye > dueAfterAvoir) setMontantPaye(dueAfterAvoir);
  }, [montantPaye, dueAfterAvoir]);

  const pickAvoir = useCallback(
    (id: string) => {
      setAvoirId(id);
      const credit = clientCredits.find((c) => c.id === id);
      // Default: use as much of the avoir as the order allows.
      setAvoirAmount(credit ? Math.min(credit.remaining, total) : 0);
    },
    [clientCredits, total],
  );

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
      // "Kilométrage : 0" on a devis means unknown — leave the field empty.
      const km = (parsed.mileage ?? "").replace(/\D/g, "");
      if (km && Number(km) > 0) setKilometrage(km);
      // Date de commande always stays today's date (never the devis date).
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
      const source = parsed.devisNumber
        ? `Devis ${parsed.devisNumber}${parsed.clientNumber ? ` (client n° ${parsed.clientNumber})` : ""} lu`
        : "PDF lu";
      setPdfInfo(
        `${source} — rempli : ${parsed.filled.filter((f) => f !== "date").join(", ")}. Il reste à choisir le fournisseur de chaque pièce.`,
      );
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
    if (destineA === "COMPTOIR" && !clientPhone.trim()) {
      setError(
        "Indiquez le téléphone du client : c'est ce qui le reconnaît dans le fichier Clients particuliers.",
      );
      return;
    }
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
        // Stamped at the moment the order is sent (time comes from createdAt).
        date_commande: todayISO(),
        canal_vente: canalVente,
        client_id: resolvedClientId,
        client_phone: clientPhone.trim() || "-",
        client_email: clientEmail.trim() || undefined,
        immatriculation: immatriculation.trim() || undefined,
        vehicle_model: vehicleModel.trim() || undefined,
        kilometrage: kilometrage.trim() ? Number(kilometrage.replace(/\D/g, "")) : undefined,
        lines: validLines.map((l) => ({
          nom_produit: l.nom_produit.trim(),
          reference: l.reference.trim(),
          fournisseur_id: l.fournisseur_id || undefined,
          quantity: l.quantity || 1,
          a_commander_pour_livreur: Boolean(l.fournisseur_id),
          depuis_magasin: !l.fournisseur_id,
          retour_impossible: Boolean(l.retours_impossible),
          consigne: Boolean(l.consigne),
          consigne_price: l.consigne ? l.consigne_price || 0 : undefined,
          qte_remise: !l.fournisseur_id && l.client_a_pris ? l.quantity || 1 : 0,
          prix_achat_unitaire: l.prix_achat || 0,
          prix_vente_unitaire: l.prix_vente || 0,
        })),
        devis: false,
        statut_paiement: effectiveStatut,
        montant_paye: paidEffective || 0,
        avance_payee: 0,
        avoir_id: avoirApplied > 0 ? avoirId : undefined,
        avoir_applique: avoirApplied > 0 ? avoirApplied : undefined,
        // Every order goes straight to the delivery flow (Commande à livrer).
        envoyer_au_livreur: true,
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
      setAvoirWarning(order.avoirWarning ?? null);
      setTicket({
        ref: order.ref_demande,
        createdAt: new Date().toISOString(),
        vendeur: profile.display_name || null,
        tourName: order.tourName || null,
        deliveryAt: order.deliveryAt,
        clientName: clientName.trim(),
        clientPhone: clientPhone.trim() || null,
        plate: immatriculation.trim() || null,
        vehicleModel: vehicleModel.trim() || null,
        kilometrage: kilometrage.trim() ? Number(kilometrage.replace(/\D/g, "")) : null,
        lines: validLines.map((l) => ({
          reference: l.reference.trim(),
          designation: l.nom_produit.trim(),
          quantity: l.quantity || 1,
          prixVente: l.prix_vente || 0,
          retourPossible: !l.retours_impossible,
          taken: !l.fournisseur_id && Boolean(l.client_a_pris),
        })),
        total,
        avoirApplique: avoirApplied,
        paye: paidEffective,
        reste: remaining,
        statutPaiement: effectiveStatut,
      });
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
    setDestineA("COMPTOIR");
    setClientId(NEW_CLIENT);
    setClientName("");
    setClientPhone("");
    setClientEmail("");
    setImmatriculation("");
    setVehicleModel("");
    setKilometrage("");
    setCanalVente("MAGASIN");
    setLines([{ ...emptyLine }]);
    setMontantPaye(0);
    setAvoirId("");
    setAvoirAmount(0);
    setError(null);
    setCreatedRef(null);
    setCreatedTour(null);
    setAvoirWarning(null);
    setTicket(null);
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
            La commande <strong>{createdRef}</strong> a bien été envoyée en livraison.
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
          {avoirWarning && <div className="nc-error">{avoirWarning}</div>}
          <div className="nc-success-actions">
            {ticket && (
              <button
                type="button"
                className="od-btn od-btn--primary"
                onClick={() => window.print()}
              >
                <Printer className="h-4 w-4" />
                Imprimer le ticket
              </button>
            )}
            <button
              type="button"
              className="od-btn od-btn--ghost"
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
        {ticket && (
          <div className="tk-preview">
            <OrderTicket org={orgSettings} data={ticket} />
          </div>
        )}
      </div>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Form                                                             */
  /* ---------------------------------------------------------------- */

  return (
    <>
    <form className="od-page nc-page" onSubmit={handleSubmit}>
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
          <h1 className="od-title nc-title">
            <span className="nc-title-icon"><ShoppingCart className="h-5 w-5" /></span>
            Nouvelle <span className="nc-title-accent">commande</span>
          </h1>
          <div className="od-meta">
            <span className="od-meta-item">
              <Calendar className="h-4 w-4" />
              {new Date().toLocaleString("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}
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
            {pdfBusy ? "Lecture du PDF…" : "Importer un bon (PDF)"}
          </button>
          <Link href="/dashboard" className="od-btn od-btn--ghost">
            Annuler
          </Link>
          <button
            type="button"
            className="od-btn od-btn--accent"
            onClick={openQuick}
          >
            <Zap className="h-4 w-4" />
            Rajout rapide
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
            <span className="od-label">Destiné à</span>
            <div className="od-select">
              <select
                value={destineA}
                onChange={(e) => pickDestination(e.target.value as PourQui)}
              >
                <option value="COMPTOIR">Client comptoir</option>
                <option value="GARAGE">Garage</option>
              </select>
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
          <div className="od-field">
            <span className="od-label">Canal de vente</span>
            <div className="od-select">
              <select value={canalVente} onChange={(e) => setCanalVente(e.target.value)}>
                {CANAUX.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
          <div className="od-field nc-col-2">
            <span className="od-label">
              {destineA === "GARAGE" ? "Garage existant" : "Client existant"}
            </span>
            <div className="od-select">
              <select
                value={clientId}
                onChange={(e) => pickClient(e.target.value)}
              >
                <option value={NEW_CLIENT}>
                  {destineA === "GARAGE" ? "— Nouveau garage —" : "— Nouveau client —"}
                </option>
                {destRecords.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.sub ? ` · ${r.sub}` : ""}
                  </option>
                ))}
              </select>
              <ChevronDown className="h-4 w-4" />
            </div>
          </div>
          <div className="od-field nc-col-2">
            <span className="od-label">Nom du client <span className="od-req">*</span></span>
            <input
              className="od-input"
              placeholder={destineA === "GARAGE" ? "GARAGE MARTIN" : "Jean Dupont"}
              value={clientName}
              onChange={(e) => {
                setClientName(e.target.value);
                // A particulier is recognised by phone; typing a new name
                // while a garage was picked starts a new record.
                if (clientId !== NEW_CLIENT && clientId !== phoneMatchedId.current) {
                  setClientId(NEW_CLIENT);
                }
              }}
            />
          </div>
          <div className="od-field">
            <span className="od-label">
              Téléphone
              {destineA === "COMPTOIR" && <span className="od-req"> *</span>}
            </span>
            <input
              className="od-input"
              placeholder="06 12 34 56 78"
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
          <div className="od-field">
            <span className="od-label">Kilométrage</span>
            <input
              className="od-input"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              placeholder="km"
              value={kilometrage}
              onChange={(e) => setKilometrage(e.target.value)}
            />
          </div>
        </div>
        {linkedParticulier ? (
          <div className="nc-known">
            <Check className="h-4 w-4" />
            Client reconnu : <strong>{linkedParticulier.name}</strong>
            {linkedParticulier.vehicleModel ? ` · ${linkedParticulier.vehicleModel}` : ""}
            {linkedParticulier.immatriculation ? ` · ${linkedParticulier.immatriculation}` : ""}
            {" "}— la commande rejoint son historique et ses points fidélité.
            <Link href={`/dashboard/clients/${linkedParticulier.id}`} className="rc-cmd" target="_blank">
              Voir le profil
            </Link>
          </div>
        ) : (
          clientId === NEW_CLIENT &&
          clientName.trim() && (
            <p className="nc-hint">
              <Info className="h-3.5 w-3.5" />
              {destineA === "COMPTOIR"
                ? "Nouveau client : il sera créé dans Clients particuliers (le téléphone sert à le reconnaître la prochaine fois)."
                : "Ce garage sera enregistré dans votre fichier."}
            </p>
          )
        )}
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
                <th className="rc-th-check">
                  <input
                    type="checkbox"
                    className="rc-check"
                    checked={allLinesSelected}
                    onChange={toggleAllLines}
                    aria-label="Sélectionner toutes les pièces"
                    title="Sélectionner toutes les pièces"
                  />
                </th>
                <th>Désignation</th>
                <th>Référence</th>
                <th>Fournisseur</th>
                <th className="od-th-center">Qté</th>
                <th className="od-th-right">Prix vente</th>
                <th className="od-th-center">Retour imp.</th>
                <th className="od-th-center">Consigne</th>
                <th className="od-th-center">Remis client</th>
                <th className="od-th-right">Total</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, idx) => (
                <tr key={idx} className={selectedLines.has(idx) ? "rc-row--selected" : undefined}>
                  <td className="rc-th-check">
                    <input
                      type="checkbox"
                      className="rc-check"
                      checked={selectedLines.has(idx)}
                      onChange={() => toggleLine(idx)}
                      aria-label={`Sélectionner la pièce ${idx + 1}`}
                    />
                  </td>
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
                      value={l.prix_vente || ""}
                      onChange={(e) =>
                        setLine(idx, "prix_vente", Number(e.target.value))
                      }
                    />
                  </td>
                  <td className="od-td-center">
                    <input
                      type="checkbox"
                      className="nc-cell-check"
                      checked={Boolean(l.retours_impossible)}
                      onChange={(e) =>
                        setLine(idx, "retours_impossible", e.target.checked)
                      }
                      aria-label="Retour impossible"
                    />
                  </td>
                  <td className="od-td-center">
                    <input
                      type="checkbox"
                      className="nc-cell-check"
                      checked={Boolean(l.consigne)}
                      onChange={(e) =>
                        setLine(idx, "consigne", e.target.checked)
                      }
                      aria-label="Consigne"
                    />
                    {l.consigne && (
                      <input
                        className="od-input nc-cell-input nc-cell-num nc-consigne-price"
                        type="number"
                        min={0}
                        step="0.01"
                        placeholder="Caution €"
                        title="Montant de la consigne (€)"
                        value={l.consigne_price || ""}
                        onChange={(e) =>
                          setLine(idx, "consigne_price", Number(e.target.value))
                        }
                      />
                    )}
                  </td>
                  <td className="od-td-center">
                    {l.fournisseur_id ? (
                      <span className="rl-muted" title="Pièce commandée chez un fournisseur : à remettre à la réception">
                        —
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        className="nc-cell-check"
                        checked={Boolean(l.client_a_pris)}
                        onChange={(e) =>
                          setLine(idx, "client_a_pris", e.target.checked)
                        }
                        aria-label="Remis au client"
                        title="Le client a pris la pièce du stock magasin"
                      />
                    )}
                  </td>
                  <td className="od-td-right od-num od-num-strong">
                    {eur(
                      l.quantity *
                        (l.prix_vente + (l.consigne ? l.consigne_price || 0 : 0)),
                    )}
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

        {selectedCount > 0 && (
          <div className="rc-bulk nc-bulk">
            <span className="rc-bulk-label">
              <Check className="h-4 w-4" />
              {selectedCount} pièce{selectedCount > 1 ? "s" : ""} sélectionnée{selectedCount > 1 ? "s" : ""} — appliquer à toutes :
            </span>
            <span className="nc-bulk-actions">
              <span className="od-select nc-bulk-select">
                <select
                  value={bulkSupplier}
                  onChange={(e) => {
                    setBulkSupplier(e.target.value);
                    applyToSelected({ fournisseur_id: e.target.value });
                  }}
                  aria-label="Fournisseur pour la sélection"
                >
                  <option value="">Fournisseur → Stock magasin</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      Fournisseur → {s.name}
                    </option>
                  ))}
                </select>
                <ChevronDown className="h-4 w-4" />
              </span>
              <button
                type="button"
                className={`rc-act${selectedAll("retours_impossible") ? " rc-act--nonrecu" : ""}`}
                onClick={() => applyToSelected({ retours_impossible: !selectedAll("retours_impossible") })}
                title="Marquer / démarquer « retour impossible »"
              >
                Retour impossible {selectedAll("retours_impossible") ? "✓" : ""}
              </button>
              <button
                type="button"
                className={`rc-act${selectedAll("consigne") ? " rc-act--reliquat" : ""}`}
                onClick={() => applyToSelected({ consigne: !selectedAll("consigne") })}
                title="Marquer / démarquer « consigne »"
              >
                Consigne {selectedAll("consigne") ? "✓" : ""}
              </button>
              <button
                type="button"
                className={`rc-act${selectedAll("client_a_pris") ? " rc-act--recu" : ""}`}
                onClick={() => applyToSelected({ client_a_pris: !selectedAll("client_a_pris") })}
                title="Le client a pris ces pièces du stock"
              >
                Remis client {selectedAll("client_a_pris") ? "✓" : ""}
              </button>
              <button
                type="button"
                className="rc-act rc-act--nonrecu"
                onClick={removeSelected}
                title="Supprimer les pièces sélectionnées"
              >
                <Trash2 className="h-3.5 w-3.5" /> Supprimer
              </button>
              <button type="button" className="rc-act" onClick={() => setSelectedLines(new Set())}>
                Annuler
              </button>
            </span>
          </div>
        )}

        <button type="button" className="nc-add-line" onClick={addLine}>
          <Plus className="h-4 w-4" />
          Ajouter une pièce
        </button>

        <div className="od-lines-total">
          Total commande <strong>{eur(total)}</strong>
        </div>
        {consigneTotal > 0 && (
          <div className="od-lines-consigne">
            dont {eur(consigneTotal)} de consigne
          </div>
        )}
      </section>

      {/* ---- Payment ---- */}
      <section className="od-card">
        <div className="od-card-title">Paiement</div>

        <div className="nc-grid">
          <div className="od-field">
            <span className="od-label">Total commande</span>
            <input className="od-input nc-readonly" readOnly value={eur(total)} />
          </div>
          <div className="od-field nc-col-2">
            <span className="od-label">Avoir du client</span>
            {clientCredits.length > 0 ? (
              <div className="od-select">
                <select value={avoirId} onChange={(e) => pickAvoir(e.target.value)}>
                  <option value="">Ne pas utiliser d&apos;avoir</option>
                  {clientCredits.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.num} — reste {eur(c.remaining)}
                      {c.dueAt
                        ? ` (valable jusqu'au ${new Date(c.dueAt).toLocaleDateString("fr-FR")})`
                        : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown className="h-4 w-4" />
              </div>
            ) : (
              <input
                className="od-input nc-readonly"
                readOnly
                value={
                  destineA === "COMPTOIR" && clientId === NEW_CLIENT
                    ? "Sélectionnez un client existant pour utiliser un avoir"
                    : "Aucun avoir disponible pour ce client"
                }
              />
            )}
          </div>
          {selectedCredit && (
            <div className="od-field">
              <span className="od-label">Montant déduit de l&apos;avoir</span>
              <input
                className="od-input"
                type="number"
                min={0}
                max={avoirCap}
                step="0.01"
                value={avoirAmount || ""}
                onChange={(e) => setAvoirAmount(clampMoney(e.target.value, avoirCap))}
              />
              <span className="st-cmd-hint">
                {eur(avoirApplied)} déduits · reste sur l&apos;avoir{" "}
                {eur(selectedCredit.remaining - avoirApplied)}
              </span>
            </div>
          )}
        </div>

        <div className="nc-pay">
          <div className="nc-pay-form">
            <div className="od-field">
              <span className="od-label">Montant payé maintenant</span>
              <div className="nc-pay-input">
                <input
                  className="od-input nc-pay-amount"
                  type="number"
                  min={0}
                  max={dueAfterAvoir}
                  step="0.01"
                  value={montantPaye || ""}
                  placeholder="0,00"
                  disabled={dueAfterAvoir <= 0}
                  onChange={(e) => setMontantPaye(clampMoney(e.target.value, dueAfterAvoir))}
                />
                <span className="nc-pay-unit">€</span>
              </div>
              <div className="nc-pay-quick">
                <button type="button" className={`nc-chip${paidEffective <= 0 ? " nc-chip--on" : ""}`} onClick={() => setMontantPaye(0)} disabled={dueAfterAvoir <= 0}>
                  Rien maintenant
                </button>
                <button type="button" className={`nc-chip${dueAfterAvoir > 0 && paidEffective >= dueAfterAvoir ? " nc-chip--on" : ""}`} onClick={() => setMontantPaye(dueAfterAvoir)} disabled={dueAfterAvoir <= 0}>
                  Tout · {eur(dueAfterAvoir)}
                </button>
                {dueAfterAvoir > 0 && (
                  <button type="button" className={`nc-chip${paidEffective > 0 && paidEffective < dueAfterAvoir ? " nc-chip--on" : ""}`} onClick={() => setMontantPaye(Math.round((dueAfterAvoir / 2) * 100) / 100)}>
                    Moitié · {eur(Math.round((dueAfterAvoir / 2) * 100) / 100)}
                  </button>
                )}
              </div>
              <span className="st-cmd-hint">
                {dueAfterAvoir <= 0
                  ? "Rien à encaisser : le total est couvert."
                  : "Ce que le client règle aujourd'hui. Le reste sera à payer à la remise des pièces."}
              </span>
            </div>
          </div>

          <aside className="nc-recap nc-recap--simple" aria-label="Reste à payer">
            <div className={`nc-recap-total${remaining > 0 ? " is-due" : total > 0 ? " is-ok" : ""}`}>
              <span>Reste à payer</span>
              <strong>{eur(remaining)}</strong>
            </div>
            <span className={`rt-badge rt-badge--${paiement.cls}`}>{paiement.label}</span>
          </aside>
        </div>
      </section>

      {/* ---- Footer actions ---- */}
      <div className="nc-footer">
        <button type="button" className="od-btn od-btn--ghost" onClick={resetForm}>
          Réinitialiser
        </button>
        <button
          type="submit"
          className="od-btn od-btn--primary nc-submit"
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 nc-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {saving ? "Envoi…" : "Envoyer la commande"}
        </button>
      </div>
    </form>

    {/* ---- Rajout rapide modal ---- */}
    {quickOpen && (
      <div
        className="ga-modal-overlay"
        onClick={() => setQuickOpen(false)}
      >
        <div
          className="ga-modal ga-modal--wide"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="ga-modal-head">
            <span className="ga-modal-title">
              <Zap className="h-4 w-4" style={{ verticalAlign: "-2px", marginRight: 6 }} />
              Rajout rapide
            </span>
            <button
              type="button"
              className="ga-modal-close"
              onClick={() => setQuickOpen(false)}
              aria-label="Fermer"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="ga-modal-form">
            {quickRows.map((row, idx) => (
              <div className="nc-quick-row" key={idx}>
                <div className="nc-quick-row-head">
                  <span className="nc-quick-row-num">Pièce {idx + 1}</span>
                  <button
                    type="button"
                    className="od-icon-btn"
                    onClick={() => removeQuickRow(idx)}
                    disabled={quickRows.length === 1}
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
                    autoFocus={idx === quickRows.length - 1}
                    onChange={(e) => setQuickRow(idx, "ref", e.target.value)}
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
                      onChange={(e) =>
                        setQuickRow(idx, "qty", Number(e.target.value))
                      }
                    />
                  </div>
                  <div className="od-field">
                    <span className="od-label">
                      Fournisseur{row.pourQui === "STOCK" ? <span className="od-req"> *</span> : ""}
                    </span>
                    <div className="od-select">
                      <select
                        value={row.fournisseur}
                        onChange={(e) =>
                          setQuickRow(idx, "fournisseur", e.target.value)
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
                  </div>
                </div>

                <div className="ga-modal-row">
                  <div className="od-field">
                    <span className="od-label">Pour qui</span>
                    <div className="od-select">
                      <select
                        value={row.pourQui}
                        onChange={(e) =>
                          setQuickRow(idx, "pourQui", e.target.value as QuickPourQui)
                        }
                      >
                        <option value="COMPTOIR">Client comptoir</option>
                        <option value="GARAGE">Garage</option>
                        <option value="STOCK">Stock magasin</option>
                      </select>
                      <ChevronDown className="h-4 w-4" />
                    </div>
                  </div>
                  {row.pourQui === "GARAGE" && (
                    <div className="od-field">
                      <span className="od-label">Garage <span className="od-req">*</span></span>
                      <div className="od-select">
                        <select
                          value={row.garageId}
                          onChange={(e) =>
                            setQuickRow(idx, "garageId", e.target.value)
                          }
                        >
                          <option value="">— Choisir un garage —</option>
                          {garages.map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                              {g.city ? ` · ${g.city}` : ""}
                            </option>
                          ))}
                        </select>
                        <ChevronDown className="h-4 w-4" />
                      </div>
                      {garages.length === 0 && (
                        <span className="nc-hint" style={{ marginTop: 6 }}>
                          <Info className="h-3.5 w-3.5" />
                          Aucun garage enregistré.
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
                        onChange={(e) =>
                          setQuickRow(idx, "clientName", e.target.value)
                        }
                      />
                    </div>
                    <div className="od-field">
                      <span className="od-label">Téléphone <span className="od-req">*</span></span>
                      <input
                        className="od-input"
                        placeholder="06 12 34 56 78"
                        value={row.clientPhone}
                        onChange={(e) =>
                          setQuickRow(idx, "clientPhone", e.target.value)
                        }
                      />
                    </div>
                  </div>
                )}

                <div className="od-field">
                  <span className="od-label">Actions</span>
                  <label className="nc-check">
                    <input
                      type="checkbox"
                      checked={row.retoursImpossible}
                      onChange={(e) =>
                        setQuickRow(idx, "retoursImpossible", e.target.checked)
                      }
                    />
                    Retours impossible
                  </label>
                  <label className="nc-check">
                    <input
                      type="checkbox"
                      checked={row.consigne}
                      onChange={(e) =>
                        setQuickRow(idx, "consigne", e.target.checked)
                      }
                    />
                    Consigne
                  </label>
                  {!row.fournisseur && row.pourQui !== "STOCK" && (
                    <label className="nc-check">
                      <input
                        type="checkbox"
                        checked={row.clientAPris}
                        onChange={(e) =>
                          setQuickRow(idx, "clientAPris", e.target.checked)
                        }
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
                      onChange={(e) =>
                        setQuickRow(idx, "consignePrice", Number(e.target.value))
                      }
                    />
                  )}
                </div>
              </div>
            ))}

            <button type="button" className="nc-add-line" onClick={addQuickRow}>
              <Plus className="h-4 w-4" />
              Ajouter une pièce
            </button>

            <div className="ga-modal-actions">
              <button
                type="button"
                className="od-btn od-btn--ghost"
                onClick={() => setQuickOpen(false)}
                disabled={quickSaving}
              >
                Annuler
              </button>
              <button
                type="button"
                className="od-btn od-btn--primary"
                onClick={() => void handleQuickAdd()}
                disabled={quickSaving || !quickRows.some(isQuickRowValid)}
              >
                {quickSaving ? (
                  <Loader2 className="h-4 w-4 nc-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {quickSaving
                  ? "Création…"
                  : (() => {
                      const n = quickRows.filter(isQuickRowValid).length;
                      return `Créer ${n > 1 ? `${n} commandes` : "la commande"}`;
                    })()}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
