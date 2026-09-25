import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber } from "@/lib/data/saas";
import { lineWarranty, normalizePlate, type LineWarranty } from "@/lib/sav";

/* ------------------------------------------------------------------ */
/*  Module après-vente — data access.                                  */
/*  Everything here needs migrations 20260920010000 + 20260920020000;  */
/*  until they are pushed the loaders throw SavUnavailableError so the */
/*  screens can say so instead of showing a raw PostgREST error.       */
/* ------------------------------------------------------------------ */

type Embedded<T> = T | T[] | null | undefined;
function first<T>(value: Embedded<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export class SavUnavailableError extends Error {
  constructor() {
    super("Le module après-vente n'est pas encore activé sur cette base (migrations 20260920 à appliquer).");
    this.name = "SavUnavailableError";
  }
}

type PgError = { code?: string; message: string };

/** Function, table or column of the SAV migrations not there yet. */
export function isSavMissing(error: PgError | null | undefined): boolean {
  if (!error) return false;
  if (["PGRST202", "PGRST205", "42P01", "42703", "42883"].includes(error.code ?? "")) return true;
  return /sav_|warranty_rules|satisfaction_surveys|Could not find the (function|table)|schema cache/i.test(error.message);
}

function fail(error: PgError): never {
  if (isSavMissing(error)) throw new SavUnavailableError();
  throw new Error(translate(error.message));
}

/** The database raises in English; the counter reads French. */
function translate(message: string): string {
  const map: [RegExp, string][] = [
    [/Staff access is required/i, "Accès réservé au personnel du magasin."],
    [/Only an organization administrator/i, "Seul un administrateur du magasin peut modifier ces réglages."],
    [/Case not found/i, "Dossier introuvable."],
    [/Order line not found/i, "Ligne de commande introuvable."],
    [/Order not found/i, "Commande introuvable."],
    [/A part designation is required/i, "Indiquez la pièce concernée."],
    [/A description is required/i, "Décrivez le problème."],
    [/A positive amount is required/i, "Indiquez un montant supérieur à zéro."],
    [/A client is required to issue a credit note/i, "Un avoir ne peut être émis que pour un client enregistré."],
    [/credit note was already issued/i, "Un avoir a déjà été émis pour ce dossier."],
    [/review link must start with https/i, "Le lien d'avis doit commencer par https://"],
    [/No message queued/i, "Aucun message envoyé : pas de numéro, client désinscrit, ou déjà prévenu aujourd'hui."],
    [/No usable credit note/i, "Cet avoir n'a plus de solde à annoncer."],
    [/not awaiting a core/i, "Cette consigne n'attend plus de pièce."],
    [/core has not been brought back/i, "Le client n'a pas encore rapporté l'ancienne pièce."],
    [/consignment has no supplier/i, "Cette consigne n'a pas de fournisseur : renseignez-le d'abord."],
    [/Invalid labor/i, "Taux horaire ou temps de main d'œuvre invalide."],
    [/Operational access is not available/i, "Abonnement inactif : action indisponible."],
  ];
  for (const [re, fr] of map) if (re.test(message)) return fr;
  return message;
}

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const num = (v: unknown): number | null => (v == null || v === "" ? null : toNumber(v));

/* ------------------------------------------------------------------ */
/*  Réglages                                                           */
/* ------------------------------------------------------------------ */

export type SavSettings = {
  autoSmsReady: boolean;
  autoSmsDelay: boolean;
  autoSmsPickupReminders: boolean;
  autoSmsConsigne: boolean;
  autoSmsSatisfaction: boolean;
  autoSmsAvoir: boolean;
  autoSmsMaintenance: boolean;
  autoSupplierReminders: boolean;
  channel: "SMS" | "WHATSAPP";
  returnPolicyDays: number;
  returnPolicyText: string | null;
  consigneClientDays: number;
  slaHours: number;
  dormantCreditMonths: number;
  googleReviewUrl: string | null;
  templates: Record<string, string>;
};

export const DEFAULT_SAV_SETTINGS: SavSettings = {
  autoSmsReady: false,
  autoSmsDelay: false,
  autoSmsPickupReminders: false,
  autoSmsConsigne: false,
  autoSmsSatisfaction: false,
  autoSmsAvoir: false,
  autoSmsMaintenance: false,
  autoSupplierReminders: true,
  channel: "SMS",
  returnPolicyDays: 15,
  returnPolicyText: null,
  consigneClientDays: 30,
  slaHours: 48,
  dormantCreditMonths: 6,
  googleReviewUrl: null,
  templates: {},
};

function parseSettings(raw: unknown): SavSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = DEFAULT_SAV_SETTINGS;
  return {
    autoSmsReady: r.auto_sms_ready === true,
    autoSmsDelay: r.auto_sms_delay === true,
    autoSmsPickupReminders: r.auto_sms_pickup_reminders === true,
    autoSmsConsigne: r.auto_sms_consigne === true,
    autoSmsSatisfaction: r.auto_sms_satisfaction === true,
    autoSmsAvoir: r.auto_sms_avoir === true,
    autoSmsMaintenance: r.auto_sms_maintenance === true,
    autoSupplierReminders: r.auto_supplier_reminders !== false,
    channel: r.channel === "WHATSAPP" ? "WHATSAPP" : "SMS",
    returnPolicyDays: num(r.return_policy_days) ?? d.returnPolicyDays,
    returnPolicyText: str(r.return_policy_text),
    consigneClientDays: num(r.consigne_client_days) ?? d.consigneClientDays,
    slaHours: num(r.sla_hours) ?? d.slaHours,
    dormantCreditMonths: num(r.dormant_credit_months) ?? d.dormantCreditMonths,
    googleReviewUrl: str(r.google_review_url),
    templates: r.templates && typeof r.templates === "object" ? (r.templates as Record<string, string>) : {},
  };
}

export async function loadSavSettings(supabase: SupabaseClient): Promise<SavSettings> {
  const { data, error } = await supabase.rpc("get_sav_settings");
  if (error) fail(error);
  return parseSettings(data);
}

/** Settings, or the defaults when the module is not migrated yet (never throws for that). */
export async function loadSavSettingsSafe(supabase: SupabaseClient): Promise<{ settings: SavSettings; available: boolean }> {
  try {
    return { settings: await loadSavSettings(supabase), available: true };
  } catch (e) {
    if (e instanceof SavUnavailableError) return { settings: DEFAULT_SAV_SETTINGS, available: false };
    throw e;
  }
}

