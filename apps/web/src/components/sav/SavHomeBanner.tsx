"use client";

import { ArrowRight, LifeBuoy } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { fmtMoney } from "@/lib/data/saas";
import { loadSavDashboard, type SavDashboard } from "@/lib/data/sav";

/**
 * Tableau de bord → un rappel de l'après-vente : l'argent qui dort, les
 * dossiers en retard, les pièces qui attendent. Hidden until the SAV
 * migrations are applied (any load error simply hides it).
 */
export function SavHomeBanner() {
  const [d, setD] = useState<SavDashboard | null>(null);

  useEffect(() => {
    let alive = true;
    loadSavDashboard(createClient())
      .then((v) => alive && setD(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!d) return null;
  const immobilise = d.immobilise.consignesClient.amount + d.immobilise.consignesFournisseur.amount + d.garanties.amount;
  const late = d.late.supplierNoAnswer + d.late.sla + d.late.returnsDeadline + d.late.coresDeadline;

  return (
    <Link href="/dashboard/sav" className="sav-home">
      <span className="sav-home-icon"><LifeBuoy className="h-5 w-5" /></span>
      <span className="sav-home-title">Après-vente</span>
      <span className="sav-home-item"><strong>{fmtMoney(immobilise)}</strong> immobilisés (consignes, garanties)</span>
      <span className={`sav-home-item${late > 0 ? " sav-home-item--alert" : ""}`}><strong>{late}</strong> dossier(s) en retard</span>
      <span className="sav-home-item"><strong>{d.pickup.count}</strong> commande(s) en attente de retrait · {fmtMoney(d.pickup.value)}</span>
      <span className="sav-home-item"><strong>{d.garanties.open}</strong> dossier(s) ouverts</span>
      <ArrowRight className="h-4 w-4 sav-home-arrow" />
    </Link>
  );
}
