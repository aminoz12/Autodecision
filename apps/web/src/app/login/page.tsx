"use client";

import {
  AlertTriangle,
  BarChart3,
  Eye,
  EyeOff,
  Lock,
  Loader2,
  Mail,
  PackageCheck,
  ShieldCheck,
  ShoppingCart,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";

export default function LoginPage() {
  const { login, ready, user, profile } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Garagistes go to their portal; staff to the management dashboard.
  useEffect(() => {
    if (ready && user) {
      router.replace(profile?.client_id ? "/garage" : "/dashboard");
    }
  }, [ready, user, profile, router]);

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

  if (!ready) {
    return (
      <div className="auth-loading">
        <Loader2 className="h-5 w-5 auth-spin" />
      </div>
    );
  }

  return (
    <div className="auth-page">
      {/* Brand panel */}
      <aside className="auth-brand">
        <div className="auth-brand-logo">
          <span className="auth-brand-logo-mark">
            <ShoppingCart className="h-5 w-5" />
          </span>
          Autodecision
        </div>

        <div>
          <h1 className="auth-brand-headline">
            La gestion de votre magasin de pièces auto, simplifiée.
          </h1>
          <p className="auth-brand-sub">
            Commandes, réceptions, stock et clients — tout au même endroit, en
            temps réel.
          </p>
          <div className="auth-brand-features">
            <span className="auth-feature">
              <span className="auth-feature-dot">
                <ShoppingCart className="h-3.5 w-3.5" />
              </span>
              Commandes &amp; devis en quelques clics
            </span>
            <span className="auth-feature">
              <span className="auth-feature-dot">
                <PackageCheck className="h-3.5 w-3.5" />
              </span>
              Réception et suivi des pièces
            </span>
            <span className="auth-feature">
              <span className="auth-feature-dot">
                <BarChart3 className="h-3.5 w-3.5" />
              </span>
              Rapports et indicateurs clairs
            </span>
            <span className="auth-feature">
              <span className="auth-feature-dot">
                <ShieldCheck className="h-3.5 w-3.5" />
              </span>
              Données isolées et sécurisées par magasin
            </span>
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
              <ShoppingCart className="h-5 w-5" />
            </span>
            Autodecision
          </div>

          <h2 className="auth-title">Bon retour 👋</h2>
          <p className="auth-subtitle">
            Connectez-vous pour accéder au tableau de bord de votre magasin.
          </p>

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
            Pas encore de magasin ? <Link href="/signup">Créer un compte</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
