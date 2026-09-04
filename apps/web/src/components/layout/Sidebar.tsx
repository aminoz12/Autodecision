"use client";

import {
  Boxes,
  ChartColumn,
  CircleDollarSign,
  ClipboardPlus,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageCheck,
  Receipt,
  Settings,
  ShieldCheck,
  Store,
  Truck,
  Undo2,
  Users,
  Warehouse,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
    ],
  },
  {
    label: "Pièces",
    items: [
      { href: "/dashboard/stock", label: "Stock", icon: Boxes },
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
      { href: "/dashboard/rapports", label: "Rapports", icon: ChartColumn },
      { href: "/dashboard/parametres", label: "Paramètres", icon: Settings },
    ],
  },
];

/** Visible only to the magasin ADMIN — team, accesses, suppliers. */
const adminGroup: NavGroup = {
  label: "Administration",
  items: [
    { href: "/dashboard/admin", label: "Équipe & accès", icon: ShieldCheck },
    { href: "/dashboard/fournisseurs", label: "Fournisseurs", icon: Warehouse },
  ],
};

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Administrateur",
  CAISSIER: "Caissier",
  LIVREUR: "Livreur",
};

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [orgName, setOrgName] = useState<string | null>(null);

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
  const userName = profile?.display_name ?? "Utilisateur";
  const userRole = profile?.role ? ROLE_LABEL[profile.role] ?? profile.role : "";

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

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
        {/* Brand */}
        <div className="sidebar-brand">
          <div className="sidebar-brand-content">
            <div className="sidebar-brand-icon-new">
              <Store className="h-5 w-5 text-white" />
            </div>
            <div>
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
                    >
                      <Icon className="sidebar-nav-icon" />
                      <span className="flex-1">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Signed-in user + logout */}
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">
            <span className="sidebar-user-initials">{initials(userName)}</span>
            <div className="sidebar-user-status-dot" />
          </div>
          <div className="sidebar-user-info">
            <p className="sidebar-user-name">{userName}</p>
            <p className="sidebar-user-role">{userRole}</p>
          </div>
          <button
            type="button"
            className="sidebar-logout-btn"
            onClick={() => void onLogout()}
            aria-label="Se déconnecter"
            title="Se déconnecter"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
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
