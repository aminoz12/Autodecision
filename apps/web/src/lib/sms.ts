/**
 * SMS to the client — pure helpers shared by the browser (live preview in
 * Paramètres and in the « Prévenir par SMS » modal) and the server
 * (/api/send-sms builds the exact same text before handing it to Twilio).
 *
 * Nothing here touches Supabase or the environment.
 */

export type SmsKind = "READY" | "PARTIAL";

export const SMS_DEFAULT_HORAIRES = "Lun-Sam 9h-18h30";

/** Toutes les pièces de la commande sont arrivées. */
export const SMS_DEFAULT_READY_TEMPLATE =
  "Bonjour {client}, votre commande {commande} est prête à être récupérée au magasin. " +
  "Horaires : {horaires}. Merci et à très bientôt !";

/** Une partie seulement (reliquat en cours). */
export const SMS_DEFAULT_PARTIAL_TEMPLATE =
  "Bonjour {client}, une partie de votre commande {commande} est arrivée au magasin (le reste suivra). " +
  "Horaires : {horaires}. Merci et à bientôt !";

/** Hard cap on one message (4 GSM-7 segments). */
export const SMS_MAX_LENGTH = 640;

/** Placeholders accepted in a template: {client} {commande} {horaires} {magasin}. */
export const SMS_PLACEHOLDERS = ["client", "commande", "horaires", "magasin"] as const;

/** Per-magasin wording; null = default text above. */
export type SmsSettings = {
  magasin: string;
  horaires: string | null;
  readyTemplate: string | null;
  partialTemplate: string | null;
};

export type SmsVars = { client: string; commande: string; horaires: string; magasin: string };

export type SmsSize = {
  encoding: "GSM-7" | "UCS-2";
  /** Septets (GSM-7) or UTF-16 units (UCS-2): what the operator bills on. */
  chars: number;
  segments: number;
};

/* ------------------------------------------------------------------ */
/*  Template                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fill the placeholders (case-insensitive, `{ client }` tolerated). Unknown
 * placeholders are left as typed so a typo is visible in the preview.
 */
export function renderSmsTemplate(template: string, vars: SmsVars): string {
  const filled = template.replace(/\{\s*([a-z]+)\s*\}/gi, (m, key: string) => {
    const k = key.toLowerCase();
    return k in vars ? vars[k as keyof SmsVars] : m;
  });
  return filled
    .replace(/[ \t]+,/g, ",") // "Bonjour ," when the client has no name
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, SMS_MAX_LENGTH);
}

/* ------------------------------------------------------------------ */
/*  GSM 03.38 alphabet — one accent outside it (ê, ô, ç…) switches the */
/*  whole message to UCS-2: 70 chars per segment instead of 160.       */
/* ------------------------------------------------------------------ */

const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
/** Escaped characters: two septets each. */
const GSM7_EXT = "\f^{}\[~]|€";

function gsmWeight(ch: string): number | null {
  if (GSM7_BASIC.includes(ch)) return 1;
  if (GSM7_EXT.includes(ch)) return 2;
  return null;
}

const GSM7_MAP: Record<string, string> = {
  "œ": "oe",
  "Œ": "OE",
  "’": "'",
  "‘": "'",
  "“": '"',
  "”": '"',
  "«": '"',
  "»": '"',
  "…": "...",
  "–": "-",
  "—": "-",
  " ": " ",
  " ": " ",
  " ": " ",
};

/**
 * Bring a French text into the GSM-7 alphabet: é è à ù are kept, the accents
 * GSM lacks are dropped (prête → prete, bientôt → bientot, ç → c), typographic
 * quotes and dashes become ASCII. Characters that still don't fit (emoji…)
 * are left as is — the message then goes out as UCS-2.
 */
export function toGsm7(text: string): string {
  let out = "";
  // « ici » → "ici" (the inner spaces belong to the guillemets).
  for (const ch of text.replace(/«\s*/g, '"').replace(/\s*»/g, '"')) {
    if (gsmWeight(ch) != null) {
      out += ch;
      continue;
    }
    const mapped = GSM7_MAP[ch];
    if (mapped != null) {
      out += mapped;
      continue;
    }
    const plain = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
    out += plain && plain !== ch && gsmWeight(plain) != null ? plain : ch;
  }
  return out;
}

