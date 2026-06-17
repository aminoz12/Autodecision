"use client";

import { CreditCard, Plus, RotateCcw, ShoppingCart } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/providers/AuthProvider";

const ACTIONS = [
  { href: "/garagiste/dashboard/commander", title: "Commander", desc: "Passer une nouvelle commande de pièces.", icon: Plus, color: "#5b4ee5", bg: "#EEF2FF" },
  { href: "/garagiste/dashboard/commandes", title: "Mes commandes", desc: "Suivre l'état de vos commandes.", icon: ShoppingCart, color: "#2563EB", bg: "#DBEAFE" },
  { href: "/garagiste/dashboard/retours", title: "Retours", desc: "Demander le retour d'une pièce.", icon: RotateCcw, color: "#D97706", bg: "#FEF3C7" },
  { href: "/garagiste/dashboard/factures", title: "Factures", desc: "Consulter votre encours et vos paiements.", icon: CreditCard, color: "#16A34A", bg: "#DCFCE7" },
];

export default function GarageHomePage() {
  const { profile } = useAuth();

  return (
    <div className="gp-page">
      <header className="gp-header">
        <h1 className="gp-title">Bonjour {profile?.display_name ?? ""} 👋</h1>
        <p className="gp-subtitle">
          Bienvenue dans votre espace garagiste — commandez vos pièces et suivez
          vos retours en ligne.
        </p>
      </header>

      <div className="gp-actions">
        {ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <Link key={a.href} href={a.href} className="gp-action">
              <span className="gp-action-icon" style={{ background: a.bg, color: a.color }}>
                <Icon className="h-6 w-6" />
              </span>
              <span className="gp-action-text">
                <span className="gp-action-title">{a.title}</span>
                <span className="gp-action-desc">{a.desc}</span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
