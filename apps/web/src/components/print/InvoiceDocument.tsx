import { LATE_PAYMENT_MENTION, type Invoice } from "@/lib/data/invoices";

function eur(v: number): string {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
function frDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("fr-FR");
}
function pct(rate: number): string {
  return `${rate.toLocaleString("fr-FR", { maximumFractionDigits: 2 })} %`;
}

/**
 * Renders an emitted invoice / credit note from its immutable snapshot.
 * Same markup on screen (preview) and on paper (the parent wraps it in
 * `.inv-print` and calls window.print()).
 */
export function InvoiceDocument({ invoice, duplicate = false }: { invoice: Invoice; duplicate?: boolean }) {
  const s = invoice.seller;
  const b = invoice.buyer;
  const isAvoir = invoice.kind === "AVOIR";
  const legalLine = [
    s.legalName ?? s.name,
    s.legalForm,
    s.capital ? `au capital de ${s.capital}` : null,
    s.siret ? `SIRET ${s.siret}` : null,
    s.rcs ? `RCS ${s.rcs}` : null,
    s.tvaIntra ? `TVA intracommunautaire ${s.tvaIntra}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="inv-doc">
      <header className="inv-head">
        <div className="inv-seller">
          {s.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.logoUrl} alt="" className="inv-logo" />
          ) : null}
          <p className="inv-seller-name">{s.name}</p>
          {s.legalName && s.legalName !== s.name && <p className="inv-line">{s.legalName}</p>}
          {s.address && <p className="inv-line">{s.address}</p>}
          {s.city && <p className="inv-line">{s.city}</p>}
          {s.phone && <p className="inv-line">Tél. {s.phone}</p>}
          {s.siret && <p className="inv-line">SIRET {s.siret}</p>}
          {s.tvaIntra && <p className="inv-line">TVA {s.tvaIntra}</p>}
        </div>
        <div className="inv-title">
          <p className="inv-kind">{isAvoir ? "AVOIR" : "FACTURE"}</p>
          <p className="inv-number">{invoice.number}</p>
          <p className="inv-line">Émise le {frDate(invoice.issuedAt)}</p>
          {invoice.orderRef && <p className="inv-line">Commande {invoice.orderRef}</p>}
          {invoice.relatedInvoiceNumber && <p className="inv-line">Annule et remplace partiellement la facture {invoice.relatedInvoiceNumber}</p>}
          {duplicate && <p className="inv-dup">DUPLICATA</p>}
        </div>
      </header>

      <section className="inv-buyer">
        <p className="inv-section-title">{b.isGarage ? "Client professionnel" : "Client"}</p>
        <p className="inv-buyer-name">{b.name}</p>
        {b.address && <p className="inv-line">{b.address}</p>}
        {b.city && <p className="inv-line">{b.city}</p>}
        {(b.phone || b.email) && <p className="inv-line">{[b.phone, b.email].filter(Boolean).join(" · ")}</p>}
        {b.siret && <p className="inv-line">SIRET {b.siret}</p>}
        {b.tvaIntra && <p className="inv-line">TVA {b.tvaIntra}</p>}
        {(b.vehicleModel || b.immatriculation) && (
          <p className="inv-line">Véhicule : {[b.vehicleModel, b.immatriculation].filter(Boolean).join(" · ")}</p>
        )}
      </section>

      <table className="inv-table">
        <thead>
          <tr>
            <th>Référence</th>
            <th>Désignation</th>
            <th className="inv-num">Qté</th>
            <th className="inv-num">PU HT</th>
            <th className="inv-num">TVA</th>
            <th className="inv-num">Total HT</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.reference}</td>
              <td>
                {l.designation}
                {l.remisePct > 0 && (
                  <span className="inv-muted"> — remise {pct(l.remisePct)} sur {eur(l.unitBrutTtc)} TTC</span>
                )}
              </td>
              <td className="inv-num">{l.quantity}</td>
              <td className="inv-num">{eur(l.unitHt)}</td>
              <td className="inv-num">{pct(l.tvaRate)}</td>
              <td className="inv-num">{eur(l.totalHt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="inv-totals-wrap">
        <table className="inv-vat">
          <thead>
            <tr><th>Taux</th><th className="inv-num">Base HT</th><th className="inv-num">TVA</th></tr>
          </thead>
          <tbody>
            {invoice.totals.byRate.map((r) => (
              <tr key={r.rate}>
                <td>{pct(r.rate)}</td>
                <td className="inv-num">{eur(r.ht)}</td>
                <td className="inv-num">{eur(r.tva)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="inv-totals">
          <div><span>Total HT</span><strong>{eur(invoice.totals.ht)}</strong></div>
          <div><span>Total TVA</span><strong>{eur(invoice.totals.tva)}</strong></div>
          <div className="inv-total-ttc"><span>{isAvoir ? "Montant de l'avoir TTC" : "Total TTC"}</span><strong>{eur(invoice.totals.ttc)}</strong></div>
          {!isAvoir && invoice.totals.avoirApplique > 0 && <div><span>Avoir déduit</span><strong>− {eur(invoice.totals.avoirApplique)}</strong></div>}
          {!isAvoir && <div><span>Déjà réglé</span><strong>{eur(invoice.totals.paid)}</strong></div>}
          {!isAvoir && <div className="inv-total-due"><span>Reste à payer</span><strong>{eur(invoice.totals.due)}</strong></div>}
        </div>
      </div>

      {!isAvoir && (
        <section className="inv-terms">
          <p className="inv-section-title">Conditions de règlement</p>
          <p className="inv-line">
            {invoice.paymentTerms ?? "Paiement comptant à réception."}
            {invoice.dueDate ? ` Échéance : ${frDate(invoice.dueDate)}.` : ""}
            {invoice.modePaiement === "EN_COMPTE" ? " Règlement sur compte client." : ""}
          </p>
          {(s.iban || s.bic) && (
            <p className="inv-line">Virement : {[s.iban ? `IBAN ${s.iban}` : null, s.bic ? `BIC ${s.bic}` : null].filter(Boolean).join(" · ")}</p>
          )}
          {b.isGarage && <p className="inv-legal">{LATE_PAYMENT_MENTION}</p>}
        </section>
      )}
      {isAvoir && invoice.note && (
        <section className="inv-terms">
          <p className="inv-section-title">Motif</p>
          <p className="inv-line">{invoice.note}</p>
        </section>
      )}

      <footer className="inv-foot">
        {legalLine && <p>{legalLine}</p>}
        {s.invoiceFooter && <p>{s.invoiceFooter}</p>}
        <p className="inv-hash">Empreinte {invoice.contentHash.slice(0, 16)}</p>
      </footer>
    </div>
  );
}
