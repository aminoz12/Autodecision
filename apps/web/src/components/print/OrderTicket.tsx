"use client";

import type { OrganizationSettings } from "@/lib/data/saas";

/* ------------------------------------------------------------------ */
/*  Ticket de commande — thermal-receipt style (see public/Facture.jpeg)
    Printed right after an order is created, instead of a full facture. */
/* ------------------------------------------------------------------ */

export type TicketLine = {
  reference: string;
  designation: string;
  quantity: number;
  prixVente: number;
  retourPossible: boolean;
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
};

function eur(v: number): string {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

const REGLEMENT_LABEL: Record<string, string> = {
  "PAYÉ": "PAYÉ COMPTANT",
  PARTIEL: "ACOMPTE VERSÉ",
  "NON_PAYÉ": "NON PAYÉ",
};

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
        <rect key={i} x={b.x} y={0} width={b.w} height={HEIGHT} fill="#111" />
      ))}
    </svg>
  );
}

export function OrderTicket({
  org,
  data,
}: {
  org: Pick<OrganizationSettings, "name" | "phone" | "address" | "city"> | null;
  data: TicketData;
}) {
  const created = new Date(data.createdAt);
  const dateStr = created.toLocaleDateString("fr-FR");
  const timeStr = created.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const magasin = [org?.name, org?.city].filter(Boolean).join(" — ") || "Magasin";
  const totalHT = data.total / 1.2;
  const tva = data.total - totalHT;

  return (
    <div className="tk-doc">
      <header className="tk-header">
        <p className="tk-shop">{org?.name ?? "Magasin"}</p>
        <p className="tk-shop-sub">Pièces auto &amp; accessoires</p>
      </header>

      <div className="tk-dash" />

      <p className="tk-doctitle">Bon de commande</p>
      <p className="tk-refband">N° COMMANDE : {data.ref}</p>

      <div className="tk-dash" />

      <dl className="tk-kv">
        <div><dt>Date / heure</dt><dd>{dateStr} – {timeStr}</dd></div>
        {data.vendeur && <div><dt>Vendeur</dt><dd>{data.vendeur}</dd></div>}
        <div><dt>Magasin</dt><dd>{magasin}</dd></div>
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
      </dl>

      <div className="tk-dash" />

      <dl className="tk-kv">
        <div><dt>Client</dt><dd>{data.clientName}</dd></div>
        {data.clientPhone && data.clientPhone !== "-" && (
          <div><dt>Téléphone</dt><dd>{data.clientPhone}</dd></div>
        )}
      </dl>

      {(data.plate || data.vehicleModel || data.kilometrage != null) && (
        <>
          <div className="tk-dash" />
          <dl className="tk-kv">
            {data.plate && <div><dt>Plaque immat.</dt><dd>{data.plate}</dd></div>}
            {data.vehicleModel && <div><dt>Marque / modèle</dt><dd>{data.vehicleModel}</dd></div>}
            {data.kilometrage != null && (
              <div><dt>Kilométrage</dt><dd>{data.kilometrage.toLocaleString("fr-FR")} km</dd></div>
            )}
          </dl>
        </>
      )}

      <div className="tk-dash" />

      <table className="tk-table">
        <thead>
          <tr>
            <th>Référence</th>
            <th>Désignation</th>
            <th className="tk-num">Qté</th>
            <th className="tk-num">PU TTC</th>
            <th className="tk-num">Total</th>
            <th className="tk-num">Retour</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.reference}</td>
              <td>{l.designation}</td>
              <td className="tk-num">{l.quantity}</td>
              <td className="tk-num">{eur(l.prixVente)}</td>
              <td className="tk-num">{eur(l.quantity * l.prixVente)}</td>
              <td className="tk-num">{l.retourPossible ? "OUI" : "NON"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="tk-totals">
        <div><span>TOTAL HT :</span><span>{eur(totalHT)}</span></div>
        <div><span>TVA (20%) :</span><span>{eur(tva)}</span></div>
        <div className="tk-dash tk-dash--tight" />
        <div className="tk-totals-ttc"><span>TOTAL TTC :</span><span>{eur(data.total)}</span></div>
        {data.avoirApplique > 0 && <div><span>AVOIR DÉDUIT :</span><span>− {eur(data.avoirApplique)}</span></div>}
        <div><span>PAYÉ :</span><span>{eur(data.paye)}</span></div>
        {data.reste > 0 && <div className="tk-totals-ttc"><span>RESTE À PAYER :</span><span>{eur(data.reste)}</span></div>}
      </div>

      <p className="tk-reglement">MODE DE RÈGLEMENT : {REGLEMENT_LABEL[data.statutPaiement] ?? data.statutPaiement}</p>

      <div className="tk-dash" />

      <p className="tk-note">
        Merci de vérifier la marchandise à la réception.
        <br />
        En cas d&apos;anomalie, nous contacter sous 24h.
      </p>

      <Barcode value={data.ref} />
      <p className="tk-barcode-label">{data.ref}</p>

      <p className="tk-footer">
        MERCI POUR VOTRE CONFIANCE !
        <br />
        {magasin}
        {org?.phone ? (
          <>
            <br />
            {org.phone}
          </>
        ) : null}
      </p>
    </div>
  );
}