export async function updateSavSettings(supabase: SupabaseClient, s: SavSettings): Promise<SavSettings> {
  const { data, error } = await supabase.rpc("update_sav_settings", {
    p: {
      auto_sms_ready: s.autoSmsReady,
      auto_sms_delay: s.autoSmsDelay,
      auto_sms_pickup_reminders: s.autoSmsPickupReminders,
      auto_sms_consigne: s.autoSmsConsigne,
      auto_sms_satisfaction: s.autoSmsSatisfaction,
      auto_sms_avoir: s.autoSmsAvoir,
      auto_sms_maintenance: s.autoSmsMaintenance,
      auto_supplier_reminders: s.autoSupplierReminders,
      channel: s.channel,
      return_policy_days: String(s.returnPolicyDays),
      return_policy_text: s.returnPolicyText ?? "",
      consigne_client_days: String(s.consigneClientDays),
      sla_hours: String(s.slaHours),
      dormant_credit_months: String(s.dormantCreditMonths),
      google_review_url: s.googleReviewUrl ?? "",
      templates: s.templates,
    },
  });
  if (error) fail(error);
  return parseSettings(data);
}

export type WarrantyRule = { id: string; marque: string | null; famille: string | null; months: number; note: string | null };

export async function loadWarrantyRules(supabase: SupabaseClient, orgId: string): Promise<WarrantyRule[]> {
  const { data, error } = await supabase
    .from("warranty_rules")
    .select("id, marque, famille, months, note")
    .eq("organization_id", orgId)
    .order("marque", { ascending: true, nullsFirst: false })
    .order("famille", { ascending: true });
  if (error) fail(error);
  return (data ?? []).map((r) => ({
    id: String(r.id),
    marque: str(r.marque),
    famille: str(r.famille),
    months: toNumber(r.months),
    note: str(r.note),
  }));
}

export async function createWarrantyRule(
  supabase: SupabaseClient,
  orgId: string,
  input: { marque: string | null; famille: string | null; months: number; note?: string | null },
): Promise<void> {
  const { error } = await supabase.from("warranty_rules").insert({
    organization_id: orgId,
    marque: input.marque?.trim() || null,
    famille: input.famille || null,
    months: input.months,
    note: input.note?.trim() || null,
  });
  if (error) {
    if (error.code === "23505") throw new Error("Une règle existe déjà pour cette marque / famille.");
    fail(error);
  }
}

export async function deleteWarrantyRule(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("warranty_rules").delete().eq("id", id);
  if (error) fail(error);
}

/* ------------------------------------------------------------------ */
/*  Champs de la vente                                                 */
/* ------------------------------------------------------------------ */

export type OrderSavFields = {
  promisedDate?: string | null;
  casier?: string | null;
  garagePoseurId?: string | null;
  garagePoseurName?: string | null;
  smsMarketingConsent?: boolean;
  lines?: { id: string; serialNumber?: string | null; marque?: string | null; warrantyMonths?: number | null; receptionPhotoPath?: string | null }[];
};

export async function setOrderSavFields(supabase: SupabaseClient, orderId: string, f: OrderSavFields): Promise<void> {
  const p: Record<string, unknown> = {};
  if (f.promisedDate !== undefined) p.promised_date = f.promisedDate ?? "";
  if (f.casier !== undefined) p.casier = f.casier ?? "";
  if (f.garagePoseurId !== undefined) p.garage_poseur_id = f.garagePoseurId ?? "";
  if (f.garagePoseurName !== undefined) p.garage_poseur_name = f.garagePoseurName ?? "";
  if (f.smsMarketingConsent !== undefined) p.sms_marketing_consent = f.smsMarketingConsent;
  if (f.lines?.length) {
    p.lines = f.lines.map((l) => {
      const o: Record<string, unknown> = { id: l.id };
      if (l.serialNumber !== undefined) o.serial_number = l.serialNumber ?? "";
      if (l.marque !== undefined) o.marque = l.marque ?? "";
      if (l.warrantyMonths !== undefined) o.warranty_months = l.warrantyMonths == null ? "" : String(l.warrantyMonths);
      if (l.receptionPhotoPath !== undefined) o.reception_photo_path = l.receptionPhotoPath ?? "";
      return o;
    });
  }
  const { error } = await supabase.rpc("set_order_sav_fields", { p_order_id: orderId, p });
  if (error) fail(error);
}

/** Right after an order is created: default promise date + « tout remis d'emblée » = retirée. */
export async function finalizeOrderSav(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { error } = await supabase.rpc("finalize_order_sav", { p_order_id: orderId });
  if (error) fail(error);
}

export type OrderSavLine = {
  id: string;
  serialNumber: string | null;
  marque: string | null;
  famille: string | null;
  warrantyMonths: number | null;
  extensionMonths: number;
  handedOverAt: string | null;
  receptionPhotoPath: string | null;
};

export type OrderSavInfo = {
  promisedDate: string | null;
  promiseRevisedDate: string | null;
  casier: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  garagePoseurName: string | null;
  deliveredAt: string | null;
  orderDate: string | null;
  clientConsent: boolean;
  clientOptOut: boolean;
  lines: Map<string, OrderSavLine>;
  cases: SavCaseRow[];
};