/** Encoding, billable length and number of segments of a message. */
export function smsSize(text: string): SmsSize {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    const w = gsmWeight(ch);
    if (w == null) {
      gsm = false;
      break;
    }
    septets += w;
  }
  if (gsm) {
    return {
      encoding: "GSM-7",
      chars: septets,
      segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }
  const units = text.length;
  return {
    encoding: "UCS-2",
    chars: units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
  };
}

/* ------------------------------------------------------------------ */
/*  Phone numbers                                                     */
/* ------------------------------------------------------------------ */

/**
 * "06 12 34 56 78", "+33 6 12 34 56 78", "0033612345678", "(0)6…" → "+33612345678".
 * National numbers get `defaultCountryCode` (33 = France). Null when the
 * result is not a plausible E.164 number (8 to 15 digits).
 */
export function toE164(raw: string | null | undefined, defaultCountryCode = "33"): string | null {
  const cc = (defaultCountryCode || "33").replace(/\D/g, "");
  const trimmed = (raw ?? "").trim().replace(/\(0\)/g, "");
  if (!trimmed) return null;
  const international = trimmed.startsWith("+");
  let d = trimmed.replace(/\D/g, "");
  if (!d) return null;
  if (!international) {
    if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("0")) d = cc + d.slice(1);
    else if (!d.startsWith(cc)) d = cc + d;
  }
  if (d.length < 8 || d.length > 15) return null;
  return "+" + d;
}

/** "+33612345678" → "+33 6 12 34 56 78" (other countries are shown as is). */
export function formatE164(e164: string): string {
  const m = /^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(e164);
  return m ? `+33 ${m[1]} ${m[2]} ${m[3]} ${m[4]} ${m[5]}` : e164;
}

/* ------------------------------------------------------------------ */
/*  The message itself                                                */
/* ------------------------------------------------------------------ */

/**
 * The exact text sent for an order: magasin template (or default), filled,
 * then normalised to GSM-7 so the usual message fits in one SMS.
 */
export function buildClientSms(
  kind: SmsKind,
  vars: { client: string; commande: string },
  settings: SmsSettings,
): { text: string; size: SmsSize } {
  const custom = kind === "READY" ? settings.readyTemplate : settings.partialTemplate;
  const template =
    custom?.trim() || (kind === "READY" ? SMS_DEFAULT_READY_TEMPLATE : SMS_DEFAULT_PARTIAL_TEMPLATE);
  const text = toGsm7(
    renderSmsTemplate(template, {
      client: vars.client.trim(),
      commande: vars.commande.trim(),
      horaires: settings.horaires?.trim() || SMS_DEFAULT_HORAIRES,
      magasin: settings.magasin.trim(),
    }),
  );
  return { text, size: smsSize(text) };
}

/* ------------------------------------------------------------------ */
/*  Messages après-vente (file d'attente sms_notifications.kind)       */
/* ------------------------------------------------------------------ */

/**
 * Kinds queued by the database (migration 20260920020000). READY reuses the
 * magasin's « commande prête » template above; the others have a default
 * here that the magasin can override in Paramètres → Après-vente
 * (sav_settings.templates, keyed by kind).
 */
export type QueuedSmsKind =
  | "READY"
  | "DELAY"
  | "DELAY_NODATE"
  | "PICKUP_3"
  | "PICKUP_7"
  | "PICKUP_15"
  | "CONSIGNE_REMINDER"
  | "SATISFACTION"
  | "AVOIR_BALANCE"
  | "AVOIR_DORMANT"
  | "MAINTENANCE";

export const QUEUED_SMS_LABEL: Record<QueuedSmsKind, string> = {
  READY: "Commande prête",
  DELAY: "Retard fournisseur (nouvelle date)",
  DELAY_NODATE: "Retard fournisseur (sans date)",
  PICKUP_3: "Pièce non retirée — J+3",
  PICKUP_7: "Pièce non retirée — J+7",
  PICKUP_15: "Pièce non retirée — J+15",
  CONSIGNE_REMINDER: "Consigne à rapporter — J-10",
  SATISFACTION: "La pièce vous convient ?",
  AVOIR_BALANCE: "Solde d'avoir",
  AVOIR_DORMANT: "Avoir dormant",
  MAINTENANCE: "Relance d'entretien",
};

