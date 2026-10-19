"use client";

import { ArrowLeft } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

/** Section of each nested page, named on the button. */
const SECTION_LABEL: Record<string, string> = {
  commandes: "Suivi des commandes",
  clients: "Clients particuliers",
  garages: "Garages",
  pros: "Clients PRO",
  factures: "Factures",
  sav: "Après-vente",
  vehicules: "Carnet véhicule",
  retours: "Retours",
  avoirs: "Avoirs",
  livreurs: "Livreurs",
  stock: "Stock",
  tournees: "Tournées",
};

/**
 * « Retour » at the top of every page nested under a section (an order, a
 * client, a garage, a facture, a dossier SAV…), 2026-10-19. Goes back in the
 * history when the visitor navigated inside the app, otherwise (link opened
 * in a new tab, notification) up to the section's list.
 */
export function BackBar() {
  const pathname = usePathname();
  const router = useRouter();
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const parent = `/${parts.slice(0, -1).join("/")}`;
  const section = SECTION_LABEL[parts[1]] ?? null;

  function back() {
    if (window.history.length > 1) router.back();
    else router.push(parent);
  }

  return (
    <div className="back-bar inv-noprint">
      <button type="button" className="back-btn" onClick={back} title={section ? `Retour · ${section}` : "Retour"}>
        <ArrowLeft className="h-4 w-4" />
        Retour
        {section && <span className="back-btn-to">· {section}</span>}
      </button>
    </div>
  );
}