export async function loadOrderSavInfo(supabase: SupabaseClient, orgId: string, orderId: string): Promise<OrderSavInfo> {
  const [order, lines, cases] = await Promise.all([
    supabase
      .from("orders")
      .select("promised_date, promise_revised_date, casier, ready_at, picked_up_at, garage_poseur_name, delivered_at, date_commande, clients(sms_marketing_consent, sms_opt_out_at)")
      .eq("id", orderId)
      .maybeSingle(),
    supabase
      .from("order_lines")
      .select("id, serial_number, marque, famille, warranty_months, warranty_extension_months, remise_at, reception_photo_path")
      .eq("order_id", orderId),
    loadSavCases(supabase, orgId, { orderId }),
  ]);
  if (order.error) fail(order.error);
  if (lines.error) fail(lines.error);
  const o = (order.data ?? {}) as Record<string, unknown>;
  const client = first(o.clients as Embedded<Record<string, unknown>>);
  const map = new Map<string, OrderSavLine>();
  for (const raw of lines.data ?? []) {
    const l = raw as Record<string, unknown>;
    map.set(String(l.id), {
      id: String(l.id),
      serialNumber: str(l.serial_number),
      marque: str(l.marque),
      famille: str(l.famille),
      warrantyMonths: num(l.warranty_months),
      extensionMonths: toNumber(l.warranty_extension_months),
      handedOverAt: str(l.remise_at),
      receptionPhotoPath: str(l.reception_photo_path),
    });
  }
  return {
    promisedDate: str(o.promised_date),
    promiseRevisedDate: str(o.promise_revised_date),
    casier: str(o.casier),
    readyAt: str(o.ready_at),
    pickedUpAt: str(o.picked_up_at),
    garagePoseurName: str(o.garage_poseur_name),
    deliveredAt: str(o.delivered_at),
    orderDate: str(o.date_commande),
    clientConsent: client?.sms_marketing_consent === true,
    clientOptOut: client?.sms_opt_out_at != null,
    lines: map,
    cases,
  };
}

