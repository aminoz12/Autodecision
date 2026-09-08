"use client";

import { AlertTriangle, ArrowLeft, KeyRound, Loader2, Mail, MailCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { createClient } from "@/lib/supabase/client";

function ForgotForm() {
  const params = useSearchParams();
  const linkError = params?.get("erreur") === "lien";
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const redirectTo = `${window.location.origin}/auth/callback?next=/reinitialiser-mot-de-passe`;
      const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
      if (err) throw err;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Envoi impossible.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-card-logo">
        <span className="auth-card-logo-mark"><KeyRound className="h-5 w-5" /></span>
        Mot de passe oublié
      </div>
      {sent ? (
        <>
          <h2 className="auth-title">Vérifiez votre boîte mail</h2>
          <p className="auth-subtitle">
            Si un compte existe pour <strong>{email}</strong>, un lien de réinitialisation vient
            de lui être envoyé. Il est valable une heure.
          </p>
          <div className="auth-error" style={{ background: "var(--clr-success-bg)", color: "var(--clr-success-text)" }}>
            <MailCheck className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Pensez à regarder dans les courriers indésirables.</span>
          </div>
        </>
      ) : (
        <>
          <h2 className="auth-title">Réinitialiser votre mot de passe</h2>
          <p className="auth-subtitle">
            Indiquez l&apos;email de votre compte : vous recevrez un lien pour choisir un
            nouveau mot de passe.
          </p>
          <form onSubmit={onSubmit} className="auth-form">
            {(error || linkError) && (
              <div className="auth-error">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error ?? "Ce lien est invalide ou a expiré. Demandez-en un nouveau."}</span>
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
                  placeholder="vous@monmagasin.fr"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
            </div>
            <button type="submit" className="auth-btn" disabled={loading}>
              {loading && <Loader2 className="h-4 w-4 auth-spin" />}
              {loading ? "Envoi…" : "Envoyer le lien"}
            </button>
          </form>
        </>
      )}
      <p className="auth-foot">
        <Link href="/caissier/login"><ArrowLeft className="h-3.5 w-3.5" style={{ display: "inline", verticalAlign: "-2px" }} /> Retour à la connexion</Link>
      </p>
    </div>
  );
}

export default function ForgotPasswordPage() {
  return (
    <div className="auth-page auth-page--single">
      <main className="auth-panel">
        <Suspense fallback={null}>
          <ForgotForm />
        </Suspense>
      </main>
    </div>
  );
}
