/**
 * Best-effort extraction of a client order from an uploaded PDF.
 *
 * Two layouts are understood:
 *  1. Our own "bon de commande" (labels like "Nom du client", "Désignation").
 *  2. A garage "devis" (e.g. the ESPACE AUTO 92 quote): company block on the
 *     left, client block on the right ("Client N°", "Tel :", "Véhicule :",
 *     "Immatriculation :"), then a "Liste des pièces" table with a header row
 *     (Référence / Désignation / P.U. HT / P.U. TTC / Quantité / Total …).
 *
 * The text layer is read with pdf.js, grouped into visual rows by Y, and each
 * row is split into cells wherever there is a large horizontal gap. That keeps
 * the left and right columns apart and gives the table one cell per column.
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
  /** Client number printed on the document (e.g. "CU18334"). */
  clientNumber?: string;
  phone?: string;
  email?: string;
  plate?: string;
  vehicle?: string;
  motorisation?: string;
  mileage?: string;
  /** ISO yyyy-mm-dd */
  date?: string;
  canal?: string;
  /** Quote number printed on the document (e.g. "DE16409"). */
  devisNumber?: string;
  lines: ParsedOrderLine[];
  /** Human summary of what was recognised (for the success banner). */
  filled: string[];
};

/* ------------------------------------------------------------------ */
/*  Text extraction                                                   */
/* ------------------------------------------------------------------ */

/** One positioned text run from pdf.js (PDF user-space units, y grows upward). */
export type PdfTextItem = { x: number; y: number; w: number; h: number; str: string };
/** `x2` is the right edge (absent on hand-written rows): numbers are matched to columns by it. */
export type PdfCell = { x: number; text: string; x2?: number };
export type PdfRow = { y: number; cells: PdfCell[] };

const ROW_Y_TOLERANCE = 2.5;
/** « 1 234,56 », « 45,00 € », « 20,00 % »: an amount that already has its decimals. */
const COMPLETE_AMOUNT = /^[-+]?[\d\s.]*\d[.,]\d{2,3}\s*(?:€|%)?$/;

/**
 * Group text runs into visual rows (top → bottom) and split each row into
 * cells (left → right) wherever the horizontal gap exceeds roughly one line
 * height — words inside a phrase sit a couple of points apart, table columns
 * and page columns are ≥ 12pt apart. One exception: an amount that already has
 * its decimals is complete, so digits that follow start the next cell however
 * close they are — two wide numbers in neighbouring columns nearly touch.
 */
export function groupItemsIntoRows(items: PdfTextItem[]): PdfRow[] {
  const rows: { y: number; items: PdfTextItem[] }[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    let row = rows.find((r) => Math.abs(r.y - it.y) <= ROW_Y_TOLERANCE);
    if (!row) {
      row = { y: it.y, items: [] };
      rows.push(row);
    }
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y);

  return rows.map((r) => {
    const sorted = [...r.items].sort((a, b) => a.x - b.x);
    const cells: PdfCell[] = [];
    let cur: PdfCell | null = null;
    let end = -Infinity;
    for (const it of sorted) {
      const gap = it.x - end;
      const threshold = Math.max(8, it.h || 0);
      const nextColumn = cur !== null && COMPLETE_AMOUNT.test(cur.text.trim()) && /^[-+]?\d/.test(it.str.trim());
      if (cur && gap <= threshold && !nextColumn) {
        cur.text += ` ${it.str}`;
      } else {
        cur = { x: it.x, text: it.str };
        cells.push(cur);
      }
      const right = it.x + (it.w || 0);
      cur.x2 = Math.max(cur.x2 ?? right, right);
      end = Math.max(end, right);
    }
    return {
      y: r.y,
      cells: cells
        .map((c) => ({ x: c.x, x2: c.x2, text: c.text.replace(/\s+/g, " ").trim() }))
        .filter((c) => c.text),
    };
  });
}

async function extractPdfRows(file: File): Promise<PdfRow[]> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const items: PdfTextItem[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Keep page order: later pages get a large negative Y offset.
    const pageOffset = (p - 1) * 100000;
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      items.push({
        x: item.transform[4],
        y: item.transform[5] - pageOffset,
        w: item.width,
        h: item.height,
        str: item.str,
      });
    }
  }

  return groupItemsIntoRows(items);
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

