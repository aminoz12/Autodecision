"use client";

import {
  AlertTriangle,
  Building2,
  CreditCard,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  MapPin,
  MessageSquare,
  PackageCheck,
  Phone,
  RotateCcw,
  ShieldCheck,
  ShoppingCart,
  Truck,
  UserCog,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { homeSpace } from "@/lib/spaces";

/* ------------------------------------------------------------------ */
/*  One login page per space — same shell, its own colors, icon and    */
/*  role-specific pitch. After sign-in the account is routed to ITS    */
/*  space, even if it used the wrong door.                             */
/* ------------------------------------------------------------------ */

export type SpaceKey = "superadmin" | "admin" | "caissier" | "livreur";

type Feature = { icon: LucideIcon; label: string };

const SPACES: Record<
  SpaceKey,
  {
    theme: string;
    icon: LucideIcon;
    name: string;
    headline: string;
    sub: string;
    title: string;
    subtitle: string;
    features: Feature[];
  }
> = {
  superadmin: {
    theme: "auth--superadmin",
    icon: KeyRound,
    name: "Console SaaS",
    headline: "Pilotez tous vos magasins depuis un seul endroit.",
    sub: "Espace réservé au propriétaire de la plateforme Autodecision.",
    title: "Console SaaS",
    subtitle: "Connectez-vous avec le compte propriétaire de la plateforme.",
    features: [
      { icon: Building2, label: "Tous les magasins et leurs volumes" },
      { icon: CreditCard, label: "Abonnements, essais et suspensions" },
      { icon: UserCog, label: "Mots de passe des administrateurs" },
      { icon: ShieldCheck, label: "Création de nouveaux magasins" },
    ],
  },
  admin: {
    theme: "auth--admin",
    icon: ShieldCheck,
    name: "Espace Administrateur",
    headline: "Les clés de votre magasin, entre de bonnes mains.",
    sub: "Comptes, accès et réglages — réservé à l'administrateur du magasin.",
    title: "Espace Administrateur",
    subtitle: "Connectez-vous avec votre compte administrateur du magasin.",
    features: [
      { icon: Users, label: "Équipe : caissiers & administrateurs" },
      { icon: Wrench, label: "Accès garagistes et livreurs" },
      { icon: PackageCheck, label: "Fournisseurs et paramètres" },
      { icon: ShieldCheck, label: "Supervision du comptoir" },
    ],
  },
  caissier: {
    theme: "auth--caissier",
    icon: ShoppingCart,
    name: "Espace Caissier",
    headline: "Le comptoir, du devis à l'encaissement.",
    sub: "Votre poste de travail au quotidien : commandes, clients et pièces.",
    title: "Espace Caissier",
    subtitle: "Connectez-vous avec le compte caissier fourni par votre administrateur.",
    features: [
      { icon: ShoppingCart, label: "Nouvelles commandes et tickets" },
      { icon: PackageCheck, label: "Réceptions et suivi des pièces" },
      { icon: MessageSquare, label: "SMS « pièces disponibles »" },
      { icon: RotateCcw, label: "Retours, avoirs et consignes" },
    ],
  },
  livreur: {
    theme: "auth--livreur",
    icon: Truck,
    name: "Espace Livreur",
    headline: "Votre tournée du jour, dans votre poche.",
    sub: "Pensé pour le téléphone : vos livraisons, rien d'autre.",
    title: "Espace Livreur",
    subtitle: "Connectez-vous avec le compte livreur fourni par votre magasin.",
    features: [
      { icon: MapPin, label: "Ma tournée et mes adresses" },
      { icon: Phone, label: "Appeler le client en un geste" },
      { icon: PackageCheck, label: "Marquer une commande livrée" },
    ],
  },
};

export function SpaceLogin({ space }: { space: SpaceKey }) {
  const cfg = SPACES[space];
  const { login, logout, ready, user, profile } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!ready || !user) return;
    // A garagiste session would pollute the magasin cookie — sign it out.
    if (profile?.client_id) {
      void logout();
      setError(
        "Ce compte est un compte garagiste. Connectez-vous sur la page Garagiste (/garagiste).",
      );
      return;
    }
    const home = homeSpace(profile, user.email);
    if (home !== "/login") router.replace(home);
  }, [ready, user, profile, router, logout]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoading(true);
      setError(null);
      try {
        await login(email, password);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Connexion impossible");
      } finally {
        setLoading(false);
      }
    },
    [email, password, login],
  );

  const Icon = cfg.icon;

  if (!ready) {
    return (
      <div className="auth-loading">
        <Loader2 className="h-5 w-5 auth-spin" />
      </div>
    );
  }

  return (
    <div className={`auth-page ${cfg.theme}`}>
      {/* Brand panel */}
      <aside className="auth-brand">
        <div className="auth-brand-logo">
          <span className="auth-brand-logo-mark">
            <Icon className="h-5 w-5" />
          </span>
          Autodecision
          <span className="auth-space-tag">{cfg.name}</span>
        </div>

        <div>
          <h1 className="auth-brand-headline">{cfg.headline}</h1>
          <p className="auth-brand-sub">{cfg.sub}</p>
          <div className="auth-brand-features">
            {cfg.features.map((f) => {
              const FIcon = f.icon;
              return (
                <span key={f.label} className="auth-feature">
                  <span className="auth-feature-dot">
                    <FIcon className="h-3.5 w-3.5" />
                  </span>
                  {f.label}
                </span>
              );
            })}
          </div>
        </div>

        <p className="auth-brand-foot">© 2026 Autodecision · Pièces auto</p>
        <span className="auth-brand-orb auth-brand-orb--1" />
        <span className="auth-brand-orb auth-brand-orb--2" />
      </aside>

      {/* Form panel */}
      <main className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-logo">
            <span className="auth-card-logo-mark">
              <Icon className="h-5 w-5" />
            </span>
            {cfg.name}
          </div>

          <h2 className="auth-title">{cfg.title}</h2>
          <p className="auth-subtitle">{cfg.subtitle}</p>

          <form onSubmit={onSubmit} className="auth-form">
            {error && (
              <div className="auth-error">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="auth-field">
              <label htmlFor="email" className="auth-label">
                Email
              </label>
              <div className="auth-input-wrap">
                <Mail />
                <input
                  id="email"
                  className="auth-input"
                  type="email"
                  autoComplete="username"
                  placeholder="vous@magasin.fr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor="password" className="auth-label">
                Mot de passe
              </label>
              <div className="auth-input-wrap">
                <Lock />
                <input
                  id="password"
                  className="auth-input"
                  type={showPwd ? "text" : "password"}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="auth-eye"
                  onClick={() => setShowPwd((v) => !v)}
                  aria-label={showPwd ? "Masquer" : "Afficher"}
                >
                  {showPwd ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <button type="submit" className="auth-btn" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 auth-spin" />}
              {loading ? "Connexion…" : "Se connecter"}
            </button>
          </form>

          <p className="auth-foot">
            Pas votre espace ? <Link href="/login">Connexion générale</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
