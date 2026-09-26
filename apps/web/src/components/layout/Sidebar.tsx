"use client";

import {
  Boxes,
  CarFront,
  ChartColumn,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardPlus,
  FileText,
  LayoutDashboard,
  LifeBuoy,
  Menu,
  PackageCheck,
  Receipt,
  Route,
  Search,
  Settings,
  ShieldCheck,
  Store,
  Truck,
  type LucideIcon,
  Undo2,
  Users,
  Warehouse,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroup = { label: string; items: NavItem[] };

const navGroups: NavGroup[] = [
  {
    label: "Activité",
    items: [
      { href: "/dashboard", label: "Tableau de bord", icon: LayoutDashboard },
      { href: "/dashboard/nouvelle-commande", label: "Nouvelle commande", icon: ClipboardPlus },
      { href: "/dashboard/commandes", label: "Suivi des commandes", icon: PackageCheck },
      { href: "/dashboard/tournees", label: "Tournée fournisseurs", icon: Route },
    ],
  },
  {
    label: "Pièces",
    items: [
      { href: "/dashboard/stock", label: "Stock", icon: Boxes },
      { href: "/dashboard/recherche-piece", label: "Recherche pièce", icon: Search },
    ],
  },
  {
    // Tout ce qui arrive à une pièce après qu'elle a été vendue.
    label: "Après-vente",
    items: [
      { href: "/dashboard/sav", label: "SAV & garanties", icon: LifeBuoy },
      { href: "/dashboard/vehicules", label: "Carnet véhicule", icon: CarFront },
      { href: "/dashboard/retours", label: "Retours", icon: Undo2 },
      { href: "/dashboard/avoirs", label: "Avoirs", icon: Receipt },
      { href: "/dashboard/consignes", label: "Consignes", icon: CircleDollarSign },
    ],
  },
  {
    label: "Partenaires",
    items: [
      { href: "/dashboard/clients", label: "Clients particuliers", icon: Users },
      { href: "/dashboard/garages", label: "Garages", icon: Wrench },
      { href: "/dashboard/livreurs", label: "Livreurs", icon: Truck },
    ],
  },
  {
    label: "Pilotage",
    items: [
      { href: "/dashboard/factures", label: "Factures", icon: FileText },
      { href: "/dashboard/rapports", label: "Rapports", icon: ChartColumn },
      { href: "/dashboard/parametres", label: "Paramètres", icon: Settings },
    ],
  },
];

/** Visible only to the magasin ADMIN — team, accesses, suppliers. */
const adminGroup: NavGroup = {
  label: "Administration",
  items: [
    { href: "/admin", label: "Équipe & accès", icon: ShieldCheck },
    { href: "/dashboard/fournisseurs", label: "Fournisseurs", icon: Warehouse },
  ],
};

/*
 * The folded / open state lives on <html data-sidebar>: an inline script in
 * the root layout applies the remembered choice before the first paint, and
 * the CSS reads the attribute. React only mirrors it, through an observer.
 */
function readSidebarState(): boolean {
  return document.documentElement.getAttribute("data-sidebar") === "collapsed";
}
function subscribeSidebarState(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-sidebar"] });
  return () => observer.disconnect();
}

export function Sidebar() {
  const pathname = usePathname();
  const { profile } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);
  /** Desktop only: the menu folds to an icon rail so the page gets the room. */
  const collapsed = useSyncExternalStore(subscribeSidebarState, readSidebarState, () => false);

  function toggleCollapsed() {
    const next = !collapsed;
    document.documentElement.setAttribute("data-sidebar", next ? "collapsed" : "expanded");
    try {
      localStorage.setItem("sidebar", next ? "collapsed" : "expanded");
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }

  useEffect(() => {
    if (!profile?.organization_id) return;
    let cancelled = false;
    const sb = createClient();
    sb.from("organizations")
      .select("name")
      .eq("id", profile.organization_id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data?.name) setOrgName(String(data.name));
      });
    return () => {
      cancelled = true;
    };
  }, [profile?.organization_id]);

  const brand = orgName ?? "Mon magasin";

  function isActive(href: string): boolean {
    return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
  }

  return (
    <>
      {/* Mobile hamburger */}
      <div className="sidebar-mobile-header">
        <div className="sidebar-brand-mini">
          <span className="sidebar-brand-icon-new sidebar-brand-icon-new--sm">
            <Store className="h-4 w-4" />
          </span>
          <span>{brand}</span>
        </div>
        <button
          type="button"
          className="sidebar-mobile-toggle"
          aria-label="Menu"
          onClick={() => setMobileOpen(true)}
        >
          <Menu className="h-5 w-5" />
        </button>
      </div>

      {/* Sidebar */}
      <aside className={cn("sidebar", mobileOpen ? "sidebar--open" : "")}>
        {/* Desktop: fold the menu into an icon rail (the choice is remembered) */}
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Afficher le menu" : "Réduire le menu"}
          title={collapsed ? "Afficher le menu" : "Réduire le menu"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>

        {/* Brand */}
        <div className="sidebar-brand">
          <div className="sidebar-brand-content">
            <div className="sidebar-brand-icon-new">
              <Store className="h-5 w-5 text-white" />
            </div>
            <div className="sidebar-brand-text">
              <h1 className="sidebar-brand-name">{brand}</h1>
              <p className="sidebar-brand-sub">Comptoir</p>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={() => setMobileOpen(false)}
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="sidebar-nav">
          {(profile?.role === "ADMIN" && !profile.client_id
            ? [...navGroups, adminGroup]
            : navGroups
          ).map((group) => (
            <div key={group.label} className="sidebar-group">
              <p className="sidebar-group-label">{group.label}</p>
              <div className="sidebar-group-items">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMobileOpen(false)}
                      className={cn("sidebar-nav-item", active && "sidebar-nav-item--active")}
                      aria-current={active ? "page" : undefined}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon className="sidebar-nav-icon" />
                      <span className="sidebar-nav-label flex-1">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <button
          type="button"
          className="sidebar-overlay"
          aria-label="Fermer le menu"
          onClick={() => setMobileOpen(false)}
        />
      )}
    </>
  );
}
