"use client";

import {
  CreditCard,
  Hourglass,
  PackageCheck,
  Plus,
  RotateCcw,
  ShoppingCart,
  Truck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { garageStage, loadGarageOrders, type GarageOrder } from "@/lib/data/garage";

const ACTIONS = [
  { href: "/garagiste/dashboard/commander", title: "Commander", desc: "Passer une nouvelle commande de pièces.", icon: Plus, color: "#5b4ee5", bg: "#EEF2FF" },
  { href: "/garagiste/dashboard/commandes", title: "Mes commandes", desc: "Suivre l'état de vos commandes.", icon: ShoppingCart, color: "#2563EB", bg: "#DBEAFE" },
  { href: "/garagiste/dashboard/retours", title: "Retours", desc: "Demander le retour d'une pièce.", icon: RotateCcw, color: "#D97706", bg: "#FEF3C7" },
  { href: "/garagiste/dashboard/factures", title: "Factures", desc: "Consulter votre encours et vos paiements.", icon: CreditCard, color: "#16A34A", bg: "#DCFCE7" },
];

function eur(v: number) {
  return `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export default function GarageHomePage() {
  const { supabase, profile } = useAuth();
  const [orders, setOrders] = useState<GarageOrder[]>([]);

  const load = useCallback(async () => {
    if (!profile?.organization_id || !profile.client_id) return;
    try {
      setOrders(await loadGarageOrders(supabase, profile.organization_id, profile.client_id));
    } catch {
      /* home summary is best-effort */
    }
  }, [supabase, profile?.organization_id, profile?.client_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => {
    const confirmed = orders.filter((o) => !o.devis);
    const stages = confirmed.map(garageStage);
    return {
      total: orders.length,
      awaiting: stages.filter((s) => s === "AWAITING_RECEPTION").length,
      preparing: stages.filter((s) => s === "PREPARING").length,
      delivering: stages.filter((s) => s === "IN_DELIVERY").length,
      balance: orders.reduce((s, o) => s + o.balance, 0),
    };
  }, [orders]);

  return (
    <div className="gp-page">
      <header className="gp-header">
        <h1 className="gp-title">Bonjour {profile?.display_name ?? ""} 👋</h1>
        <p className="gp-subtitle">
          Bienvenue dans votre espace garagiste — commandez vos pièces et suivez
          vos retours en ligne.
        </p>
      </header>

      <div className="gp-stats">
        <div className="gp-stat"><span className="gp-stat-label"><ShoppingCart className="h-4 w-4" /> Commandes</span><span className="gp-stat-value">{summary.total}</span></div>
        <div className="gp-stat"><span className="gp-stat-label"><Hourglass className="h-4 w-4" /> En attente de réception</span><span className="gp-stat-value" style={{ color: "#B45309" }}>{summary.awaiting}</span></div>
        <div className="gp-stat"><span className="gp-stat-label"><PackageCheck className="h-4 w-4" /> En préparation</span><span className="gp-stat-value" style={{ color: "#1D4ED8" }}>{summary.preparing}</span></div>
        <div className="gp-stat"><span className="gp-stat-label"><Truck className="h-4 w-4" /> En cours de livraison</span><span className="gp-stat-value" style={{ color: "#6D28D9" }}>{summary.delivering}</span></div>
        <div className="gp-stat gp-stat--accent"><span className="gp-stat-label"><Wallet className="h-4 w-4" /> Encours</span><span className="gp-stat-value" style={{ color: summary.balance > 0 ? "#DC2626" : "#16A34A" }}>{eur(summary.balance)}</span></div>
      </div>

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