export const QUEUED_SMS_DEFAULTS: Record<Exclude<QueuedSmsKind, "READY">, string> = {
  DELAY:
    "Bonjour {client}, votre commande {commande} a du retard chez le fournisseur : nouvelle date prévue le {date}. Nous vous tenons au courant. {magasin}",
  DELAY_NODATE:
    "Bonjour {client}, une pièce de votre commande {commande} a du retard chez le fournisseur. Nous vous prévenons dès son arrivée. {magasin}",
  PICKUP_3:
    "Bonjour {client}, votre commande {commande} vous attend au magasin. Horaires : {horaires}. A bientôt ! {magasin}",
  PICKUP_7:
    "Bonjour {client}, votre commande {commande} vous attend au magasin depuis une semaine. Horaires : {horaires}. {magasin}",
  PICKUP_15:
    "Bonjour {client}, votre commande {commande} vous attend depuis 15 jours. Sans nouvelles, nous vous proposerons un remboursement ou une remise en stock. {magasin}",
  CONSIGNE_REMINDER:
    "Bonjour {client}, pensez à rapporter votre ancienne pièce ({piece}) avant le {date} pour récupérer votre consigne de {montant} €. {magasin}",
  SATISFACTION: "Bonjour {client}, la pièce achetée chez {magasin} vous convient ? Dites-le nous en 1 clic : {lien}",
  AVOIR_BALANCE: "Bonjour {client}, vous avez {montant} € d'avoir chez {magasin}, valable jusqu'au {date}. A bientôt ! STOP : {stop}",
  AVOIR_DORMANT: "Bonjour {client}, vous avez toujours {montant} € d'avoir chez {magasin}, valable jusqu'au {date}. A bientôt ! STOP : {stop}",
  MAINTENANCE: "Bonjour {client}, c'est le moment de faire contrôler {piece} {vehicule}. Passez chez {magasin} ! STOP : {stop}",
};

/** Placeholders a magasin may use when it rewrites one of the messages above. */
export const QUEUED_SMS_PLACEHOLDERS: Record<Exclude<QueuedSmsKind, "READY">, string[]> = {
  DELAY: ["client", "commande", "date", "magasin"],
  DELAY_NODATE: ["client", "commande", "magasin"],
  PICKUP_3: ["client", "commande", "horaires", "magasin"],
  PICKUP_7: ["client", "commande", "horaires", "magasin"],
  PICKUP_15: ["client", "commande", "horaires", "magasin"],
  CONSIGNE_REMINDER: ["client", "piece", "date", "montant", "magasin"],
  SATISFACTION: ["client", "magasin", "lien"],
  AVOIR_BALANCE: ["client", "montant", "date", "magasin", "stop"],
  AVOIR_DORMANT: ["client", "montant", "date", "magasin", "stop"],
  MAINTENANCE: ["client", "piece", "vehicule", "magasin", "stop"],
};

export function isQueuedSmsKind(kind: unknown): kind is QueuedSmsKind {
  return typeof kind === "string" && (kind === "READY" || kind in QUEUED_SMS_DEFAULTS);
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\s*([a-z]+)\s*\}/gi, (m, key: string) => {
      const k = key.toLowerCase();
      return k in vars ? vars[k] : m;
    })
    .replace(/\(\s*\)/g, "") // "( )" when an optional variable is empty
    .replace(/[ \t]+([,.])/g, "$1") // French keeps its space before « : ! ? »
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, SMS_MAX_LENGTH);
}

/**
 * The exact text of a queued message. `vars` come from the database row,
 * `links` are the public URLs built by the server (satisfaction page, STOP page).
 */
export function buildQueuedSms(
  kind: QueuedSmsKind,
  vars: Record<string, unknown>,
  settings: SmsSettings & { templates?: Record<string, string> | null },
  links: { lien?: string; stop?: string } = {},
): { text: string; size: SmsSize } {
  const s = (v: unknown): string => (v == null ? "" : String(v).trim());
  if (kind === "READY") {
    return buildClientSms("READY", { client: s(vars.client), commande: s(vars.commande) }, settings);
  }
  const custom = settings.templates?.[kind]?.trim();
  const text = toGsm7(
    fillTemplate(custom || QUEUED_SMS_DEFAULTS[kind], {
      client: s(vars.client),
      commande: s(vars.commande),
      date: s(vars.date),
      piece: s(vars.piece),
      montant: s(vars.montant),
      vehicule: s(vars.vehicule) ? `(${s(vars.vehicule)})` : "",
      horaires: settings.horaires?.trim() || SMS_DEFAULT_HORAIRES,
      magasin: settings.magasin.trim(),
      lien: links.lien ?? "",
      stop: links.stop ?? "",
    }),
  );
  return { text, size: smsSize(text) };
}