/**
 * "1 234,50 €" → 1234.5 · "120.833 €" → 120.833 · "1.234,00" → 1234
 * When both separators appear the last one is the decimal mark; a single
 * separator is always treated as the decimal mark (a repeated one is a
 * thousands separator). Only the FIRST amount of the text is read: when two
 * columns ran together ("12 345,67 14 814,80") the second one is not glued on.
 */
export function parseMoney(s: string): number {
  const first = s.match(/[-+]?(?:\d{1,3}(?:\s\d{3})+|\d+)(?:[.,]\d+)*/);
  if (!first) return 0;
  let t = first[0].replace(/\s/g, "");
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    const dec = lastComma > lastDot ? "," : ".";
    const thou = dec === "," ? "." : ",";
    t = t.split(thou).join("").replace(dec, ".");
  } else {
    const sep = lastComma !== -1 ? "," : lastDot !== -1 ? "." : null;
    if (sep) {
      const count = t.split(sep).length - 1;
      t = count > 1 ? t.split(sep).join("") : t.replace(sep, ".");
    }
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

/** A quantity as documents print it: "2", "1,00", "12.000", "1 500", "x 3" — at least 1. */
export function parseQuantity(s: string): number {
  return Math.max(1, Math.round(parseMoney(s)) || 1);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function toIsoDate(s: string): string | undefined {
  const m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (!m) return undefined;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function cleanPlate(s: string): string {
  return s.toUpperCase().replace(/\s+/g, "").trim();
}

const CANAUX = ["MAGASIN", "TÉLÉPHONE", "INTERNET", "B2B", "AUTRE"];

const MONEY_RE = /^[\d\s]{1,9}[.,]\d{2,3}\s*€?$|^[\d\s]{1,9}\s*€$/;
const QTY_RE = /^\d{1,3}$/;
const REF_RE = /^[A-Z0-9][A-Z0-9\-./]{2,}$/;
const PHONE_RE = /(?:\+33|0)\s?[1-9](?:[\s.-]?\d{2}){4}/;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;

/* ------------------------------------------------------------------ */
/*  Layout 1 — our own bon de commande (line based)                   */
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

/** Pure text → order parsing for our own bon de commande layout. */
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
        result.plate = cleanPlate(v);
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
      // "TÉLÉPHONE" is both a canal and a field label, so look at the raw next line too.
      const v = valueFor(lines, i, "canal de vente") ?? lines[i + 1];
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
    const m = all.match(EMAIL_RE);
    if (m) {
      result.email = m[0];
      result.filled.push("email");
    }
  }
  if (!result.phone) {
    const m = all.match(PHONE_RE);
    if (m) {
      result.phone = m[0].trim();
      result.filled.push("téléphone");
    }
  }
  if (!result.plate) {
    const m = all.match(/\b[A-Z]{2}-?\d{3}-?[A-Z]{2}\b/);
    if (m) {
      result.plate = cleanPlate(m[0]);
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

/* ------------------------------------------------------------------ */
/*  Layout 2 — garage devis (cell based)                              */
/* ------------------------------------------------------------------ */

type ColKey =
  | "reference"
  | "designation"
  | "puHt"
  | "puTtc"
  | "achat"
  | "vente"
  | "qty"
  | "totalHt"
  | "totalTtc"
  | "otherNum"
  | "other";

/** Columns that hold numbers (a price, a quantity, a rate). */
const NUMERIC_KEYS: ReadonlySet<ColKey> = new Set(["puHt", "puTtc", "achat", "vente", "qty", "totalHt", "totalTtc", "otherNum"]);
const AMOUNT_KEYS: ColKey[] = ["qty", "puHt", "puTtc", "achat", "vente", "totalHt", "totalTtc"];

function headerKey(text: string): ColKey | null {
  const n = norm(text).replace(/\s+/g, " ");
  if (/^(reference|ref\.?|refe?rence article|code)$/.test(n)) return "reference";
  if (/^(designation|libelle|description|article|produit)$/.test(n)) return "designation";
  if (/^(quantite|qte\.?|qty|qt)$/.test(n)) return "qty";
  if (/^(total|montant)\s*ht$/.test(n)) return "totalHt";
  if (/^(total|montant)\s*(ttc)?$/.test(n)) return "totalTtc";
  if (/^(p\.?\s*u\.?|prix unitaire|prix|pu)\s*ht$/.test(n)) return "puHt";
  if (/^(p\.?\s*u\.?|prix unitaire|prix|pu)\s*ttc$/.test(n)) return "puTtc";
  if (/^(p\.?\s*u\.?|prix unitaire|pu)$/.test(n)) return "puTtc";
  if (/^(prix|p\.?)\s*(d')?achat$/.test(n) || n === "pa") return "achat";
  if (/^(prix|p\.?)\s*(de )?vente$/.test(n) || n === "pv") return "vente";
  if (/^(tva|remise|stock)( ?%)?$/.test(n)) return "otherNum";
  if (/^(fournisseur|unite|marque)$/.test(n)) return "other";
  return null;
}

type HeaderCol = { key: ColKey; x: number; x2?: number };
type TableHeader = { rowIdx: number; cols: HeaderCol[] };

/** The columns of a row when it is the table's header row, else null. */
function headerCols(row: PdfRow): HeaderCol[] | null {
  const cols: HeaderCol[] = [];
  let unknown = 0;
  for (const c of row.cells) {
    const key = headerKey(c.text);
    if (key) cols.push({ key, x: c.x, x2: c.x2 });
    else unknown++;
  }
  const keys = new Set(cols.map((c) => c.key));
  const hasPrice = (["puHt", "puTtc", "vente", "totalHt", "totalTtc"] as ColKey[]).some((k) => keys.has(k));
  return keys.has("designation") && (keys.has("reference") || keys.has("qty")) && hasPrice && unknown <= 1 ? cols : null;
}

function findTableHeader(rows: PdfRow[]): TableHeader | null {
  for (let i = 0; i < rows.length; i++) {
    const cols = headerCols(rows[i]);
    if (cols) return { rowIdx: i, cols };
  }
  return null;
}

function isNumericCell(text: string): boolean {
  return /\d/.test(text) && /^[-+]?[\d\s.,]+\s*(?:€|%)?$/.test(text);
}

/** Column whose left edge is the closest one at or before the cell (text is left-aligned). */
function columnByLeftEdge(cols: HeaderCol[], x: number): ColKey {
  let best = cols[0];
  for (const col of cols) {
    if (col.x <= x + 6 && col.x >= best.x) best = col;
  }
  return best.key;
}

/** The grand totals under the table: the table is over (until its header is printed again). */
function isTableEnd(row: PdfRow): boolean {
  const first = norm(row.cells[0]?.text ?? "");
  return (
    /^(total|tva|net a payer|montant (total|ttc|ht)|remise|acompte|conditions|signature|bon pour accord|arrete)/.test(first) &&
    row.cells.length <= 3
  );
}

/** A running total at the bottom or top of a page: the table goes on. */
function isPageSubtotal(row: PdfRow): boolean {
  return /^(sous[- ]?total|report\b|a reporter|total (de la )?page|total a reporter)/.test(norm(row.cells[0]?.text ?? ""));
}

/** Page furniture printed around the table: page numbers, legal mentions of the footer. */
function isPageNoise(row: PdfRow): boolean {
  const text = norm(row.cells.map((c) => c.text).join(" "));
  return (
    /^page\s*\d+/.test(text) ||
    /^\d+\s*\/\s*\d+$/.test(text) ||
    /\b(siret|siren|capital de|rcs|tva intracom|n° tva|iban|bic|code ape|naf)\b/.test(text)
  );
}

/** Rows a page further down carry this much negative Y (see extractPdfRows). */
const PAGE_GAP = 50000;

type NumericAnchors = { mode: "right" | "left" | "center"; cols: { key: ColKey; at: number }[] };

function anchorOf(cell: PdfCell, mode: NumericAnchors["mode"]): number {
  const x2 = cell.x2 ?? cell.x;
  return mode === "right" ? x2 : mode === "left" ? cell.x : (cell.x + x2) / 2;
}

function cluster(values: number[], tolerance: number): { center: number; n: number }[] {
  const out: { center: number; n: number; sum: number }[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && Math.abs(v - last.center) <= tolerance) {
      last.sum += v;
      last.n += 1;
      last.center = last.sum / last.n;
    } else {
      out.push({ center: v, n: 1, sum: v });
    }
  }
  return out;
}

/**
 * Where the numeric columns really are, measured on the numbers themselves.
 *
 * A header label says little about it: "P.U. HT" may sit left, centred or right
 * over numbers that are right-aligned, and a wide amount ("12 345,67") starts
 * well to the left of a short one. But every number of one column shares an
 * edge. So the numbers of the whole table are grouped by right edge (then left
 * edge, then centre); when that gives exactly as many groups as the header has
 * numeric columns, the groups ARE the columns, left to right.
 */
function inferNumericAnchors(rows: PdfRow[], header: TableHeader): NumericAnchors | null {
  const numericCols = header.cols.filter((c) => NUMERIC_KEYS.has(c.key)).sort((a, b) => a.x - b.x);
  const textCols = header.cols.filter((c) => !NUMERIC_KEYS.has(c.key));
  if (numericCols.length === 0) return null;

  const cells: PdfCell[] = [];
  for (let i = header.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (headerCols(row) || isTableEnd(row) || isPageSubtotal(row) || isPageNoise(row)) continue;
    for (const c of row.cells) {
      if (c.x2 === undefined || !isNumericCell(c.text)) continue;
      // An all-digit reference sits under its own (text) header, left-aligned.
      if (textCols.some((t) => Math.abs(c.x - t.x) <= 6)) continue;
      cells.push(c);
    }
  }
  if (cells.length < numericCols.length * 2) return null;

  let best: NumericAnchors | null = null;
  let bestCover = 0;
  for (const mode of ["right", "left", "center"] as const) {
    const groups = cluster(cells.map((c) => anchorOf(c, mode)), 2.5);
    const biggest = Math.max(...groups.map((g) => g.n));
    const kept = groups.filter((g) => g.n >= Math.max(2, biggest * 0.25));
    if (kept.length !== numericCols.length) continue;
    const cover = kept.reduce((sum, g) => sum + g.n, 0) / cells.length;
    if (cover > bestCover) {
      bestCover = cover;
      best = { mode, cols: kept.map((g, i) => ({ key: numericCols[i].key, at: g.center })) };
    }
  }
  return best && bestCover >= 0.8 ? best : null;
}

/** The column of a cell: numbers by the measured anchors, text (and anything else) by the header. */
function columnFor(header: TableHeader, anchors: NumericAnchors | null, cell: PdfCell): ColKey {
  if (isNumericCell(cell.text) && cell.x2 !== undefined) {
    const textCols = header.cols.filter((c) => !NUMERIC_KEYS.has(c.key));
    const underText = textCols.some((t) => Math.abs(cell.x - t.x) <= 6);
    if (!underText) {
      if (anchors) {
        const at = anchorOf(cell, anchors.mode);
        const nearest = anchors.cols.reduce((a, b) => (Math.abs(b.at - at) < Math.abs(a.at - at) ? b : a));
        if (Math.abs(nearest.at - at) <= 6) return nearest.key;
      }
      // No measured anchors: the header span the number overlaps most, else the nearest edge.
      let best: HeaderCol | null = null;
      let bestScore = -Infinity;
      for (const col of header.cols) {
        if (col.x2 === undefined) continue;
        const overlap = Math.min(cell.x2, col.x2) - Math.max(cell.x, col.x);
        const score = overlap > 0 ? overlap : -Math.min(Math.abs(cell.x - col.x), Math.abs(cell.x2 - col.x2));
        if (score > bestScore) {
          bestScore = score;
          best = col;
        }
      }
      if (best) return best.key;
    }
  }
  return columnByLeftEdge(header.cols, cell.x);
}

function parseDevisTable(rows: PdfRow[], first: TableHeader): ParsedOrderLine[] {
  const out: ParsedOrderLine[] = [];
  type Draft = Partial<Record<ColKey, string>>;
  let header = first;
  const anchors = inferNumericAnchors(rows, first);
  let cur: Draft | null = null;
  /** Left edge of the current line's designation: a wrapped line continues right under it. */
  let curX: number | null = null;
  /** False after the grand totals, until the header is printed again. */
  let active = true;
  let prevY: number | null = null;

  const emit = () => {
    if (!cur) return;
    const designation = (cur.designation ?? "").trim();
    const reference = (cur.reference ?? "").trim();
    if (designation || reference) {
      const qty = parseQuantity(cur.qty ?? "1");
      const pick = (k: ColKey) => (cur && cur[k] && /\d/.test(cur[k]!) ? parseMoney(cur[k]!) : undefined);
      const vente =
        pick("vente") ??
        pick("puTtc") ??
        pick("puHt") ??
        (pick("totalTtc") !== undefined ? pick("totalTtc")! / qty : undefined) ??
        (pick("totalHt") !== undefined ? pick("totalHt")! / qty : undefined) ??
        0;
      out.push({
        designation: designation || reference,
        reference,
        quantity: qty,
        prixAchat: round2(pick("achat") ?? 0),
        prixVente: round2(vente),
      });
    }
    cur = null;
    curX = null;
  };

  for (let i = first.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.cells.length === 0) continue;
    const newPage = prevY !== null && prevY - row.y > PAGE_GAP;
    const gapY = prevY === null ? 0 : prevY - row.y;
    prevY = row.y;
    // A line never continues over a page break.
    if (newPage) emit();

    // The header printed again at the top of a page: the table goes on.
    const again = headerCols(row);
    if (again) {
      emit();
      header = { rowIdx: i, cols: again };
      active = true;
      continue;
    }
    if (isPageSubtotal(row)) {
      emit();
      continue;
    }
    if (isTableEnd(row)) {
      emit();
      active = false;
      continue;
    }
    if (!active || isPageNoise(row)) continue;

    const cells: Draft = {};
    let designationX: number | null = null;
    for (const c of row.cells) {
      const key = columnFor(header, anchors, c);
      if (key === "designation" && designationX === null) designationX = c.x;
      cells[key] = cells[key] ? `${cells[key]} ${c.text}` : c.text;
    }

    // A line of the table carries at least one number (quantity, price or total).
    const hasNumber = AMOUNT_KEYS.some((k) => cells[k] !== undefined && isNumericCell(cells[k]!));
    if (!hasNumber) {
      // Text only: the rest of a wrapped designation — right under it, same left
      // edge — or something that is not part of the table (page header, footer).
      const wraps =
        cur !== null && cells.designation !== undefined && !cells.reference && gapY <= 30 &&
        (curX === null || designationX === null || Math.abs(designationX - curX) <= 4);
      if (wraps && cur) cur.designation = `${cur.designation ?? ""} ${cells.designation}`.trim();
      continue;
    }
    if (!cells.reference && !cells.designation) continue;

    emit();
    cur = cells;
    curX = designationX;
  }
  emit();
  return out;
}

function isDevisLayout(rows: PdfRow[]): boolean {
  for (const r of rows) {
    for (const c of r.cells) {
      const n = norm(c.text);
      if (/^(devis|facture|proforma|pro-forma)\s*n/.test(n)) return true;
      if (/^client\s*n[°o]?/.test(n)) return true;
    }
  }
  const header = findTableHeader(rows);
  return Boolean(header && header.cols.some((c) => c.key === "puHt" || c.key === "puTtc"));
}

/** Text after "Label :" in a cell, or the next cell on the same row. */
function labelValue(row: PdfRow, cell: PdfCell): string | undefined {
  const m = cell.text.match(/^[^:]{2,30}:\s*(.*)$/);
  if (m && m[1].trim()) return m[1].trim();
  const next = row.cells.find((c) => c.x > cell.x && c.x - cell.x < 260);
  if (next && !/^[^:]{2,30}:/.test(next.text)) return next.text.trim();
  return undefined;
}

/** Pure rows → order parsing for the garage devis layout. */
export function parseDevisRows(rows: PdfRow[]): ParsedOrder {
  const result: ParsedOrder = { lines: [], filled: [] };

  // Locate the client block: the "Client N°" cell, or the "Véhicule :" label.
  let clientX: number | null = null;
  let clientRowIdx = -1;
  for (let i = 0; i < rows.length && clientX === null; i++) {
    for (const c of rows[i].cells) {
      const n = norm(c.text);
      if (/^client\s*n[°o]?\b/.test(n)) {
        clientX = c.x;
        clientRowIdx = i;
        const m = c.text.match(/n[°o]?\s*:?\s*([A-Z0-9-]+)\s*$/i);
        if (m) result.clientNumber = m[1];
        break;
      }
    }
  }
  if (clientX === null) {
    for (let i = 0; i < rows.length && clientX === null; i++) {
      for (const c of rows[i].cells) {
        if (/^(vehicule|immatriculation)\s*:/.test(norm(c.text))) {
          clientX = c.x;
          break;
        }
      }
    }
  }

  const inClientColumn = (c: PdfCell) => clientX === null || Math.abs(c.x - clientX) <= 12;

  // Client name: first non-label cell in the client column below "Client N°".
  if (clientRowIdx !== -1) {
    for (let i = clientRowIdx + 1; i < rows.length; i++) {
      const c = rows[i].cells.find(inClientColumn);
      if (!c) continue;
      if (/^[^:]{2,30}:/.test(c.text)) break;
      result.clientName = c.text.trim();
      result.filled.push("client");
      break;
    }
  }

  for (const row of rows) {
    for (const cell of row.cells) {
      const n = norm(cell.text);

      if (!result.devisNumber) {
        const m = cell.text.match(/^devis\s*n[°o]?\s*:?\s*([A-Z0-9][A-Z0-9\/-]*)/i);
        if (m) {
          result.devisNumber = m[1];
          continue;
        }
      }
      if (!result.date && /^(validite|date)\b/.test(n)) {
        const iso = toIsoDate(cell.text);
        if (iso) {
          result.date = iso;
          result.filled.push("date");
          continue;
        }
      }

      if (!inClientColumn(cell)) continue;

      if (!result.phone && /^(tel|telephone|portable|mobile)\b/.test(n)) {
        const v = labelValue(row, cell);
        if (v && PHONE_RE.test(v)) {
          result.phone = v;
          result.filled.push("téléphone");
        }
      } else if (!result.email && /^(e-?mail|courriel|mail)\b/.test(n)) {
        const v = labelValue(row, cell);
        if (v && EMAIL_RE.test(v)) {
          result.email = v;
          result.filled.push("email");
        }
      } else if (!result.vehicle && /^vehicule\b/.test(n)) {
        const v = labelValue(row, cell);
        if (v) {
          result.vehicle = v;
          result.filled.push("véhicule");
        }
      } else if (!result.plate && /^immatriculation\b/.test(n)) {
        const v = labelValue(row, cell);
        if (v) {
          result.plate = cleanPlate(v);
          result.filled.push("immatriculation");
        }
      } else if (!result.motorisation && /^motorisation\b/.test(n)) {
        const v = labelValue(row, cell);
        if (v) result.motorisation = v;
      } else if (!result.mileage && /^kilometrage\b/.test(n)) {
        const v = labelValue(row, cell);
        if (v) {
          result.mileage = v;
          if (Number(v.replace(/\D/g, "")) > 0) result.filled.push("kilométrage");
        }
      } else if (!result.clientName && clientRowIdx === -1 && /^(client|nom)\s*:/.test(n)) {
        const v = labelValue(row, cell);
        if (v) {
          result.clientName = v;
          result.filled.push("client");
        }
      }
    }
  }

  // A devis made out to a garage prints the vehicle away from the client block:
  // the labelled plate is taken wherever it stands, then a plate-shaped text.
  if (!result.plate || !result.vehicle) {
    for (const row of rows) {
      for (const cell of row.cells) {
        const n = norm(cell.text);
        if (!result.plate && /^(immatriculation|immat\b\.?|plaque)/.test(n)) {
          const v = labelValue(row, cell);
          if (v) {
            result.plate = cleanPlate(v);
            result.filled.push("immatriculation");
          }
        } else if (!result.vehicle && /^vehicule\b/.test(n)) {
          const v = labelValue(row, cell);
          if (v) {
            result.vehicle = v;
            result.filled.push("véhicule");
          }
        }
      }
    }
  }
  if (!result.plate) {
    for (const row of rows) {
      const m = row.cells.map((c) => c.text).join("  ").match(/\b[A-HJ-NP-TV-Z]{2}[- ]\d{3}[- ][A-HJ-NP-TV-Z]{2}\b/);
      if (m) {
        result.plate = cleanPlate(m[0]);
        result.filled.push("immatriculation");
        break;
      }
    }
  }

  // Loose fallbacks, still restricted to the client column.
  if (!result.email || !result.phone) {
    for (const row of rows) {
      for (const cell of row.cells) {
        if (!inClientColumn(cell)) continue;
        if (!result.email) {
          const m = cell.text.match(EMAIL_RE);
          if (m) {
            result.email = m[0];
            result.filled.push("email");
          }
        }
      }
    }
  }

  const header = findTableHeader(rows);
  if (header) {
    result.lines = parseDevisTable(rows, header);
    if (result.lines.length > 0) {
      result.filled.push(`${result.lines.length} pièce(s)`);
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Main entry                                                        */
/* ------------------------------------------------------------------ */

/** Pure rows → order parsing, picking the layout automatically. */
export function parseOrderRows(rows: PdfRow[]): ParsedOrder {
  if (isDevisLayout(rows)) return parseDevisRows(rows);
  return parseOrderText(rows.map((r) => r.cells.map((c) => c.text).join(" ")));
}

export async function extractOrderFromPdf(file: File): Promise<ParsedOrder> {
  return parseOrderRows(await extractPdfRows(file));
}
