/**
 * Après-vente — pure business rules shared by every SAV screen: part
 * families, the six coded return reasons, warranty dates and their
 * green / orange / red light, case statuses. Nothing here touches Supabase.
 *
 * The family codes and the maintenance intervals mirror the SQL functions
 * part_family() and maintenance_relance_months() (migrations 20260920…).
 */

/* ------------------------------------------------------------------ */
/*  Familles de pièces                                                 */
/* ------------------------------------------------------------------ */

export const FAMILY_LABEL: Record<string, string> = {
  PLAQUETTES: "Plaquettes de frein",
  DISQUES: "Disques de frein",
  FREINAGE: "Freinage",
  DISTRIBUTION: "Distribution",
  VIDANGE: "Vidange",
  FILTRATION: "Filtration",
  BATTERIE: "Batterie",
  AMORTISSEURS: "Amortisseurs",
  ESSUIE_GLACE: "Essuie-glaces",
  EMBRAYAGE: "Embrayage",
  DEMARRAGE_CHARGE: "Alternateur / démarreur",
  ALLUMAGE: "Allumage",
  ECLAIRAGE: "Éclairage",
  REFROIDISSEMENT: "Refroidissement",
  DIRECTION_SUSPENSION: "Direction / suspension",
  ECHAPPEMENT: "Échappement",
  INJECTION: "Injection / suralimentation",
  CLIMATISATION: "Climatisation",
  COURROIE_ACCESSOIRE: "Courroie d'accessoires",
  PNEUMATIQUE: "Pneumatiques",
  AUTRE: "Autre",
};

export const FAMILY_CODES = Object.keys(FAMILY_LABEL);

export function familyLabel(code: string | null | undefined): string {
  return FAMILY_LABEL[code ?? ""] ?? "Autre";
}

