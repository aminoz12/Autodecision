"use client";

import {
  BarChart3,
  Box,
  Building2,
  Clock,
  Coins,
  FileText,
  Home,
  LogOut,
  Menu,
  PackageOpen,
  PlusCircle,
  RotateCcw,
  Settings,
  ShoppingCart,
  Truck,
  Warehouse,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Tableau de bord", icon: Home },
  { href: "/dashboard/nouvelle-commande", label: "Nouvelle Commande", icon: PlusCircle },
  { href: "/dashboard/commandes", label: "Suivis Des Commandes", icon: ShoppingCart },
  { href: "/dashboard/garages", label: "Garages", icon: Building2 },
  { href: "/dashboard/stock", label: "Stock", icon: Box },
  { href: "/dashboard/reception", label: "Pointage Pièces", icon: PackageOpen },
  { href: "/dashboard/reliquats", label: "Reliquats", icon: Clock },
  { href: "/dashboard/retours", label: "Retours", icon: RotateCcw },
  { href: "/dashboard/avoirs", label: "Avoirs", icon: FileText },
  { href: "/dashboard/consignes", label: "Consignes", icon: Coins },
  { href: "/dashboard/livreurs", label: "Livreurs", icon: Truck },
  { href: "/dashboard/rapports", label: "Rapports", icon: BarChart3 },
  { href: "/dashboard/fournisseurs", label: "Fournisseurs", icon: Warehouse },
  { href: "/dashboard/parametres", label: "Paramètres", icon: Settings },
];

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

  return (
    <>
      {/* Mobile hamburger */}
      <div className="sidebar-mobile-header">
        <div className="sidebar-brand-mini">
          <span className="sidebar-brand-icon">⚡</span>
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
      <aside
        className={cn(
          "sidebar",
          mobileOpen ? "sidebar--open" : ""
        )}
      >
        {/* Brand */}
        <div className="sidebar-brand">
          <div className="sidebar-brand-content">
            <div className="sidebar-brand-icon-new">
              <Home className="h-5 w-5 text-white" />
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
          {navItems.map((item) => {
            const isActive =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "sidebar-nav-item",
                  isActive && "sidebar-nav-item--active"
                )}
              >
                <Icon className="sidebar-nav-icon" />
                <span className="flex-1">{item.label}</span>
              </Link>
            );
          })}
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
