"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { Button } from "@/components/ui/Button";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

export default function SignupPage() {
  const { signUp, ready, user } = useAuth();
  const router = useRouter();
  const [orgName, setOrgName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
        Chargement…
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-zinc-100 px-4 dark:bg-zinc-950">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-md">
        <CardTitle>Créer votre magasin</CardTitle>
        <CardDescription>
          Ouvrez votre espace : vous serez l&apos;administrateur de votre magasin.
        </CardDescription>

        {confirmSent ? (
          <div className="mt-6 space-y-4">
            <p className="rounded-md bg-emerald-50 px-3 py-3 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
              Votre magasin a été créé. Confirmez votre email via le lien envoyé
              par Supabase, puis connectez-vous.
            </p>
            <Button
              type="button"
              className="w-full"
              onClick={() => router.replace("/login")}
            >
              Aller à la connexion
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
                {error}
              </p>
            )}
            <div>
              <Label htmlFor="orgName">Nom du magasin</Label>
              <Input
                id="orgName"
                type="text"
                autoComplete="organization"
                placeholder="Ex : Pièces Auto 92"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="displayName">Votre nom</Label>
              <Input
                id="displayName"
                type="text"
                autoComplete="name"
                placeholder="Ex : Karim B."
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="password">Mot de passe</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Création…" : "Créer mon magasin"}
            </Button>
          </form>
        )}

        <p className="mt-6 text-center text-sm text-zinc-500">
          Déjà un compte ?{" "}
          <Link href="/login" className="font-medium text-emerald-600 hover:underline">
            Se connecter
          </Link>
        </p>
      </Card>
    </div>
  );
}