/** Casier + promise for a list of orders (« Commande à préparer »). Empty map before the migration. */
export async function loadOrderShelves(
  supabase: SupabaseClient,
  orgId: string,
  orderIds: string[],
): Promise<Map<string, { casier: string | null; promisedDate: string | null; promiseRevisedDate: string | null; readyAt: string | null }>> {
  const out = new Map<string, { casier: string | null; promisedDate: string | null; promiseRevisedDate: string | null; readyAt: string | null }>();
  if (orderIds.length === 0) return out;
  const { data, error } = await supabase
    .from("orders")
    .select("id, casier, promised_date, promise_revised_date, ready_at")
    .eq("organization_id", orgId)
    .in("id", orderIds.slice(0, 400));
  if (error) {
    if (isSavMissing(error)) return out;
    throw new Error(error.message);
  }
  for (const raw of data ?? []) {
    const r = raw as Record<string, unknown>;
    out.set(String(r.id), {
      casier: str(r.casier),
      promisedDate: str(r.promised_date),
      promiseRevisedDate: str(r.promise_revised_date),
      readyAt: str(r.ready_at),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Recherche sans facture / carnet véhicule                           */
/* ------------------------------------------------------------------ */

export type SaleLine = {
  lineId: string;
  orderId: string;
  orderRef: string;
  orderDate: string | null;
  clientId: string | null;
  clientName: string;
  clientPhone: string | null;
  isGarage: boolean;
  plate: string | null;
  plateNorm: string;
  vehicleModel: string | null;
  km: number | null;
  garagePoseur: string | null;
  designation: string;
  reference: string;
  marque: string | null;
  famille: string | null;
  serialNumber: string | null;
  quantity: number;
  unitPrice: number;
  supplierId: string | null;
  supplier: string | null;
  handedOver: number;
  consigne: boolean;
  consigneStatus: string | null;
  returned: boolean;
  openCase: { id: string; ref: string; type: string; clientStatus: string; closed: boolean } | null;
  warranty: LineWarranty | null;
};

export async function searchSales(supabase: SupabaseClient, q: string, limit = 120): Promise<SaleLine[]> {
  const { data, error } = await supabase.rpc("sav_search_sales", { p_q: q, p_limit: limit });
  if (error) fail(error);
  const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  return rows.map((r) => {
    const oc = r.open_case as Record<string, unknown> | null;
    return {
      lineId: String(r.line_id),
      orderId: String(r.order_id),
      orderRef: String(r.order_ref ?? ""),
      orderDate: str(r.order_date),
      clientId: str(r.client_id),
      clientName: String(r.client_name ?? "Client comptoir"),
      clientPhone: str(r.client_phone),
      isGarage: r.is_garage === true,
      plate: str(r.plate),
      plateNorm: String(r.plate_norm ?? normalizePlate(str(r.plate))),
      vehicleModel: str(r.vehicle_model),
      km: num(r.km),
      garagePoseur: str(r.garage_poseur),
      designation: String(r.designation ?? ""),
      reference: String(r.reference ?? ""),
      marque: str(r.marque),
      famille: str(r.famille),
      serialNumber: str(r.serial_number),
      quantity: toNumber(r.quantity),
      unitPrice: toNumber(r.unit_price),
      supplierId: str(r.supplier_id),
      supplier: str(r.supplier),
      handedOver: toNumber(r.handed_over),
      consigne: r.consigne === true,
      consigneStatus: str(r.consigne_status),
      returned: r.returned === true,
      openCase: oc
        ? { id: String(oc.id), ref: String(oc.ref), type: String(oc.type), clientStatus: String(oc.client_status), closed: oc.closed === true }
        : null,
      warranty: lineWarranty({
        start: str(r.warranty_start),
        warrantyMonths: num(r.warranty_months),
        extensionMonths: num(r.warranty_extension_months),
      }),
    };
  });
}

export type VehicleFile = {
  plateNorm: string;
  plate: string;
  model: string | null;
  /** Owners seen on this plate, most recent first (a car changes hands). */
  owners: { clientId: string | null; name: string; phone: string | null; isGarage: boolean; lastSeen: string | null }[];
  /** Kilométrages successifs saisis au comptoir. */
  kms: { date: string | null; km: number; orderRef: string }[];
  lines: SaleLine[];
};

/** Group sale lines by plate: one carnet per vehicle. Lines without a plate are dropped. */
export function buildVehicleFiles(lines: SaleLine[]): VehicleFile[] {
  const byPlate = new Map<string, VehicleFile>();
  for (const l of lines) {
    if (!l.plateNorm) continue;
    let v = byPlate.get(l.plateNorm);
    if (!v) {
      v = { plateNorm: l.plateNorm, plate: l.plate ?? l.plateNorm, model: l.vehicleModel, owners: [], kms: [], lines: [] };
      byPlate.set(l.plateNorm, v);
    }
    v.lines.push(l);
    if (!v.model && l.vehicleModel) v.model = l.vehicleModel;
    if (!v.owners.some((o) => (o.clientId ?? o.name) === (l.clientId ?? l.clientName))) {
      v.owners.push({ clientId: l.clientId, name: l.clientName, phone: l.clientPhone, isGarage: l.isGarage, lastSeen: l.orderDate });
    }
    if (l.km != null && l.km > 0 && !v.kms.some((k) => k.orderRef === l.orderRef)) {
      v.kms.push({ date: l.orderDate, km: l.km, orderRef: l.orderRef });
    }
  }
  for (const v of byPlate.values()) v.kms.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return [...byPlate.values()];
}

/* ------------------------------------------------------------------ */
/*  Dossiers                                                           */
/* ------------------------------------------------------------------ */

export type SavCaseRow = {
  id: string;
  ref: string;
  type: string;
  origin: string;
  clientId: string | null;
  clientName: string;
  isGarage: boolean;
  orderId: string | null;
  orderRef: string | null;
  orderLineId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierEmail: string | null;
  returnId: string | null;
  immatriculation: string | null;
  designation: string;
  reference: string | null;
  marque: string | null;
  famille: string | null;
  serialNumber: string | null;
  purchaseDate: string | null;
  /** Commercial warranty and legal extension of the sold line (null without a sale). */
  lineWarrantyMonths: number | null;
  lineExtensionMonths: number;
  partValue: number | null;
  description: string | null;
  clientStatus: string;
  supplierStatus: string | null;
  supplierCaseNumber: string | null;
  supplierDeclaredAt: string | null;
  supplierAnsweredAt: string | null;
  supplierLastReminderAt: string | null;
  supplierReminderCount: number;
  supplierCreditAmount: number | null;
  kmMontage: number | null;
  kmPanne: number | null;
  garagePoseur: string | null;
  poseInvoiceRef: string | null;
  partLocation: string;
  partLocationNote: string | null;
  replacementGiven: boolean;
  replacementAt: string | null;
  replacementNote: string | null;
  warrantyExtended: boolean;
  laborRate: number | null;
  laborHours: number | null;
  laborAmount: number;
  gestureType: string | null;
  gestureAmount: number | null;
  gestureBudget: string | null;
  gestureAt: string | null;
  gestureNote: string | null;
  creditNoteId: string | null;
  slaDueAt: string | null;
  firstResponseAt: string | null;
  openedAt: string;
  closedAt: string | null;
  resolutionNote: string | null;
};

const CASE_SELECT =
  "*, clients(name, is_garage), suppliers(name, sav_email), orders(ref_demande), order_lines(warranty_months, warranty_extension_months)";

function parseCase(raw: unknown): SavCaseRow {
  const r = raw as Record<string, unknown>;
  const client = first(r.clients as Embedded<Record<string, unknown>>);
  const supplier = first(r.suppliers as Embedded<Record<string, unknown>>);
  const order = first(r.orders as Embedded<Record<string, unknown>>);
  const line = first(r.order_lines as Embedded<Record<string, unknown>>);
  return {
    id: String(r.id),
    ref: String(r.ref ?? ""),
    type: String(r.type ?? "GARANTIE"),
    origin: String(r.origin ?? "COMPTOIR"),
    clientId: str(r.client_id),
    clientName: String(client?.name ?? "Client comptoir"),
    isGarage: client?.is_garage === true,
    orderId: str(r.order_id),
    orderRef: str(order?.ref_demande),
    orderLineId: str(r.order_line_id),
    supplierId: str(r.supplier_id),
    supplierName: str(supplier?.name),
    supplierEmail: str(supplier?.sav_email),
    returnId: str(r.return_id),
    immatriculation: str(r.immatriculation),
    designation: String(r.designation ?? ""),
    reference: str(r.reference),
    marque: str(r.marque),
    famille: str(r.famille),
    serialNumber: str(r.serial_number),
    purchaseDate: str(r.purchase_date),
    lineWarrantyMonths: num(line?.warranty_months),
    lineExtensionMonths: toNumber(line?.warranty_extension_months),
    partValue: num(r.part_value),
    description: str(r.description),
    clientStatus: String(r.client_status ?? "RECU"),
    supplierStatus: str(r.supplier_status),
    supplierCaseNumber: str(r.supplier_case_number),
    supplierDeclaredAt: str(r.supplier_declared_at),
    supplierAnsweredAt: str(r.supplier_answered_at),
    supplierLastReminderAt: str(r.supplier_last_reminder_at),
    supplierReminderCount: toNumber(r.supplier_reminder_count),
    supplierCreditAmount: num(r.supplier_credit_amount),
    kmMontage: num(r.km_montage),
    kmPanne: num(r.km_panne),
    garagePoseur: str(r.garage_poseur),
    poseInvoiceRef: str(r.pose_invoice_ref),
    partLocation: String(r.part_location ?? "CLIENT"),
    partLocationNote: str(r.part_location_note),
    replacementGiven: r.replacement_given === true,
    replacementAt: str(r.replacement_at),
    replacementNote: str(r.replacement_note),
    warrantyExtended: r.warranty_extended === true,
    laborRate: num(r.labor_rate),
    laborHours: num(r.labor_hours),
    laborAmount: toNumber(r.labor_amount),
    gestureType: str(r.gesture_type),
    gestureAmount: num(r.gesture_amount),
    gestureBudget: str(r.gesture_budget),
    gestureAt: str(r.gesture_at),
    gestureNote: str(r.gesture_note),
    creditNoteId: str(r.credit_note_id),
    slaDueAt: str(r.sla_due_at),
    firstResponseAt: str(r.first_response_at),
    openedAt: String(r.opened_at ?? ""),
    closedAt: str(r.closed_at),
    resolutionNote: str(r.resolution_note),
  };
}

export async function loadSavCases(
  supabase: SupabaseClient,
  orgId: string,
  filter: { orderId?: string; clientId?: string; plate?: string } = {},
): Promise<SavCaseRow[]> {
  let q = supabase.from("sav_cases").select(CASE_SELECT).eq("organization_id", orgId).order("opened_at", { ascending: false }).limit(500);
  if (filter.orderId) q = q.eq("order_id", filter.orderId);
  if (filter.clientId) q = q.eq("client_id", filter.clientId);
  const { data, error } = await q;
  if (error) fail(error);
  let rows = (data ?? []).map(parseCase);
  if (filter.plate) {
    const p = normalizePlate(filter.plate);
    rows = rows.filter((c) => normalizePlate(c.immatriculation) === p);
  }
  return rows;
}

export type SavCaseEvent = {
  id: string;
  kind: string;
  body: string | null;
  actor: string | null;
  visibleToClient: boolean;
  createdAt: string;
  emailTo: string | null;
  emailSentAt: string | null;
  emailError: string | null;
};

export type SavCaseFile = { id: string; path: string; kind: string; caption: string | null; createdAt: string; url: string | null };

export type SavCaseDetail = { case: SavCaseRow; events: SavCaseEvent[]; files: SavCaseFile[] };

export async function loadSavCase(supabase: SupabaseClient, caseId: string): Promise<SavCaseDetail | null> {
  const [c, ev, fl] = await Promise.all([
    supabase.from("sav_cases").select(CASE_SELECT).eq("id", caseId).maybeSingle(),
    supabase.from("sav_case_events").select("*").eq("case_id", caseId).order("created_at", { ascending: true }),
    supabase.from("sav_case_files").select("*").eq("case_id", caseId).order("created_at", { ascending: true }),
  ]);
  if (c.error) fail(c.error);
  if (!c.data) return null;
  if (ev.error) fail(ev.error);
  if (fl.error) fail(fl.error);

  const paths = (fl.data ?? []).map((f) => String((f as Record<string, unknown>).path));
  const urls = new Map<string, string>();
  if (paths.length > 0) {
    const signed = await supabase.storage.from("sav").createSignedUrls(paths, 3600);
    for (const s of signed.data ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  return {
    case: parseCase(c.data),
    events: (ev.data ?? []).map((raw) => {
      const e = raw as Record<string, unknown>;
      return {
        id: String(e.id),
        kind: String(e.kind),
        body: str(e.body),
        actor: str(e.actor_name),
        visibleToClient: e.visible_to_client === true,
        createdAt: String(e.created_at ?? ""),
        emailTo: str(e.email_to),
        emailSentAt: str(e.email_sent_at),
        emailError: str(e.email_error),
      };
    }),
    files: (fl.data ?? []).map((raw) => {
      const f = raw as Record<string, unknown>;
      return {
        id: String(f.id),
        path: String(f.path),
        kind: String(f.kind),
        caption: str(f.caption),
        createdAt: String(f.created_at ?? ""),
        url: urls.get(String(f.path)) ?? null,
      };
    }),
  };
}

export type OpenCaseInput = {
  type: "GARANTIE" | "LITIGE";
  orderLineId?: string | null;
  orderId?: string | null;
  clientId?: string | null;
  returnId?: string | null;
  supplierId?: string | null;
  designation?: string | null;
  reference?: string | null;
  immatriculation?: string | null;
  description?: string | null;
  kmMontage?: number | null;
  kmPanne?: number | null;
  garagePoseur?: string | null;
  poseInvoiceRef?: string | null;
  serialNumber?: string | null;
  laborRate?: number | null;
  laborHours?: number | null;
  partLocation?: string | null;
};

function casePayloadFrom(input: OpenCaseInput): Record<string, string> {
  const p: Record<string, string> = { type: input.type };
  const put = (k: string, v: unknown) => {
    if (v != null && v !== "") p[k] = String(v);
  };
  put("order_line_id", input.orderLineId);
  put("order_id", input.orderId);
  put("client_id", input.clientId);
  put("return_id", input.returnId);
  put("supplier_id", input.supplierId);
  put("designation", input.designation);
  put("reference", input.reference);
  put("immatriculation", input.immatriculation);
  put("description", input.description);
  put("km_montage", input.kmMontage);
  put("km_panne", input.kmPanne);
  put("garage_poseur", input.garagePoseur);
  put("pose_invoice_ref", input.poseInvoiceRef);
  put("serial_number", input.serialNumber);
  put("labor_rate", input.laborRate);
  put("labor_hours", input.laborHours);
  put("part_location", input.partLocation);
  return p;
}

export async function openSavCase(supabase: SupabaseClient, input: OpenCaseInput): Promise<string> {
  const { data, error } = await supabase.rpc("open_sav_case", { p: casePayloadFrom(input) });
  if (error) fail(error);
  return String(data);
}

/** Patch of a case; keys use the database column names (update_sav_case whitelist). */
export type SavCasePatch = Partial<{
  client_status: string;
  supplier_status: string | null;
  supplier_id: string | null;
  supplier_case_number: string | null;
  supplier_credit_amount: number | null;
  description: string | null;
  immatriculation: string | null;
  marque: string | null;
  serial_number: string | null;
  km_montage: number | null;
  km_panne: number | null;
  garage_poseur: string | null;
  pose_invoice_ref: string | null;
  part_location: string;
  part_location_note: string | null;
  replacement_given: boolean;
  replacement_note: string | null;
  labor_rate: number | null;
  labor_hours: number | null;
  resolution_note: string | null;
}>;

export async function updateSavCase(supabase: SupabaseClient, caseId: string, patch: SavCasePatch): Promise<void> {
  const p: Record<string, string> = {};
  for (const [k, v] of Object.entries(patch)) p[k] = v == null ? "" : String(v);
  const { error } = await supabase.rpc("update_sav_case", { p_case_id: caseId, p });
  if (error) fail(error);
}

export async function recordSavGesture(
  supabase: SupabaseClient,
  input: { caseId: string; type: string; amount: number | null; budget: string | null; note: string | null; createCredit: boolean },
): Promise<string | null> {
  const { data, error } = await supabase.rpc("record_sav_gesture", {
    p_case_id: input.caseId,
    p_type: input.type,
    p_amount: input.amount,
    p_budget: input.budget,
    p_note: input.note,
    p_create_credit: input.createCredit,
  });
  if (error) fail(error);
  return (data as string | null) ?? null;
}

export async function addSavCaseNote(supabase: SupabaseClient, caseId: string, body: string, visibleToClient: boolean): Promise<void> {
  const { error } = await supabase.rpc("add_sav_case_note", { p_case_id: caseId, p_body: body, p_visible: visibleToClient });
  if (error) fail(error);
}

const FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

/** Upload to the private `sav` bucket under <org>/<folder>/…; returns the storage path. */
export async function uploadSavFile(supabase: SupabaseClient, orgId: string, folder: string, file: File): Promise<string> {
  if (!FILE_TYPES.includes(file.type)) throw new Error("Format non pris en charge : photo (JPEG, PNG, WebP) ou PDF.");
  if (file.size > 8 * 1024 * 1024) throw new Error("Fichier trop lourd (8 Mo maximum).");
  const ext = file.type === "application/pdf" ? "pdf" : file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${orgId}/${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from("sav").upload(path, file, { contentType: file.type, upsert: false });
  if (error) {
    if (/bucket/i.test(error.message)) throw new SavUnavailableError();
    throw new Error(error.message);
  }
  return path;
}

export async function addSavCaseFile(
  supabase: SupabaseClient,
  orgId: string,
  caseId: string,
  file: File,
  kind: string,
  caption: string | null,
): Promise<void> {
  const path = await uploadSavFile(supabase, orgId, caseId, file);
  const { error } = await supabase.rpc("add_sav_case_file", { p_case_id: caseId, p_path: path, p_kind: kind, p_caption: caption });
  if (error) fail(error);
}

export async function signedSavUrl(supabase: SupabaseClient, path: string): Promise<string | null> {
  const { data } = await supabase.storage.from("sav").createSignedUrl(path, 3600);
  return data?.signedUrl ?? null;
}

/* ------------------------------------------------------------------ */
/*  Tableau de bord                                                    */
/* ------------------------------------------------------------------ */

export type AmountCount = { amount: number; count: number };

export type SavDashboard = {
  immobilise: { consignesClient: AmountCount; consignesFournisseur: AmountCount; atRisk: AmountCount; clientLate: AmountCount };
  garanties: { amount: number; count: number; open: number; toDeclare: number };
  late: { supplierNoAnswer: number; sla: number; returnsDeadline: number; coresDeadline: number };
  pickup: { count: number; value: number; oldestDays: number; avgDays: number; over15: number };
  delay: { avgDays: number | null; closed: number; firstResponseHours: number | null };
  credits: { openAmount: number; openCount: number; dormantAmount: number; dormantCount: number };
  satisfaction: { sent: number; yes: number; no: number };
  returnRateBySupplier: { supplier: string; lines: number; returns: number; warranties: number; rate: number | null }[];
  warrantyByFamille: { famille: string; lines: number; cases: number; rate: number | null }[];
  warrantyByMarque: { marque: string; cases: number; amount: number }[];
  supplierResponse: { supplier: string; avgDays: number | null; answered: number; pending: number }[];
  motifs: { motifCode: string; count: number; amount: number }[];
  motifsByVendeur: { vendeur: string; returns: number; erreursReference: number; sales: number }[];
  cost: { gestures: number; uncoveredWarranty: number; lostCores: number; total: number; ca: number; pct: number | null };
};

export async function loadSavDashboard(supabase: SupabaseClient): Promise<SavDashboard> {
  const { data, error } = await supabase.rpc("sav_dashboard");
  if (error) fail(error);
  const d = (data ?? {}) as Record<string, unknown>;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const ac = (v: unknown): AmountCount => ({ amount: toNumber(obj(v).amount), count: toNumber(obj(v).count) });
  const im = obj(d.immobilise);
  const ga = obj(d.garanties);
  const la = obj(d.late);
  const pi = obj(d.pickup);
  const de = obj(d.delay);
  const cr = obj(d.credits);
  const sa = obj(d.satisfaction);
  const co = obj(d.cost);
  return {
    immobilise: {
      consignesClient: ac(im.consignes_client),
      consignesFournisseur: ac(im.consignes_fournisseur),
      atRisk: ac(im.at_risk),
      clientLate: ac(im.client_late),
    },
    garanties: { amount: toNumber(ga.amount), count: toNumber(ga.count), open: toNumber(ga.open), toDeclare: toNumber(ga.to_declare) },
    late: {
      supplierNoAnswer: toNumber(la.supplier_no_answer),
      sla: toNumber(la.sla),
      returnsDeadline: toNumber(la.returns_deadline),
      coresDeadline: toNumber(la.cores_deadline),
    },
    pickup: {
      count: toNumber(pi.count),
      value: toNumber(pi.value),
      oldestDays: toNumber(pi.oldest_days),
      avgDays: toNumber(pi.avg_days),
      over15: toNumber(pi.over_15),
    },
    delay: { avgDays: num(de.avg_days), closed: toNumber(de.closed), firstResponseHours: num(de.first_response_hours) },
    credits: {
      openAmount: toNumber(cr.open_amount),
      openCount: toNumber(cr.open_count),
      dormantAmount: toNumber(cr.dormant_amount),
      dormantCount: toNumber(cr.dormant_count),
    },
    satisfaction: { sent: toNumber(sa.sent), yes: toNumber(sa.yes), no: toNumber(sa.no) },
    returnRateBySupplier: arr(d.return_rate_by_supplier).map((r) => ({
      supplier: String(r.supplier ?? ""),
      lines: toNumber(r.lines),
      returns: toNumber(r.returns),
      warranties: toNumber(r.warranties),
      rate: num(r.rate),
    })),
    warrantyByFamille: arr(d.warranty_by_famille).map((r) => ({
      famille: String(r.famille ?? "AUTRE"),
      lines: toNumber(r.lines),
      cases: toNumber(r.cases),
      rate: num(r.rate),
    })),
    warrantyByMarque: arr(d.warranty_by_marque).map((r) => ({ marque: String(r.marque ?? ""), cases: toNumber(r.cases), amount: toNumber(r.amount) })),
    supplierResponse: arr(d.supplier_response).map((r) => ({
      supplier: String(r.supplier ?? ""),
      avgDays: num(r.avg_days),
      answered: toNumber(r.answered),
      pending: toNumber(r.pending),
    })),
    motifs: arr(d.motifs).map((r) => ({ motifCode: String(r.motif_code ?? "NON_CODE"), count: toNumber(r.count), amount: toNumber(r.amount) })),
    motifsByVendeur: arr(d.motifs_by_vendeur).map((r) => ({
      vendeur: String(r.vendeur ?? ""),
      returns: toNumber(r.returns),
      erreursReference: toNumber(r.erreurs_reference),
      sales: toNumber(r.sales),
    })),
    cost: {
      gestures: toNumber(co.gestures),
      uncoveredWarranty: toNumber(co.uncovered_warranty),
      lostCores: toNumber(co.lost_cores),
      total: toNumber(co.total),
      ca: toNumber(co.ca),
      pct: num(co.pct),
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Retours, consignes, messages                                       */
/* ------------------------------------------------------------------ */

export async function qualifyReturns(
  supabase: SupabaseClient,
  input: { returnIds?: string[]; lineIds?: string[]; motifCode: string | null; etat: string | null; frais?: number | null },
): Promise<void> {
  const { error } = await supabase.rpc("qualify_returns", {
    p_return_ids: input.returnIds ?? null,
    p_line_ids: input.lineIds ?? null,
    p_motif_code: input.motifCode,
    p_etat: input.etat,
    p_frais: input.frais ?? null,
  });
  if (error) fail(error);
}

/** motif_code / état / fenêtre fournisseur of the listed returns (empty before the migration). */
export async function loadReturnQualifications(
  supabase: SupabaseClient,
  orgId: string,
): Promise<Map<string, { motifCode: string | null; etat: string | null; frais: number; supplierDeadline: string | null; savCaseId: string | null; orderLineId: string | null; saleDate: string | null }>> {
  const out = new Map<string, { motifCode: string | null; etat: string | null; frais: number; supplierDeadline: string | null; savCaseId: string | null; orderLineId: string | null; saleDate: string | null }>();
  const { data, error } = await supabase
    .from("sales_returns")
    .select("id, motif_code, etat_piece, frais, supplier_deadline, sav_case_id, order_line_id, orders(date_commande)")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isSavMissing(error)) return out;
    throw new Error(error.message);
  }
  for (const raw of data ?? []) {
    const r = raw as Record<string, unknown>;
    const order = first(r.orders as Embedded<Record<string, unknown>>);
    out.set(String(r.id), {
      motifCode: str(r.motif_code),
      etat: str(r.etat_piece),
      frais: toNumber(r.frais),
      supplierDeadline: str(r.supplier_deadline),
      savCaseId: str(r.sav_case_id),
      orderLineId: str(r.order_line_id),
      saleDate: str(order?.date_commande),
    });
  }
  return out;
}

export async function returnConsigneCore(supabase: SupabaseClient, entryId: string, state: string, photoPath: string | null): Promise<void> {
  const { error } = await supabase.rpc("return_consigne_core", { p_entry_id: entryId, p_state: state, p_photo_path: photoPath });
  if (error) fail(error);
}

export async function setConsigneSupplierStatus(
  supabase: SupabaseClient,
  entryId: string,
  status: string | null,
  opts: { creditAmount?: number | null; deadline?: string | null } = {},
): Promise<void> {
  const { error } = await supabase.rpc("set_consigne_supplier_status", {
    p_entry_id: entryId,
    p_status: status,
    p_credit_amount: opts.creditAmount ?? null,
    p_deadline: opts.deadline ?? null,
  });
  if (error) fail(error);
}

/** The core leaves with the tournée: creates the supplier return the counter hands to the livreur. */
export async function consigneToSupplierReturn(supabase: SupabaseClient, entryId: string): Promise<string> {
  const { data, error } = await supabase.rpc("consigne_to_supplier_return", { p_entry_id: entryId });
  if (error) fail(error);
  return String(data);
}

export type SendQueuedResult = { sent: number; simulated: number; failed: number; skipped: number; held: number };

/** Queue a manual client message (solde d'avoir, rappel de consigne) and send it right away. */
export async function notifyClient(
  supabase: SupabaseClient,
  kind: "AVOIR_BALANCE" | "CONSIGNE_REMINDER",
  entityId: string,
): Promise<SendQueuedResult> {
  const { error } = await supabase.rpc("queue_client_sms", { p_kind: kind, p_entity_id: entityId });
  if (error) fail(error);
  const res = await fetch("/api/sav/send-queued", { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as Partial<SendQueuedResult> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Envoi impossible.");
  return {
    sent: body.sent ?? 0,
    simulated: body.simulated ?? 0,
    failed: body.failed ?? 0,
    skipped: body.skipped ?? 0,
    held: body.held ?? 0,
  };
}

/** One sentence for the toast after notifyClient(). */
export function sendResultText(r: SendQueuedResult): string {
  if (r.sent > 0) return "Message envoyé au client.";
  if (r.simulated > 0) return "Message simulé : aucun fournisseur SMS n'est configuré, rien n'est parti.";
  if (r.held > 0) return "Message en file : il partira à la prochaine plage d'envoi (8 h – 20 h).";
  if (r.failed > 0) return "L'envoi a échoué — voir le journal des messages.";
  return "Message en file d'attente.";
}

export type ClientMessage = {
  id: string;
  kind: string | null;
  channel: string;
  status: string;
  phone: string | null;
  message: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
  error: string | null;
  simulated: boolean;
  orderId: string | null;
  orderRef: string | null;
  clientName: string | null;
};

/** evenement_notification: what was sent, when, through which channel. */
export async function loadClientMessages(
  supabase: SupabaseClient,
  orgId: string,
  filter: { orderId?: string; clientId?: string; limit?: number } = {},
): Promise<ClientMessage[]> {
  let q = supabase
    .from("sms_notifications")
    .select("id, kind, channel, status, phone, message, scheduled_for, sent_at, created_at, error, simulated, order_id, orders(ref_demande), clients(name)")
    .eq("organization_id", orgId)
    .or("kind.not.is.null,message.not.is.null")
    .order("created_at", { ascending: false })
    .limit(filter.limit ?? 100);
  if (filter.orderId) q = q.eq("order_id", filter.orderId);
  if (filter.clientId) q = q.eq("client_id", filter.clientId);
  const { data, error } = await q;
  if (error) {
    if (isSavMissing(error) || /kind|channel|scheduled_for|simulated/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return (data ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const order = first(r.orders as Embedded<Record<string, unknown>>);
    const client = first(r.clients as Embedded<Record<string, unknown>>);
    return {
      id: String(r.id),
      kind: str(r.kind),
      channel: String(r.channel ?? "SMS"),
      status: String(r.status ?? ""),
      phone: str(r.phone),
      message: str(r.message),
      scheduledFor: str(r.scheduled_for),
      sentAt: str(r.sent_at),
      createdAt: String(r.created_at ?? ""),
      error: str(r.error),
      simulated: r.simulated === true,
      orderId: str(r.order_id),
      orderRef: str(order?.ref_demande),
      clientName: str(client?.name),
    };
  });
}

export async function cancelQueuedMessage(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.rpc("cancel_queued_sms", { p_id: id });
  if (error) fail(error);
}

/* ------------------------------------------------------------------ */
/*  Espace garagiste                                                   */
/* ------------------------------------------------------------------ */

export type GarageCase = {
  id: string;
  ref: string;
  type: string;
  designation: string;
  reference: string | null;
  immatriculation: string | null;
  description: string | null;
  clientStatus: string;
  orderRef: string | null;
  laborRate: number | null;
  laborHours: number | null;
  laborAmount: number;
  gestureType: string | null;
  gestureAmount: number | null;
  replacementGiven: boolean;
  slaDueAt: string | null;
  firstResponseAt: string | null;
  openedAt: string;
  closedAt: string | null;
  events: { kind: string; body: string | null; actor: string | null; at: string }[];
  files: { id: string; path: string; kind: string; caption: string | null; mine: boolean }[];
};

export async function loadGarageCases(supabase: SupabaseClient): Promise<{ slaHours: number; laborRate: number | null; cases: GarageCase[] }> {
  const { data, error } = await supabase.rpc("garage_sav_cases");
  if (error) fail(error);
  const d = (data ?? {}) as Record<string, unknown>;
  const cases = Array.isArray(d.cases) ? (d.cases as Record<string, unknown>[]) : [];
  return {
    slaHours: toNumber(d.sla_hours) || 48,
    laborRate: num(d.labor_rate),
    cases: cases.map((c) => ({
      id: String(c.id),
      ref: String(c.ref ?? ""),
      type: String(c.type ?? "LITIGE"),
      designation: String(c.designation ?? ""),
      reference: str(c.reference),
      immatriculation: str(c.immatriculation),
      description: str(c.description),
      clientStatus: String(c.client_status ?? "RECU"),
      orderRef: str(c.order_ref),
      laborRate: num(c.labor_rate),
      laborHours: num(c.labor_hours),
      laborAmount: toNumber(c.labor_amount),
      gestureType: str(c.gesture_type),
      gestureAmount: num(c.gesture_amount),
      replacementGiven: c.replacement_given === true,
      slaDueAt: str(c.sla_due_at),
      firstResponseAt: str(c.first_response_at),
      openedAt: String(c.opened_at ?? ""),
      closedAt: str(c.closed_at),
      events: (Array.isArray(c.events) ? (c.events as Record<string, unknown>[]) : []).map((e) => ({
        kind: String(e.kind),
        body: str(e.body),
        actor: str(e.actor),
        at: String(e.at ?? ""),
      })),
      files: (Array.isArray(c.files) ? (c.files as Record<string, unknown>[]) : []).map((f) => ({
        id: String(f.id),
        path: String(f.path),
        kind: String(f.kind),
        caption: str(f.caption),
        mine: f.mine === true,
      })),
    })),
  };
}

export async function openGarageDispute(
  supabase: SupabaseClient,
  input: {
    type: "LITIGE" | "GARANTIE";
    orderId?: string | null;
    orderLineId?: string | null;
    designation?: string | null;
    description: string;
    immatriculation?: string | null;
    laborRate?: number | null;
    laborHours?: number | null;
    kmMontage?: number | null;
    kmPanne?: number | null;
  },
): Promise<string> {
  const p: Record<string, string> = { type: input.type, description: input.description };
  const put = (k: string, v: unknown) => {
    if (v != null && v !== "") p[k] = String(v);
  };
  put("order_id", input.orderId);
  put("order_line_id", input.orderLineId);
  put("designation", input.designation);
  put("immatriculation", input.immatriculation);
  put("labor_rate", input.laborRate);
  put("labor_hours", input.laborHours);
  put("km_montage", input.kmMontage);
  put("km_panne", input.kmPanne);
  const { data, error } = await supabase.rpc("open_garage_dispute", { p });
  if (error) fail(error);
  return String(data);
}

/* ------------------------------------------------------------------ */
/*  Fournisseurs : conditions après-vente                              */
/* ------------------------------------------------------------------ */

export type SupplierSavTerms = {
  /** Fenêtre de retour du grossiste, en jours depuis la réception (null = non renseignée). */
  returnWindowDays: number | null;
  /** Délai pour renvoyer un cœur consigné, en jours depuis la reprise au comptoir. */
  coreReturnDays: number | null;
  /** Relance automatique d'un dossier garantie sans réponse après n jours. */
  warrantyReminderDays: number;
  savEmail: string | null;
};

/** Terms per supplier id; an empty map on a database without the SAV migration. */
export async function loadSupplierSavTerms(supabase: SupabaseClient, orgId: string): Promise<Map<string, SupplierSavTerms>> {
  const out = new Map<string, SupplierSavTerms>();
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, return_window_days, core_return_days, warranty_reminder_days, sav_email")
    .eq("organization_id", orgId);
  if (error) {
    if (isSavMissing(error) || /return_window_days|core_return_days|sav_email/i.test(error.message)) return out;
    throw new Error(error.message);
  }
  for (const raw of data ?? []) {
    const r = raw as Record<string, unknown>;
    out.set(String(r.id), {
      returnWindowDays: num(r.return_window_days),
      coreReturnDays: num(r.core_return_days),
      warrantyReminderDays: num(r.warranty_reminder_days) ?? 15,
      savEmail: str(r.sav_email),
    });
  }
  return out;
}

export async function updateSupplierSavTerms(supabase: SupabaseClient, orgId: string, supplierId: string, terms: SupplierSavTerms): Promise<void> {
  const days = (v: number | null, max: number): number | null => (v == null || !Number.isFinite(v) || v <= 0 ? null : Math.min(max, Math.floor(v)));
  const { error } = await supabase
    .from("suppliers")
    .update({
      return_window_days: days(terms.returnWindowDays, 365),
      core_return_days: days(terms.coreReturnDays, 365),
      warranty_reminder_days: days(terms.warrantyReminderDays, 90) ?? 15,
      sav_email: terms.savEmail?.trim() || null,
    })
    .eq("id", supplierId)
    .eq("organization_id", orgId);
  if (error) fail(error);
}

/**
 * Fire-and-forget: send the messages the database just queued for this
 * magasin (pièce arrivée, retard…). Never throws — the cron and the in-app
 * bell would pick them up a minute later anyway.
 */
export function flushClientMessages(): void {
  if (typeof fetch !== "function") return;
  void fetch("/api/sav/send-queued", { method: "POST" }).catch(() => {});
}
