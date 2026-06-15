"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Gift,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  Store,
  User,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";

export default function SignupPage() {
  const { signUp, ready, user } = useAuth();
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);

  useEffect(() => {
    if (ready && user) {
      router.replace("/dashboard");
    }
  }, [ready, user, router]);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setLoading(true);
      setError(null);
      try {
        const { needsConfirmation } = await signUp({
          organizationName: orgName,
          displayName,
          email,
          password,
        });
        if (needsConfirmation) {
          setConfirmSent(true);
        } else {
          router.replace("/dashboard");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Inscription impossible");
      } finally {
        setLoading(false);
      }
    },
    [orgName, displayName, email, password, signUp, router],
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
            <Store className="h-5 w-5" />
          </span>
          Autodecision
        </div>

        <div>
          <h1 className="auth-brand-headline">
            Lancez votre magasin en quelques minutes.
          </h1>
          <p className="auth-brand-sub">
            Créez votre espace, vous en êtes l&apos;administrateur. Aucune carte
            bancaire requise pour commencer.
          </p>
          <div className="auth-brand-features">
            <span className="auth-feature">
              <span className="auth-feature-dot">
                <Gift className="h-3.5 w-3.5" />
              </span>
              14 jours d&apos;essai gratuit
            </span>
            <span className="auth-feature">
              <span className="auth-feature-dot">
                <Zap className="h-3.5 w-3.5" />
              </span>
              Prêt à l&apos;emploi, sans installation
            </span>
            <span className="auth-feature">
              <span className="auth-feature-dot">
                <ShieldCheck className="h-3.5 w-3.5" />
              </span>
              Vos données isolées et sécurisées
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
              <Store className="h-5 w-5" />
            </span>
            Autodecision
          </div>

          {confirmSent ? (
            <>
              <h2 className="auth-title">Magasin créé 🎉</h2>
              <p className="auth-subtitle">
                Confirmez votre adresse email via le lien que nous venons de vous
                envoyer, puis connectez-vous.
              </p>
              <div className="auth-form">
                <div className="auth-success">
                  <CheckCircle2 className="h-4 w-4 inline-block mr-1.5 -mt-0.5" />
                  Un email de confirmation a été envoyé à{" "}
                  <strong>{email}</strong>.
                </div>
                <button
                  type="button"
                  className="auth-btn"
                  onClick={() => router.replace("/login")}
                >
                  Aller à la connexion
                </button>
              </div>
            </>
          ) : (
            <>
              <h2 className="auth-title">Créer votre magasin</h2>
              <p className="auth-subtitle">
                Ouvrez votre espace — essai gratuit de 14 jours.
              </p>

              <form onSubmit={onSubmit} className="auth-form">
                {error && (
                  <div className="auth-error">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}

                <div className="auth-field">
                  <label htmlFor="orgName" className="auth-label">
                    Nom du magasin
                  </label>
                  <div className="auth-input-wrap">
                    <Store />
                    <input
                      id="orgName"
                      className="auth-input"
                      type="text"
                      autoComplete="organization"
                      placeholder="Ex : Pièces Auto 92"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <label htmlFor="displayName" className="auth-label">
                    Votre nom
                  </label>
                  <div className="auth-input-wrap">
                    <User />
                    <input
                      id="displayName"
                      className="auth-input"
                      type="text"
                      autoComplete="name"
                      placeholder="Ex : Karim B."
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      required
                    />
                  </div>
                </div>

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
                      autoComplete="new-password"
                      minLength={6}
                      placeholder="6 caractères minimum"
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
                  {loading ? "Création…" : "Créer mon magasin"}
                </button>
              </form>
            </>
          )}

          <p className="auth-foot">
            Déjà un compte ? <Link href="/login">Se connecter</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
