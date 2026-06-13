/**
 * Best-effort extraction of a client order from an uploaded PDF
 * (bon de commande). Reads the text layer with pdf.js, rebuilds visual
 * lines, then matches the French labels used by our order documents.
 * Anything it cannot find is simply left out — the form keeps its values.
 */

export type ParsedOrderLine = {
  designation: string;
  reference: string;
  quantity: number;
  prixAchat: number;
  prixVente: number;
};

export type ParsedOrder = {
  clientName?: string;
  phone?: string;
  email?: string;
  plate?: string;
  vehicle?: string;
  /** ISO yyyy-mm-dd */
  date?: string;
  canal?: string;
  lines: ParsedOrderLine[];
  /** Human summary of what was recognised (for the success banner). */
  filled: string[];
};

/* ------------------------------------------------------------------ */
/*  Text extraction                                                   */
/* ------------------------------------------------------------------ */

async function extractPdfLines(file: File): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const lines: string[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();

    // Group text items into visual lines by their Y coordinate.
    const rows = new Map<number, { x: number; str: string }[]>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      let key: number | null = null;
      for (const k of rows.keys()) {
        if (Math.abs(k - y) <= 2) {
          key = k;
          break;
        }
      }
      if (key === null) key = y;
      const arr = rows.get(key) ?? [];
      arr.push({ x: item.transform[4], str: item.str });
      rows.set(key, arr);
    }

    const sorted = [...rows.entries()].sort((a, b) => b[0] - a[0]);
    for (const [, items] of sorted) {
      const line = items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (line) lines.push(line);
    }
  }

  return lines;
}

/* ------------------------------------------------------------------ */
/*  Parsing helpers                                                   */
/* ------------------------------------------------------------------ */

/** lowercase + strip accents, for tolerant label matching */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

const FIELD_LABELS = [
  "nom du client",
  "client existant",
  "telephone",
  "email",
  "immatriculation",
  "vehicule",
  "date de commande",
  "canal de vente",
] as const;

const SECTION_WORDS = [
  "client",
  "informations",
  "pieces",
  "piece",
  "paiement",
  "livraison",
  "designation",
  "reference",
  "fournisseur",
  "qte",
  "quantite",
  "prix achat",
  "prix vente",
  "total",
  "total commande",
  "ajouter une piece",
  "nouvelle commande",
];

function isLabelOrSection(line: string): boolean {
  const n = norm(line).replace(/\s*\*\s*$/, "");
  return (
    FIELD_LABELS.some((l) => n === l || n.startsWith(`${l} :`)) ||
    SECTION_WORDS.includes(n)
  );
}

/** Value on the same line after the label, else the next non-label line. */
function valueFor(lines: string[], idx: number, label: string): string | undefined {
  const n = norm(lines[idx]);
  const pos = n.indexOf(label);
  const rest = lines[idx]
    .slice(pos + label.length)
    .replace(/^[\s:*]+/, "")
    .trim();
  if (rest) return rest;
  const next = lines[idx + 1];
  if (next && !isLabelOrSection(next)) return next.trim();
  return undefined;
}

