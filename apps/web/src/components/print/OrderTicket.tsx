"use client";

import type { OrganizationSettings } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Ticket 80 mm — bon de commande / bon de livraison, thermal receipt.
    Printed right after an order is created (instead of a full facture),
    and again from the order page. 72 mm printable, Lucida Console 8 pt,
    black only: no grey, no background fill (a thermal printer, or the
    browser's « graphiques d'arrière-plan » left unticked, would lose it).
    Printed as ONE long page by lib/print-ticket.ts. */
/* ------------------------------------------------------------------ */

export type TicketLine = {
  reference: string;
  designation: string;
  quantity: number;
  prixVente: number;
  retourPossible: boolean;
  /** The client walked out with this part (stock line handed over). */
  taken: boolean;
};

export type TicketData = {
  ref: string;
  createdAt: string;
  vendeur: string | null;
  tourName: string | null;
  deliveryAt: string | null;
  clientName: string;
  clientPhone: string | null;
  plate: string | null;
  vehicleModel: string | null;
  kilometrage: number | null;
  lines: TicketLine[];
  total: number;
  avoirApplique: number;
  paye: number;
  reste: number;
  statutPaiement: string;
  /** ESPECES / CARTE / VIREMENT / CHEQUE / EN_COMPTE. */
  modePaiement?: string | null;
  /** Due date of an on-account order (yyyy-mm-dd). */
  echeance?: string | null;
  /* ---- Après-vente : ce qui est annoncé au client, noir sur blanc ---- */
  /** Date promise pour les pièces à venir (yyyy-mm-dd). */
  promisedDate?: string | null;
  /** Politique de reprise du magasin (Paramètres → Après-vente). */
  returnPolicy?: string | null;
  /** Date limite pour rapporter l'ancienne pièce consignée (yyyy-mm-dd). */
  consigneDeadline?: string | null;
  /** Bon de livraison: who delivers. */
  livreur?: string | null;
};