function plain(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Same classification as the SQL part_family(): first rule that matches wins. */
export function partFamily(name: string | null | undefined): string {
  const t = plain(name ?? "");
  const rules: [RegExp, string][] = [
    [/plaquette/, "PLAQUETTES"],
    [/disque(?!.*embrayage)/, "DISQUES"],
    [/etrier|machoire|tambour|flexible de frein|maitre.cylindre|liquide de frein/, "FREINAGE"],
    [/kit (de )?distribution|courroie (de )?distribution|galet (de )?distribution|chaine (de )?distribution/, "DISTRIBUTION"],
    [/vidange|filtre a huile|huile moteur|huile [0-9]+w/, "VIDANGE"],
    [/filtre/, "FILTRATION"],
    [/batterie/, "BATTERIE"],
    [/amortisseur|coupelle|butee de suspension|ressort de suspension/, "AMORTISSEURS"],
    [/essuie|balai/, "ESSUIE_GLACE"],
    [/embrayage|volant moteur|butee hydraulique/, "EMBRAYAGE"],
    [/alternateur|demarreur/, "DEMARRAGE_CHARGE"],
    [/bougie|bobine/, "ALLUMAGE"],
    [/ampoule|phare|feu |feux|optique|clignotant/, "ECLAIRAGE"],
    [/radiateur|thermostat|durite|pompe a eau|liquide de refroidissement|ventilateur/, "REFROIDISSEMENT"],
    [/rotule|biellette|triangle|roulement|cardan|silent|bras de suspension|cremaillere|soufflet/, "DIRECTION_SUSPENSION"],
    [/echappement|silencieux|catalyseur|fap|filtre a particules|sonde lambda/, "ECHAPPEMENT"],
    [/injecteur|pompe (a )?injection|turbo|vanne egr|debitmetre|pompe a carburant/, "INJECTION"],
    [/clim|condenseur|compresseur/, "CLIMATISATION"],
    [/courroie|galet/, "COURROIE_ACCESSOIRE"],
    [/pneu/, "PNEUMATIQUE"],
  ];
  if (/disque/.test(t) && /embrayage/.test(t)) return "EMBRAYAGE";
  for (const [re, code] of rules) if (re.test(t)) return code;
  return "AUTRE";
}

/* ------------------------------------------------------------------ */
/*  Relance d'entretien                                                */
/* ------------------------------------------------------------------ */

export type MaintenanceRule = {
  /** Months after the sale when the reminder goes out. */
  relanceMonths: number;
  /** « Prochain besoin estimé » shown on the carnet véhicule. */
  need: string;
  /** How the part is named in the SMS: « vos plaquettes de frein ». */
  sms: string;
};

export const MAINTENANCE_RULES: Record<string, MaintenanceRule> = {
  PLAQUETTES: { relanceMonths: 20, need: "25 000 km ou 2 ans", sms: "vos plaquettes de frein" },
  VIDANGE: { relanceMonths: 10, need: "15 000 km ou 1 an", sms: "votre vidange" },
  FILTRATION: { relanceMonths: 11, need: "1 an", sms: "vos filtres" },
  BATTERIE: { relanceMonths: 42, need: "4 ans", sms: "votre batterie" },
  AMORTISSEURS: { relanceMonths: 48, need: "80 000 km", sms: "vos amortisseurs" },
  DISTRIBUTION: { relanceMonths: 54, need: "selon constructeur (≈ 5 ans)", sms: "votre distribution" },
  ESSUIE_GLACE: { relanceMonths: 11, need: "1 an", sms: "vos balais d'essuie-glace" },
};

/* ------------------------------------------------------------------ */
/*  Dates                                                              */
/* ------------------------------------------------------------------ */

/** "2026-05-03" (or an ISO timestamp) → Date at UTC midnight; null when unparsable. */
export function parseDay(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function toDayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Calendar months added the Postgres way: Jan 31 + 1 month = Feb 28/29. */
export function addMonths(d: Date, months: number): Date {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target;
}

export function daysBetween(from: Date, to: Date): number {
  // `|| 0` turns a -0 (same day, local vs UTC construction) into a plain 0.
  return Math.round((to.getTime() - from.getTime()) / 86_400_000) || 0;
}

/** Today in Paris as a UTC-midnight Date (what the database compares with). */
export function parisToday(now: Date = new Date()): Date {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(now);
  return parseDay(s) ?? now;
}

/* ------------------------------------------------------------------ */
/*  Garantie                                                           */
/* ------------------------------------------------------------------ */

/**
 * Durée de garantie que le magasin applique sur chaque pièce vendue : 12 mois,
 * choix du magasin (2026-09-30). En droit français la garantie légale de
 * conformité d'un bien neuf est de 24 mois (Code de la consommation, L. 217-3).
 */
export const LEGAL_WARRANTY_MONTHS = 12;
/** Below this many days left the light turns orange. */
export const WARRANTY_WARNING_DAYS = 90;

export type WarrantyLight = "green" | "orange" | "red";

export type LineWarranty = {
  start: string;
  /** Légale : 12 mois + extension (mise en conformité → + 6 mois). */
  legalEnd: string;
  /** Commerciale de l'équipementier — a second, independent counter. */
  commercialEnd: string | null;
  /** The later of the two: the date that matters at the counter. */
  end: string;
  daysLeft: number;
  light: WarrantyLight;
  /** Which counter still runs: both, one, or none. */
  coverage: "LEGALE+COMMERCIALE" | "LEGALE" | "COMMERCIALE" | "EXPIREE";
};

export function lineWarranty(
  input: { start: string | null | undefined; warrantyMonths?: number | null; extensionMonths?: number | null },
  today: Date = parisToday(),
): LineWarranty | null {
  const start = parseDay(input.start);
  if (!start) return null;
  const legalEnd = addMonths(start, LEGAL_WARRANTY_MONTHS + Math.max(0, input.extensionMonths ?? 0));
  const months = input.warrantyMonths ?? null;
  const commercialEnd = months && months > 0 ? addMonths(start, months) : null;
  const end = commercialEnd && commercialEnd > legalEnd ? commercialEnd : legalEnd;
  const daysLeft = daysBetween(today, end);
  const legalOn = legalEnd >= today;
  const commercialOn = commercialEnd != null && commercialEnd >= today;
  return {
    start: toDayString(start),
    legalEnd: toDayString(legalEnd),
    commercialEnd: commercialEnd ? toDayString(commercialEnd) : null,
    end: toDayString(end),
    daysLeft,
    light: daysLeft < 0 ? "red" : daysLeft <= WARRANTY_WARNING_DAYS ? "orange" : "green",
    coverage: legalOn && commercialOn ? "LEGALE+COMMERCIALE" : legalOn ? "LEGALE" : commercialOn ? "COMMERCIALE" : "EXPIREE",
  };
}

/** « Sous garantie jusqu'au 03/05/2028 (587 j) » / « Garantie expirée depuis 12 j ». */
export function warrantyText(w: LineWarranty): string {
  const [y, m, d] = w.end.split("-");
  const end = `${d}/${m}/${y}`;
  if (w.daysLeft < 0) return `Garantie expirée depuis ${-w.daysLeft} j (${end})`;
  if (w.daysLeft === 0) return `Dernier jour de garantie (${end})`;
  return `Sous garantie jusqu'au ${end} (${w.daysLeft} j)`;
}

/**
 * Présomption d'antériorité du défaut : pendant 12 mois c'est au vendeur de
 * prouver que le défaut n'existait pas à la délivrance.
 */
export function presumptionApplies(w: LineWarranty, today: Date = parisToday()): boolean {
  const start = parseDay(w.start);
  return start != null && addMonths(start, LEGAL_WARRANTY_MONTHS) >= today;
}

/** "ab-123-cd " → "AB123CD": the key of the carnet véhicule. */
export function normalizePlate(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** "AB123CD" → "AB-123-CD" (SIV format); anything else is returned as typed. */
export function formatPlate(raw: string | null | undefined): string {
  const n = normalizePlate(raw);
  const m = /^([A-Z]{2})(\d{3})([A-Z]{2})$/.exec(n);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : (raw ?? "").trim().toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Retours : six motifs, six règles                                   */
/* ------------------------------------------------------------------ */

export type ReturnMotifCode =
  | "ERREUR_CLIENT"
  | "ERREUR_VENDEUR"
  | "NON_CONFORME"
  | "ANNULATION"
  | "PRIX_REPRISE"
  | "AUTRE"
  // Codes offered before 2026-10-01, kept so older returns still read.
  | "MAUVAISE_IDENTIFICATION"
  | "DEFECTUEUSE";

export type ReturnMotifRule = {
  code: ReturnMotifCode;
  label: string;
  /** Qui a tort. */
  fault: "Le magasin" | "Le catalogue" | "Le client" | "Le fournisseur" | "L'équipementier" | "Personne";
  /** Reprise : due, or left to the shop's commercial policy. */
  reprise: "oui" | "selon politique";
  frais: string;
  /** What the counter should do next. */
  action: string;
  /** One-click switch offered on the return: a warranty case or a supplier dispute. */
  bascule: "GARANTIE" | "LITIGE" | null;
  /** The return fee schedule (conditions de retour) applies to this reason. */
  policyApplies: boolean;
};

const SCHEDULE_FEES = "Selon les conditions de retour (20 à 40 %)";

/** The list offered at the counter and on the garage portal (2026-10-01). */
export const RETURN_MOTIFS: ReturnMotifRule[] = [
  {
    code: "ERREUR_CLIENT",
    label: "Erreur client",
    fault: "Le client",
    reprise: "selon politique",
    frais: SCHEDULE_FEES,
    action: "Appliquer les conditions de retour.",
    bascule: null,
    policyApplies: true,
  },
  {
    code: "ERREUR_VENDEUR",
    label: "Erreur magasin",
    fault: "Le magasin",
    reprise: "oui",
    frais: "Aucuns",
    action: "Tracer l'erreur — sert à former, pas à sanctionner.",
    bascule: null,
    policyApplies: false,
  },
  {
    code: "NON_CONFORME",
    label: "Pièce non conforme / HS",
    fault: "Le fournisseur",
    reprise: "oui",
    frais: "Aucuns — refacturés au fournisseur",
    action: "Ouvrir un dossier garantie ou un litige fournisseur.",
    bascule: "GARANTIE",
    policyApplies: false,
  },
  {
    code: "ANNULATION",
    label: "Annulation client",
    fault: "Le client",
    reprise: "oui",
    frais: SCHEDULE_FEES,
    action: "Remise en stock ou retour fournisseur.",
    bascule: null,
    policyApplies: true,
  },
  {
    code: "PRIX_REPRISE",
    label: "Prix / reprise commerciale",
    fault: "Personne",
    reprise: "selon politique",
    frais: SCHEDULE_FEES,
    action: "Geste commercial : appliquer les conditions de retour.",
    bascule: null,
    policyApplies: true,
  },
  {
    code: "AUTRE",
    label: "Autre",
    fault: "Personne",
    reprise: "selon politique",
    frais: SCHEDULE_FEES,
    action: "Préciser le motif dans le commentaire.",
    bascule: null,
    policyApplies: true,
  },
];

/** Reasons no longer offered, still labelled on the returns coded with them. */
const LEGACY_RETURN_MOTIFS: ReturnMotifRule[] = [
  {
    code: "MAUVAISE_IDENTIFICATION",
    label: "Mauvaise identification du véhicule",
    fault: "Le catalogue",
    reprise: "oui",
    frais: "Aucuns",
    action: "Signaler la référence au fournisseur.",
    bascule: "LITIGE",
    policyApplies: false,
  },
  {
    code: "DEFECTUEUSE",
    label: "Pièce défectueuse à la pose",
    fault: "L'équipementier",
    reprise: "oui",
    frais: SCHEDULE_FEES,
    action: "Basculer en dossier garantie.",
    bascule: "GARANTIE",
    policyApplies: true,
  },
];

export const RETURN_MOTIF_BY_CODE: Record<string, ReturnMotifRule> = Object.fromEntries(
  [...RETURN_MOTIFS, ...LEGACY_RETURN_MOTIFS].map((m) => [m.code, m]),
);

export function motifLabel(code: string | null | undefined): string {
  if (!code || code === "NON_CODE") return "Motif non codé";
  return RETURN_MOTIF_BY_CODE[code]?.label ?? code;
}

export const PART_CONDITIONS: { code: string; label: string; hint?: string }[] = [
  { code: "NEUVE_EMBALLEE", label: "Neuve, emballage d'origine" },
  { code: "EMBALLAGE_ABIME", label: "Non montée, emballage abîmé" },
  { code: "MONTEE", label: "Montée", hint: "Une pièce électrique montée n'est généralement pas reprise par l'équipementier." },
  { code: "ENDOMMAGEE", label: "Endommagée" },
];

/**
 * Is a « le client s'est trompé » return still inside the shop's commercial
 * window? (No legal right of withdrawal applies to an in-store sale.)
 */
export function withinReturnPolicy(saleDate: string | null | undefined, policyDays: number, today: Date = parisToday()): boolean | null {
  const start = parseDay(saleDate);
  if (!start) return null;
  return daysBetween(start, today) <= policyDays;
}

/* ------------------------------------------------------------------ */
/*  Dossier SAV                                                        */
/* ------------------------------------------------------------------ */

export type SavCaseType = "GARANTIE" | "LITIGE" | "RETOUR" | "CONSIGNE";

export const CASE_TYPE_LABEL: Record<string, string> = {
  GARANTIE: "Garantie",
  LITIGE: "Litige",
  RETOUR: "Retour",
  CONSIGNE: "Consigne",
};

export const CLIENT_STATUSES = ["RECU", "EN_EXPERTISE", "ACCEPTE", "REFUSE", "REMPLACE", "REMBOURSE", "CLOS"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_STATUS_LABEL: Record<string, string> = {
  RECU: "Reçu",
  EN_EXPERTISE: "En expertise",
  ACCEPTE: "Accepté",
  REFUSE: "Refusé",
  REMPLACE: "Remplacé",
  REMBOURSE: "Remboursé",
  CLOS: "Clos",
};

export const SUPPLIER_STATUSES = ["A_DECLARER", "DECLARE", "EN_ATTENTE", "ACCORDE", "REFUSE", "AVOIR_RECU", "SANS_SUITE"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const SUPPLIER_STATUS_LABEL: Record<string, string> = {
  A_DECLARER: "À déclarer",
  DECLARE: "Déclaré",
  EN_ATTENTE: "En attente de décision",
  ACCORDE: "Accordé",
  REFUSE: "Refusé",
  AVOIR_RECU: "Avoir reçu",
  SANS_SUITE: "Sans suite",
};

/** Badge tone (rt-badge--*) of a status: green = done, amber = waiting, red = problem. */
export function clientStatusTone(status: string): "green" | "amber" | "red" | "blue" | "gray" {
  if (status === "REMPLACE" || status === "REMBOURSE" || status === "ACCEPTE") return "green";
  if (status === "REFUSE") return "red";
  if (status === "EN_EXPERTISE") return "amber";
  if (status === "CLOS") return "gray";
  return "blue";
}

export function supplierStatusTone(status: string | null): "green" | "amber" | "red" | "blue" | "gray" {
  if (!status || status === "SANS_SUITE") return "gray";
  if (status === "AVOIR_RECU" || status === "ACCORDE") return "green";
  if (status === "REFUSE") return "red";
  if (status === "A_DECLARER") return "blue";
  return "amber";
}

export const PART_LOCATION_LABEL: Record<string, string> = {
  CLIENT: "Chez le client",
  MAGASIN: "Au magasin",
  EN_TRANSIT: "En transit",
  FOURNISSEUR: "Chez le fournisseur",
  REVENUE: "Revenue du fournisseur",
  DETRUITE: "Détruite",
};

export const GESTURE_LABEL: Record<string, string> = {
  AVOIR: "Avoir",
  REMISE: "Remise",
  PIECE_OFFERTE: "Pièce offerte",
  MAIN_OEUVRE: "Prise en charge de la main d'œuvre",
  AUCUN: "Aucun geste",
};

export const GESTURE_BUDGET_LABEL: Record<string, string> = {
  MAGASIN: "Enveloppe magasin",
  FOURNISSEUR: "Refacturé au fournisseur",
  PARTAGE: "Partagé magasin / fournisseur",
};

export const CORE_STATE_LABEL: Record<string, string> = {
  COMPLET: "Complet",
  INCOMPLET: "Incomplet",
  CASSE: "Cassé",
  VIDE: "Vidé de son huile",
};

export const CONSIGNE_SUPPLIER_LABEL: Record<string, string> = {
  A_RENVOYER: "À renvoyer",
  RENVOYE: "Renvoyé",
  AVOIR_RECU: "Avoir consigne reçu",
  REFUSE: "Cœur refusé",
};

/** SLA of a garage dispute: hours left (negative = overdue), null when answered or no SLA. */
export function slaHoursLeft(slaDueAt: string | null, firstResponseAt: string | null, now: Date = new Date()): number | null {
  if (!slaDueAt || firstResponseAt) return null;
  return Math.round((new Date(slaDueAt).getTime() - now.getTime()) / 3_600_000);
}

/** Main d'œuvre perdue = taux horaire du garage × temps barémé. */
export function laborAmount(rate: number | null | undefined, hours: number | null | undefined): number {
  return Math.round((rate ?? 0) * (hours ?? 0) * 100) / 100;
}

/* ------------------------------------------------------------------ */
/*  Motif de garantie                                                  */
/* ------------------------------------------------------------------ */

/** The closed list a warranty case is filed under (2026-10-01). */
export const WARRANTY_MOTIFS = [
  { code: "GA_DEFAILLANCE_RECURRENTE", label: "GA - Défaillance récurrente" },
  { code: "GA_DEFAILLANCE_SOUDAINE", label: "GA - Défaillance soudaine" },
  { code: "GA_DETERIORATION_RAPIDE", label: "GA - Détérioration rapide" },
  { code: "GA_FUITE_LIQUIDES", label: "GA - Fuite de liquides" },
  { code: "GA_MAUVAISE_QUALITE", label: "GA - Mauvaise qualité de fabrication" },
  { code: "GA_NON_CONFORMITE", label: "GA - Non-conformité" },
  { code: "GA_DEFECTUEUSE_ARRIVEE", label: "GA - Pièce défectueuse à l'arrivée" },
  { code: "GARANTIE", label: "GARANTIE" },
] as const;

export type WarrantyMotifCode = (typeof WARRANTY_MOTIFS)[number]["code"];

const WARRANTY_MOTIF_SEPARATOR = " — ";

export function warrantyMotifLabel(code: string | null | undefined): string | null {
  return WARRANTY_MOTIFS.find((m) => m.code === code)?.label ?? null;
}

/**
 * The description as sent when a warranty case is opened: the motif label
 * leads (« GA - Fuite de liquides — joint qui suinte… »). Migration
 * 20261001010000 moves it into sav_cases.warranty_motif; a database without
 * it keeps the motif readable at the start of the text.
 */
export function withWarrantyMotif(description: string, code: string | null | undefined): string {
  const label = warrantyMotifLabel(code);
  const text = description.trim();
  if (!label) return text;
  return text ? `${label}${WARRANTY_MOTIF_SEPARATOR}${text}` : label;
}

/** The reverse, for a description still carrying its motif (database before the migration). */
export function splitWarrantyMotif(description: string | null | undefined): { code: string | null; description: string | null } {
  const text = (description ?? "").trim();
  if (!text) return { code: null, description: null };
  for (const m of WARRANTY_MOTIFS) {
    if (text === m.label) return { code: m.code, description: null };
    if (text.startsWith(m.label + WARRANTY_MOTIF_SEPARATOR)) {
      return { code: m.code, description: text.slice(m.label.length + WARRANTY_MOTIF_SEPARATOR.length).trim() || null };
    }
  }
  return { code: null, description: text };
}
