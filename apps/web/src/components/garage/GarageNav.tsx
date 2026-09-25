"use client";

import {
  CreditCard,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Plus,
  RotateCcw,
  Scale,
  ShoppingCart,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { NotificationBell } from "@/components/NotificationBell";
import { ChangePasswordDialog } from "@/components/auth/ChangePasswordDialog";
import { Toast } from "@/components/ui/Toast";

const NAV = [
  { href: "/garagiste/dashboard", label: "Accueil", icon: LayoutDashboard, exact: true },
  { href: "/garagiste/dashboard/commander", label: "Commander", icon: Plus },
  { href: "/garagiste/dashboard/commandes", label: "Mes commandes", icon: ShoppingCart },
  { href: "/garagiste/dashboard/retours", label: "Retours", icon: RotateCcw },
  { href: "/garagiste/dashboard/litiges", label: "Litiges & garanties", icon: Scale },
  { href: "/garagiste/dashboard/factures", label: "Mon compte", icon: CreditCard },
];

export function GarageNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { profile, logout } = useAuth();
  const [pwdOpen, setPwdOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function onLogout() {
    await logout();
    router.replace("/garagiste");
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
        <NotificationBell compact />
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

      <div className="gp-nav-foot">
        <button type="button" className="gp-logout" onClick={() => setPwdOpen(true)}>
          <KeyRound className="h-[18px] w-[18px]" />
          Mon mot de passe
        </button>
        <button type="button" className="gp-logout" onClick={onLogout}>
          <LogOut className="h-[18px] w-[18px]" />
          Se déconnecter
        </button>
      </div>
      <ChangePasswordDialog open={pwdOpen} onClose={() => setPwdOpen(false)} onDone={setNotice} />
      <Toast message={notice} onClose={() => setNotice(null)} />
    </aside>
  );
}
