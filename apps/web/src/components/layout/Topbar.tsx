"use client";

import { ChevronDown, CirclePlus, KeyRound, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { ChangePasswordDialog } from "@/components/auth/ChangePasswordDialog";
import { Toast } from "@/components/ui/Toast";
import { GlobalSearch } from "@/components/ui/GlobalSearch";
import { NotificationBell } from "@/components/NotificationBell";
import { MagasinSwitcher } from "@/components/MagasinSwitcher";
import { loginFor } from "@/lib/spaces";

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

/**
 * Sticky bar above every dashboard page: the global search (press « / »),
 * the one primary action of the counter, the magasin switcher, the
 * notification bell and the account menu (password, logout).
 */
export function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, profile, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwdOpen, setPwdOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const userName = profile?.display_name ?? "Utilisateur";
  const userRole = profile?.role ? ROLE_LABEL[profile.role] ?? profile.role : "";
  const onNewOrder = pathname.startsWith("/dashboard/nouvelle-commande");

  async function onLogout() {
    const door = loginFor(profile, user?.email);
    await logout();
    router.replace(door);
  }

  return (
    <header className="topbar">
      <div className="topbar-search">
        <GlobalSearch />
      </div>
      <div className="topbar-actions">
        {!onNewOrder && (
          <Link href="/dashboard/nouvelle-commande" className="od-btn od-btn--primary topbar-new">
            <CirclePlus />
            <span>Nouvelle commande</span>
          </Link>
        )}
        <MagasinSwitcher />
        <NotificationBell />
        <span className="topbar-divider" aria-hidden="true" />
        <div className="topbar-user" ref={wrap}>
          <button
            type="button"
            className="topbar-user-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span className="topbar-avatar">{initials(userName)}</span>
            <span className="topbar-user-text">
              <span className="topbar-user-name">{userName}</span>
              <span className="topbar-user-role">{userRole}</span>
            </span>
            <ChevronDown className="topbar-user-chev" />
          </button>
          {menuOpen && (
            <div className="topbar-menu" role="menu">
              <div className="topbar-menu-head">
                <strong>{userName}</strong>
                <span>{user?.email}</span>
              </div>
              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  setPwdOpen(true);
                }}
              >
                <KeyRound />
                Changer mon mot de passe
              </button>
              <button
                type="button"
                role="menuitem"
                className="topbar-menu-item topbar-menu-item--danger"
                onClick={() => void onLogout()}
              >
                <LogOut />
                Se déconnecter
              </button>
            </div>
          )}
        </div>
      </div>
      <ChangePasswordDialog open={pwdOpen} onClose={() => setPwdOpen(false)} onDone={setNotice} />
      <Toast message={notice} onClose={() => setNotice(null)} />
    </header>
  );
}
