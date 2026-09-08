import { Check } from "lucide-react";
import Link from "next/link";
import { SubscribeButton } from "@/components/billing/SubscribeButton";

/**
 * Public pricing page. Prices are display values from env (the real amount
 * lives on the Stripe price); the checkout is env-gated (see lib/stripe.ts).
 */
export const metadata = { title: "Tarifs — Autodecision" };

const FEATURES = [
  "Commandes comptoir, garages et livraisons en tournées",
  "Stock, réceptions, retours, avoirs et consignes",
  "Caisse, encaissements et factures conformes",
  "Espace garagiste (commandes, factures, relevé de compte)",
  "Application livreur avec preuve de livraison",
  "Rapports, exports CSV et notifications",
  "Utilisateurs illimités du magasin",
];

function priceText(env: string | undefined, fallback: string): string {
  const v = (env ?? "").trim();
  return v || fallback;
}

export default function TarifsPage() {
  const monthly = priceText(process.env.NEXT_PUBLIC_PRICE_MONTHLY_EUR, "49");
  const yearly = priceText(process.env.NEXT_PUBLIC_PRICE_YEARLY_EUR, "490");
  const hasYearly = Boolean((process.env.STRIPE_PRICE_YEARLY ?? "").trim());

  return (
    <main className="pr-page">
      <header className="pr-header">
        <Link href="/" className="pr-brand">Autodecision</Link>
        <nav className="pr-nav">
          <Link href="/caissier/login" className="od-btn od-btn--ghost">Se connecter</Link>
          <Link href="/signup" className="od-btn od-btn--primary">Essai gratuit</Link>
        </nav>
      </header>

      <section className="pr-hero">
        <h1 className="pr-title">Un tarif simple, tout compris</h1>
        <p className="pr-sub">
          Essayez gratuitement pendant la période d&apos;essai, puis choisissez la formule qui convient à votre magasin.
          Sans engagement : résiliable à tout moment depuis vos paramètres.
        </p>
      </section>

      <section className={`pr-plans${hasYearly ? " pr-plans--two" : ""}`}>
        <article className="od-card pr-plan">
          <p className="pr-plan-name">Mensuel</p>
          <p className="pr-plan-price">
            {monthly} € <span>HT / mois</span>
          </p>
          <ul className="pr-features">
            {FEATURES.map((f) => (
              <li key={f}>
                <Check className="h-4 w-4" /> {f}
              </li>
            ))}
          </ul>
          <SubscribeButton interval="monthly" label="S'abonner (mensuel)" />
        </article>
        {hasYearly && (
          <article className="od-card pr-plan pr-plan--featured">
            <p className="pr-plan-name">Annuel</p>
            <p className="pr-plan-price">
              {yearly} € <span>HT / an</span>
            </p>
            <p className="pr-plan-hint">Deux mois offerts par rapport au mensuel.</p>
            <ul className="pr-features">
              {FEATURES.map((f) => (
                <li key={f}>
                  <Check className="h-4 w-4" /> {f}
                </li>
              ))}
            </ul>
            <SubscribeButton interval="yearly" label="S'abonner (annuel)" />
          </article>
        )}
      </section>

      <p className="pr-footnote">
        Le paiement est sécurisé par Stripe. Une facture est émise à chaque échéance et reste disponible depuis
        « Gérer mon abonnement » dans les paramètres du magasin.
      </p>
    </main>
  );
}
