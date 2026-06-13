import { FileText } from "lucide-react";

export default function AvoirPage() {
  return (
    <div className="page-stub">
      <div className="page-stub-header">
        <h1 className="page-stub-title">Avoir</h1>
        <p className="page-stub-subtitle">
          Créer et gérer les avoirs clients.
        </p>
      </div>
      <div className="page-stub-card">
        <div className="page-stub-icon" style={{ background: "#F3E8FF" }}>
          <FileText className="h-8 w-8" style={{ color: "#8B5CF6" }} />
        </div>
        <h2>Avoir &amp; propositions</h2>
        <p>
          Créez des devis détaillés, envoyez-les aux clients et convertissez-les
          en commandes en un clic.
        </p>
      </div>
    </div>
  );
}
