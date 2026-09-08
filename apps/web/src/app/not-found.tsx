import Link from "next/link";

export default function NotFound() {
  return (
    <div className="err-page">
      <div className="err-card">
        <h1 className="err-title">Page introuvable</h1>
        <p className="err-text">Cette adresse ne correspond à aucune page de l&apos;application.</p>
        <div className="err-actions">
          <Link href="/" className="od-btn od-btn--primary">Retour à l&apos;accueil</Link>
        </div>
      </div>
    </div>
  );
}
