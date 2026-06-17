"use client";

import {
  CreditCard,
  LayoutDashboard,
  LogOut,
  Plus,
  RotateCcw,
  ShoppingCart,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/AuthProvider";

const NAV = [
  { href: "/garage", label: "Accueil", icon: LayoutDashboard, exact: true },
  { href: "/garage/commander", label: "Commander", icon: Plus },
  { href: "/garage/commandes", label: "Mes commandes", icon: ShoppingCart },
  { href: "/garage/retours", label: "Retours", icon: RotateCcw },
  { href: "/garage/factures", label: "Factures", icon: CreditCard },
];

export function GarageNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, logout } = useAuth();

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <aside className="gp-nav">
      <div className="gp-brand">
        <span className="gp-brand-icon">
          <Wrench className="h-5 w-5" />
        </span>
        <span className="gp-brand-text">
          <span className="gp-brand-name">{profile?.display_name ?? "Mon garage"}</span>
          <span className="gp-brand-sub">Espace garagiste</span>
        </span>
      </div>

      <nav className="gp-nav-items">
        {NAV.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`gp-nav-item${active ? " gp-nav-item--active" : ""}`}
            >
              <Icon className="h-[18px] w-[18px]" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <button type="button" className="gp-logout" onClick={onLogout}>
        <LogOut className="h-[18px] w-[18px]" />
        Se déconnecter
      </button>
    </aside>
  );
}