function parseMoney(s: string): number {
  const cleaned = s.replace(/[^\d,.]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function toIsoDate(s: string): string | undefined {
  const m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (!m) return undefined;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

const CANAUX = ["MAGASIN", "TÉLÉPHONE", "INTERNET", "B2B", "AUTRE"];

const MONEY_RE = /^[\d\s]{1,9}[.,]\d{2}\s*€?$|^[\d\s]{1,9}\s*€$/;
const QTY_RE = /^\d{1,3}$/;
const REF_RE = /^[A-Z0-9][A-Z0-9\-./]{2,}$/;

/* ------------------------------------------------------------------ */
/*  Pièces table                                                      */
/* ------------------------------------------------------------------ */

function parseLinesSection(section: string[]): ParsedOrderLine[] {
  const out: ParsedOrderLine[] = [];

  type Draft = {
    designation?: string;
    reference?: string;
    quantity?: number;
    prices: number[];
  };
  let cur: Draft = { prices: [] };

  const emit = () => {
    if (cur.designation && cur.reference) {
      const prices = cur.prices;
      // [achat, vente, total] | [vente, total] | [vente] | []
      let achat = 0;
      let vente = 0;
      if (prices.length >= 3) {
        achat = prices[0];
        vente = prices[1];
      } else if (prices.length === 2) {
        vente = prices[0];
      } else if (prices.length === 1) {
        vente = prices[0];
      }
      out.push({
        designation: cur.designation,
        reference: cur.reference,
        quantity: cur.quantity ?? 1,
        prixAchat: achat,
        prixVente: vente,
      });
    }
    cur = { prices: [] };
  };

  for (const rawLine of section) {
    const line = rawLine.trim();
    const n = norm(line);
    if (!line || n === "stock magasin" || isLabelOrSection(line)) continue;

    // Whole row on a single visual line:
    //   "Plaquette de frein GDB1322 1 12,00 € 25,00 € 25,00 €"
    const single = line.match(
      /^(.{3,})\s+([A-Z0-9][A-Z0-9\-./]{2,})\s+(\d{1,3})((?:\s+[\d\s.,]+\s*€){1,3})\s*$/,
    );
    if (single) {
      emit();
      const prices = [...single[4].matchAll(/[\d\s.,]+\s*€/g)].map((m) =>
        parseMoney(m[0]),
      );
      cur = {
        designation: single[1].trim(),
        reference: single[2],
        quantity: parseInt(single[3], 10) || 1,
        prices,
      };
      emit();
      continue;
    }

    // One cell per visual line.
    if (MONEY_RE.test(line)) {
      cur.prices.push(parseMoney(line));
    } else if (QTY_RE.test(line) && cur.designation && cur.quantity === undefined) {
      cur.quantity = parseInt(line, 10) || 1;
    } else if (REF_RE.test(line) && cur.designation && !cur.reference) {
      cur.reference = line;
    } else if (!QTY_RE.test(line) && !MONEY_RE.test(line)) {
      // A new designation starts a new row.
      if (cur.designation && cur.reference) emit();
      else cur = { prices: [] };
      cur.designation = line;
    }
  }
  emit();
  return out;
}

/* ------------------------------------------------------------------ */
/*  Main entry                                                        */
/* ------------------------------------------------------------------ */

export async function extractOrderFromPdf(file: File): Promise<ParsedOrder> {
  return parseOrderText(await extractPdfLines(file));
}

/** Pure text → order parsing (exported separately so it can be tested). */
export function parseOrderText(lines: string[]): ParsedOrder {
  const result: ParsedOrder = { lines: [], filled: [] };

  const all = lines.join("\n");

  for (let i = 0; i < lines.length; i++) {
    const n = norm(lines[i]);

    if (!result.clientName && n.includes("nom du client")) {
      const v = valueFor(lines, i, "nom du client");
      if (v) {
        result.clientName = v;
        result.filled.push("client");
      }
    } else if (!result.phone && (n === "telephone" || n.startsWith("telephone"))) {
      const v = valueFor(lines, i, "telephone");
      if (v) {
        result.phone = v;
        result.filled.push("téléphone");
      }
    } else if (!result.email && n.startsWith("email")) {
      const v = valueFor(lines, i, "email");
      if (v) {
        result.email = v;
        result.filled.push("email");
      }
    } else if (!result.plate && n.startsWith("immatriculation")) {
      const v = valueFor(lines, i, "immatriculation");
      if (v) {
        result.plate = v;
        result.filled.push("immatriculation");
      }
    } else if (!result.vehicle && n.startsWith("vehicule")) {
      const v = valueFor(lines, i, "vehicule");
      if (v) {
        result.vehicle = v;
        result.filled.push("véhicule");
      }
    } else if (!result.date && n.includes("date de commande")) {
      const v = valueFor(lines, i, "date de commande");
      const iso = v ? toIsoDate(v) : undefined;
      if (iso) {
        result.date = iso;
        result.filled.push("date");
      }
    } else if (!result.canal && n.includes("canal de vente")) {
      const v = valueFor(lines, i, "canal de vente");
      if (v) {
        const canal = CANAUX.find((c) => norm(c) === norm(v));
        if (canal) {
          result.canal = canal;
          result.filled.push("canal");
        }
      }
    }
  }

  /* Fallbacks on the whole document */
  if (!result.email) {
    const m = all.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    if (m) {
      result.email = m[0];
      result.filled.push("email");
    }
  }
  if (!result.phone) {
    const m = all.match(/(?:\+33|0)\s?[1-9](?:[\s.-]?\d{2}){4}/);
    if (m) {
      result.phone = m[0].trim();
      result.filled.push("téléphone");
    }
  }
  if (!result.plate) {
    const m = all.match(/\b[A-Z]{2}-?\d{3}-?[A-Z]{2}\b/);
    if (m) {
      result.plate = m[0];
      result.filled.push("immatriculation");
    }
  }

  /* Pièces section: from the "Désignation"/"Pièces" header to the total. */
  const startIdx = lines.findIndex((l) => {
    const n = norm(l);
    return n.startsWith("designation") || n === "pieces";
  });
  if (startIdx !== -1) {
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const n = norm(lines[i]);
      if (n.startsWith("total commande") || n.startsWith("paiement")) {
        endIdx = i;
        break;
      }
    }
    result.lines = parseLinesSection(lines.slice(startIdx + 1, endIdx));
    if (result.lines.length > 0) {
      result.filled.push(`${result.lines.length} pièce(s)`);
    }
  }

  return result;
}
