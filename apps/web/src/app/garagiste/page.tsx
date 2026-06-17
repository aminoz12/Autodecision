"use client";

import {
  AlertTriangle,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";

export default function GaragisteLoginPage() {
  const { login, ready, user, profile } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Only forward an already-logged-in garagiste to their portal. A staff
  // session (or no session) stays here so a garagiste can sign in — even on a
  // machine where the magasin is logged in, logging in here replaces it.
  useEffect(() => {
    if (ready && user && profile?.client_id) {
      router.replace("/garagiste/dashboard");
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
      <aside className="auth-brand auth-brand--garage">
        <div className="auth-brand-logo">
          <span className="auth-brand-logo-mark">
            <Wrench className="h-5 w-5" />
          </span>
          Espace garagiste
        </div>

        <div>
          <h1 className="auth-brand-headline">
            Commandez vos pièces, suivez vos retours.
          </h1>
          <p className="auth-brand-sub">
            Votre espace dédié pour passer commande auprès de votre magasin
            partenaire, en quelques clics.
          </p>
          <div className="auth-brand-features">
            <span className="auth-feature">
              <span className="auth-feature-dot"><PackageCheck className="h-3.5 w-3.5" /></span>
              Commandez vos pièces en ligne
            </span>
            <span className="auth-feature">
              <span className="auth-feature-dot"><RotateCcw className="h-3.5 w-3.5" /></span>
              Demandez un retour facilement
            </span>
            <span className="auth-feature">
              <span className="auth-feature-dot"><ShieldCheck className="h-3.5 w-3.5" /></span>
              Suivez vos commandes et votre encours
            </span>
          </div>
        </div>

        <p className="auth-brand-foot">© 2026 Autodecision · Espace garagiste</p>
        <span className="auth-brand-orb auth-brand-orb--1" />
        <span className="auth-brand-orb auth-brand-orb--2" />
      </aside>

      {/* Form panel */}
      <main className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-logo">
            <span className="auth-card-logo-mark"><Wrench className="h-5 w-5" /></span>
            Espace garagiste
          </div>

          <h2 className="auth-title">Connexion garagiste</h2>
          <p className="auth-subtitle">
            Connectez-vous avec les identifiants fournis par votre magasin.
          </p>

          <form onSubmit={onSubmit} className="auth-form">
            {error && (
              <div className="auth-error">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="auth-field">
              <label htmlFor="email" className="auth-label">Email</label>
              <div className="auth-input-wrap">
                <Mail />
                <input
                  id="email"
                  className="auth-input"
                  type="email"
                  autoComplete="username"
                  placeholder="contact@garage.fr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor="password" className="auth-label">Mot de passe</label>
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
                  {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button type="submit" className="auth-btn auth-btn--garage" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 auth-spin" />}
              {loading ? "Connexion…" : "Se connecter"}
            </button>
          </form>

          <p className="auth-foot">
            Vous êtes un magasin ? <a href="/login">Connexion magasin</a>
          </p>
        </div>
      </main>
    </div>
  );
}
