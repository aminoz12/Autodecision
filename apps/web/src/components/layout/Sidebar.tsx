"use client";

import {
  BarChart3,
  Box,
  Building2,
  ChevronRight,
  Clock,
  FileText,
  Home,
  Menu,
  PackageOpen,
  RotateCcw,
  Settings,
  ShoppingCart,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Tableau de bord", icon: Home },
  { href: "/dashboard/commandes", label: "Ventes / Commandes", icon: ShoppingCart },
  { href: "/dashboard/garages", label: "Garages", icon: Building2 },
  { href: "/dashboard/stock", label: "Stock", icon: Box },
  { href: "/dashboard/reception", label: "Réceptions", icon: PackageOpen },
  { href: "/dashboard/reliquats", label: "Reliquats", icon: Clock },
  { href: "/dashboard/retours", label: "Retours", icon: RotateCcw },
  { href: "/dashboard/avoirs", label: "Avoirs", icon: FileText },
  { href: "/dashboard/rapports", label: "Rapports", icon: BarChart3 },
  { href: "/dashboard/parametres", label: "Paramètres", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile hamburger */}
      <div className="sidebar-mobile-header">
        <div className="sidebar-brand-mini">
          <span className="sidebar-brand-icon">⚡</span>
          <span>ESPACE AUTO 92</span>
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
              <h1 className="sidebar-brand-name">ESPACE AUTO 92</h1>
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

        {/* User profile at bottom */}
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">
            <img 
              src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80" 
              alt="Karim B." 
              className="w-full h-full object-cover rounded-full"
            />
            <div className="sidebar-user-status-dot" />
          </div>
          <div className="sidebar-user-info">
            <p className="sidebar-user-name">Karim B.</p>
            <p className="sidebar-user-role">Vendeur</p>
            <p className="sidebar-user-status text-[10px] text-emerald-500 font-bold">En ligne</p>
          </div>
          <ChevronRight className="sidebar-user-chevron rotate-180" />
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
