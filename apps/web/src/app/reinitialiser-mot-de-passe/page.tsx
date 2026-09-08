"use client";

import { AlertTriangle, Check, Eye, EyeOff, KeyRound, Loader2, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { loginFor } from "@/lib/spaces";

const MIN = 8;

/**
 * Sets a new password for the session opened by /auth/callback (recovery link
 * or invitation). Ends by signing out and sending the user to the login door
 * of their space.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [ready, setReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [pwd, setPwd] = useState("");
  const [pwd2, setPwd2] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setHasSession(!!data.user);
      setEmail(data.user?.email ?? null);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pwd.length < MIN) {
      setError(`Le mot de passe doit contenir au moins ${MIN} caractères.`);
      return;
    }
    if (pwd !== pwd2) {
      setError("Les deux mots de passe ne correspondent pas.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const { error: err } = await supabase.auth.updateUser({ password: pwd });
      if (err) throw err;
      let door = "/caissier/login";
      if (userData.user) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("role,client_id")
          .eq("user_id", userData.user.id)
          .maybeSingle();
        door = loginFor(profile as { role: "ADMIN" | "CAISSIER" | "LIVREUR"; client_id: string | null } | null, userData.user.email);
      }
      await supabase.auth.signOut();
      setDone(door);
      window.setTimeout(() => router.replace(door), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Modification impossible.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page auth-page--single">
      <main className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-logo">
            <span className="auth-card-logo-mark"><KeyRound className="h-5 w-5" /></span>
            Nouveau mot de passe
          </div>

          {!ready ? (
            <div className="auth-loading"><Loader2 className="h-5 w-5 auth-spin" /></div>
          ) : done ? (
            <>
              <h2 className="auth-title">Mot de passe enregistré</h2>
              <p className="auth-subtitle">Vous allez être redirigé vers la page de connexion.</p>
              <div className="auth-error" style={{ background: "var(--clr-success-bg)", color: "var(--clr-success-text)" }}>
                <Check className="h-4 w-4 mt-0.5 shrink-0" />
                <span>Connectez-vous avec votre nouveau mot de passe.</span>
              </div>
              <p className="auth-foot"><Link href={done}>Aller à la connexion</Link></p>
            </>
          ) : !hasSession ? (
            <>
              <h2 className="auth-title">Lien expiré</h2>
              <p className="auth-subtitle">
                Ce lien n&apos;est plus valable. Demandez un nouveau lien de réinitialisation.
              </p>
              <p className="auth-foot"><Link href="/mot-de-passe-oublie">Recevoir un nouveau lien</Link></p>
            </>
          ) : (
            <>
              <h2 className="auth-title">Choisissez un mot de passe</h2>
              <p className="auth-subtitle">
                {email ? <>Pour le compte <strong>{email}</strong>. </> : null}
                Au moins {MIN} caractères.
              </p>
              <form onSubmit={onSubmit} className="auth-form">
                {error && (
                  <div className="auth-error">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </div>
                )}
                <div className="auth-field">
                  <label htmlFor="pwd" className="auth-label">Nouveau mot de passe</label>
                  <div className="auth-input-wrap">
                    <Lock />
                    <input id="pwd" className="auth-input" type={show ? "text" : "password"} autoComplete="new-password" value={pwd} onChange={(e) => setPwd(e.target.value)} required minLength={MIN} autoFocus />
                    <button type="button" className="auth-eye" onClick={() => setShow((v) => !v)} aria-label={show ? "Masquer" : "Afficher"}>
                      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div className="auth-field">
                  <label htmlFor="pwd2" className="auth-label">Confirmez le mot de passe</label>
                  <div className="auth-input-wrap">
                    <Lock />
                    <input id="pwd2" className="auth-input" type={show ? "text" : "password"} autoComplete="new-password" value={pwd2} onChange={(e) => setPwd2(e.target.value)} required minLength={MIN} />
                  </div>
                </div>
                <button type="submit" className="auth-btn" disabled={loading}>
                  {loading && <Loader2 className="h-4 w-4 auth-spin" />}
                  {loading ? "Enregistrement…" : "Enregistrer le mot de passe"}
                </button>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