function eur(v: number): string {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

const REGLEMENT_LABEL: Record<string, string> = {
  "PAYÉ": "PAYÉ COMPTANT",
  PARTIEL: "ACOMPTE VERSÉ",
  "NON_PAYÉ": "NON PAYÉ",
};

const MODE_LABEL: Record<string, string> = {
  ESPECES: "ESPÈCES",
  CARTE: "CARTE BANCAIRE",
  VIREMENT: "VIREMENT",
  CHEQUE: "CHÈQUE",
  EN_COMPTE: "EN COMPTE",
};

function reglementText(data: TicketData): string {
  const statut = REGLEMENT_LABEL[data.statutPaiement] ?? data.statutPaiement;
  if (data.modePaiement === "EN_COMPTE") {
    const due = data.echeance ? new Date(data.echeance) : null;
    const dueText =
      due && !Number.isNaN(due.getTime())
        ? ` · ÉCHÉANCE ${due.toLocaleDateString("fr-FR")}`
        : "";
    return `EN COMPTE${dueText}`;
  }
  const mode = data.modePaiement ? MODE_LABEL[data.modePaiement] : null;
  return mode ? `${mode} · ${statut}` : statut;
}

/* ---- Code 39 barcode (native SVG, no library) ---- */
/* 9 elements per char (bar/space alternating), n = narrow, w = wide.  */
const CODE39: Record<string, string> = {
  "0": "nnnwwnwnn", "1": "wnnwnnnnw", "2": "nnwwnnnnw", "3": "wnwwnnnnn",
  "4": "nnnwwnnnw", "5": "wnnwwnnnn", "6": "nnwwwnnnn", "7": "nnnwnnwnw",
  "8": "wnnwnnwnn", "9": "nnwwnnwnn",
  A: "wnnnnwnnw", B: "nnwnnwnnw", C: "wnwnnwnnn", D: "nnnnwwnnw",
  E: "wnnnwwnnn", F: "nnwnwwnnn", G: "nnnnnwwnw", H: "wnnnnwwnn",
  I: "nnwnnwwnn", J: "nnnnwwwnn", K: "wnnnnnnww", L: "nnwnnnnww",
  M: "wnwnnnnwn", N: "nnnnwnnww", O: "wnnnwnnwn", P: "nnwnwnnwn",
  Q: "nnnnnnwww", R: "wnnnnnwwn", S: "nnwnnnwwn", T: "nnnnwnwwn",
  U: "wwnnnnnnw", V: "nwwnnnnnw", W: "wwwnnnnnn", X: "nwnnwnnnw",
  Y: "wwnnwnnnn", Z: "nwwnwnnnn", "-": "nwnnnnwnw", ".": "wwnnnnwnn",
  " ": "nwwnnnwnn", "*": "nwnnwnwnn",
};

function Barcode({ value }: { value: string }) {
  const NARROW = 1.6;
  const WIDE = 4;
  const HEIGHT = 46;
  const text = `*${value.toUpperCase().replace(/[^0-9A-Z\-. ]/g, "-")}*`;
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of text) {
    const pattern = CODE39[ch] ?? CODE39["-"];
    for (let i = 0; i < pattern.length; i++) {
      const w = pattern[i] === "w" ? WIDE : NARROW;
      if (i % 2 === 0) bars.push({ x, w });
      x += w;
    }
    x += NARROW; // inter-character gap
  }
  return (
    <svg
      className="tk-barcode"
      viewBox={`0 0 ${x} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={value}
    >
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={HEIGHT} fill="#000" />
      ))}
    </svg>
  );
}

export function OrderTicket({
  org,
  data,
  kind = "commande",
}: {
  org: Pick<OrganizationSettings, "name" | "phone" | "address" | "city" | "tvaRate"> | null;
  data: TicketData;
  /** « commande »: the counter's ticket, with prices. « livraison »: quantities and signature. */
  kind?: "commande" | "livraison";
}) {
  const created = new Date(data.createdAt);
  const dateStr = created.toLocaleDateString("fr-FR");
  const timeStr = created.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const magasin = [org?.name, org?.city].filter(Boolean).join(" — ") || "Magasin";
  const tvaRate = org?.tvaRate ?? 20;
  const totalHT = data.total / (1 + tvaRate / 100);
  const tva = data.total - totalHT;
  const delivery = kind === "livraison";
  const sections = delivery
    ? [{ title: "Pièces livrées", rows: data.lines }]
    : [
        { title: "Pièces remises au client", rows: data.lines.filter((l) => l.taken) },
        { title: "Pièces à livrer", rows: data.lines.filter((l) => !l.taken) },
      ];

  return (
    <div className="tk-doc">
      <header className="tk-header">
        <p className="tk-shop">{org?.name ?? "Magasin"}</p>
        <p className="tk-shop-sub">Pièces auto &amp; accessoires</p>
        {org?.address && <p>{org.address}</p>}
        {(org?.city || org?.phone) && <p>{[org?.city, org?.phone ? `Tél. ${org.phone}` : null].filter(Boolean).join(" · ")}</p>}
      </header>

      <div className="tk-dash" />

      <p className="tk-doctitle">{delivery ? "Bon de livraison" : "Bon de commande"}</p>
      <p className="tk-refband">N° {data.ref}</p>

      <dl className="tk-kv">
        <div><dt>Date</dt><dd>{dateStr} {timeStr}</dd></div>
        {data.vendeur && <div><dt>Vendeur</dt><dd>{data.vendeur}</dd></div>}
        {data.tourName && (
          <div>
            <dt>Tournée</dt>
            <dd>
              {data.tourName}
              {data.deliveryAt
                ? ` – ${new Date(data.deliveryAt).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
                : ""}
            </dd>
          </div>
        )}
        {delivery && data.livreur && <div><dt>Livreur</dt><dd>{data.livreur}</dd></div>}
      </dl>

      <div className="tk-dash" />

      <dl className="tk-kv">
        <div><dt>Client</dt><dd>{data.clientName}</dd></div>
        {data.clientPhone && data.clientPhone !== "-" && <div><dt>Tél.</dt><dd>{data.clientPhone}</dd></div>}
        {data.plate && <div><dt>Plaque</dt><dd>{data.plate}</dd></div>}
        {data.vehicleModel && <div><dt>Véhicule</dt><dd>{data.vehicleModel}</dd></div>}
        {data.kilometrage != null && <div><dt>Km</dt><dd>{data.kilometrage.toLocaleString("fr-FR")} km</dd></div>}
      </dl>

      <div className="tk-dash" />

      {sections
        .filter((s) => s.rows.length > 0)
        .map((s) => (
          <section key={s.title} className="tk-parts">
            <p className="tk-parts-title">
              <span>{s.title}</span>
              <span>{s.rows.reduce((n, l) => n + l.quantity, 0)} pce</span>
            </p>
            {s.rows.map((l, i) => {
              // « Rajout rapide » stores one text as reference and designation: print it once.
              const des = l.designation.trim();
              const same = !des || des.toLowerCase() === l.reference.trim().toLowerCase();
              return (
                <div key={i} className="tk-item">
                  <p className="tk-item-name">
                    <strong>{l.reference}</strong>
                    {same ? "" : ` ${des}`}
                  </p>
                  {delivery ? (
                    <p className="tk-item-row">
                      <span>Quantité</span>
                      <strong>{l.quantity}</strong>
                    </p>
                  ) : (
                    <p className="tk-item-row">
                      <span>{l.quantity} x {eur(l.prixVente)}</span>
                      <strong>{eur(l.quantity * l.prixVente)}</strong>
                    </p>
                  )}
                  {!l.retourPossible && <p className="tk-item-flag">Retour impossible</p>}
                </div>
              );
            })}
          </section>
        ))}

      <div className="tk-dash" />

      {delivery ? (
        <>
          <p className="tk-reglement">Total : {data.lines.reduce((n, l) => n + l.quantity, 0)} pièce(s)</p>
          <div className="tk-sign">
            <p>Livré par : {data.livreur ?? "____________________"}</p>
            <p>Reçu par (nom) : ______________</p>
            <p>Signature :</p>
            <div className="tk-sign-box" />
          </div>
          <div className="tk-dash" />
          <p className="tk-note">Marchandise vérifiée et reçue conforme.</p>
        </>
      ) : (
        <>
          <div className="tk-totals">
            <div><span>Total HT</span><span>{eur(totalHT)}</span></div>
            <div><span>TVA {tvaRate.toLocaleString("fr-FR")} %</span><span>{eur(tva)}</span></div>
            <div className="tk-totals-ttc"><span>Total TTC</span><span>{eur(data.total)}</span></div>
            {data.avoirApplique > 0 && <div><span>Avoir déduit</span><span>− {eur(data.avoirApplique)}</span></div>}
            <div><span>Payé</span><span>{eur(data.paye)}</span></div>
            {data.reste > 0 && <div className="tk-totals-due"><span>Reste à payer</span><span>{eur(data.reste)}</span></div>}
          </div>

          <p className="tk-reglement">Règlement : {reglementText(data)}</p>

          <div className="tk-dash" />

          {(data.promisedDate || data.consigneDeadline) && (
            <p className="tk-note tk-note--strong">
              {data.promisedDate && <>Pièces à venir promises pour le {new Date(data.promisedDate).toLocaleDateString("fr-FR")}</>}
              {data.promisedDate && data.consigneDeadline && <br />}
              {data.consigneDeadline && <>Ancienne pièce (consigne) à rapporter avant le {new Date(data.consigneDeadline).toLocaleDateString("fr-FR")}</>}
            </p>
          )}

          <p className="tk-note">
            Merci de vérifier la marchandise à la réception. En cas d&apos;anomalie, nous contacter sous 24h.
            {data.returnPolicy && (
              <>
                <br />
                {data.returnPolicy}
              </>
            )}
          </p>
        </>
      )}

      <Barcode value={data.ref} />
      <p className="tk-barcode-label">{data.ref}</p>

      <p className="tk-footer">
        Merci pour votre confiance !
        <br />
        {magasin}
      </p>
    </div>
  );
}
