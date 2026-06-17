"use client";

import type { AuthError, User } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { UserProfile, UserRole } from "@/lib/types/api";
import { createClient } from "@/lib/supabase/client";

type AuthContextValue = {
  user: User | null;
  profile: UserProfile | null;
  /** The Supabase client bound to this provider's session store. */
  supabase: ReturnType<typeof createClient>;
  /** Erreur PostgREST / RLS sur la lecture de public.profiles (sinon null). */
  profileLoadError: string | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  signUp: (params: {
    organizationName: string;
    displayName: string;
    email: string;
    password: string;
  }) => Promise<{ needsConfirmation: boolean }>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function mapSignInError(error: AuthError): string {
  const raw = (error.message ?? "").toLowerCase();

  if (raw.includes("invalid login") || raw.includes("invalid_credentials")) {
    return [
      "Identifiants refusés par Supabase : email / mot de passe incorrects, compte inexistant sur ce projet, ou email pas encore confirmé.",
      "Vérifiez le projet (URL + clé anon dans .env.local), créez l’utilisateur sous Authentication → Users, et dans Authentication → Providers → Email désactivez temporairement « Confirm email » si vous testez sans boîte mail.",
    ].join(" ");
  }

  if (raw.includes("email not confirmed")) {
    return "Confirmez l’email (lien envoyé par Supabase) ou désactivez « Confirm email » dans Authentication → Providers → Email pour le développement.";
  }

  return error.message;
}

function mapSignUpError(error: AuthError): string {
  const raw = (error.message ?? "").toLowerCase();
  if (
    raw.includes("already registered") ||
    raw.includes("already exists") ||
    raw.includes("user already")
  ) {
    return "Un compte existe déjà avec cet email. Connectez-vous, ou utilisez une autre adresse.";
  }
  if (raw.includes("password")) {
    return "Mot de passe invalide (au moins 6 caractères).";
  }
  if (raw.includes("email") && raw.includes("invalid")) {
    return "Adresse email invalide.";
  }
  return error.message;
}

function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const m = err.message.toLowerCase();
  return (
    err instanceof TypeError ||
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("load failed") ||
    m.includes("network request failed")
  );
}

function mapNetworkError(err: unknown): string {
  if (err instanceof Error && err.message.includes("NEXT_PUBLIC_SUPABASE")) {
    return err.message;
  }
  if (!isNetworkFailure(err)) {
    return err instanceof Error ? err.message : String(err);
  }
  return [
    "Le navigateur n’a pas pu joindre Supabase (Failed to fetch).",
    "Vérifiez la connexion internet, désactivez bloqueur de pubs / extensions, essayez hors VPN.",
    "Contrôlez NEXT_PUBLIC_SUPABASE_URL et la clé anon (Settings → API du même projet), sans espace, .env.local dans apps/web, puis redémarrez le serveur de dev.",
  ].join(" ");
}

async function loadProfile(
  supabase: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ profile: UserProfile | null; errorMessage: string | null }> {
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, organization_id, display_name, role, client_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return { profile: null, errorMessage: error.message };
  }
  if (!data) {
    return { profile: null, errorMessage: null };
  }

  return {
    profile: {
      user_id: data.user_id,
      organization_id: data.organization_id,
      display_name: data.display_name,
      role: data.role as UserRole,
      client_id: (data.client_id as string | null) ?? null,
    },
    errorMessage: null,
  };
}

export function AuthProvider({
  children,
  storageKey,
}: {
  children: React.ReactNode;
  /** Distinct session store (separate cookies) — e.g. the garagiste portal. */
  storageKey?: string;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoadError, setProfileLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const supabase = useMemo(() => createClient(storageKey), [storageKey]);

  const refreshProfile = useCallback(async () => {
    const {
      data: { user: u },
    } = await supabase.auth.getUser();
    if (!u) {
      setUser(null);
      setProfile(null);
      setProfileLoadError(null);
      return;
    }
    setUser(u);
    const { profile: p, errorMessage } = await loadProfile(supabase, u.id);
    setProfile(p);
    setProfileLoadError(errorMessage);
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await refreshProfile();
      if (!cancelled) {
        setReady(true);
      }
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        void loadProfile(supabase, session.user.id).then(
          ({ profile: p, errorMessage }) => {
            setProfile(p);
            setProfileLoadError(errorMessage);
          },
        );
      } else {
        setProfile(null);
        setProfileLoadError(null);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [supabase, refreshProfile]);

  const login = useCallback(
    async (email: string, password: string) => {
      const emailNorm = email.trim().toLowerCase();
      let authErr: AuthError | null = null;
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email: emailNorm,
          password,
        });
        authErr = error;
      } catch (e) {
        throw new Error(mapNetworkError(e));
      }
      if (authErr) {
        throw new Error(mapSignInError(authErr));
      }
      try {
        await refreshProfile();
      } catch (e) {
        throw new Error(mapNetworkError(e));
      }
    },
    [supabase, refreshProfile],
  );

  const signUp = useCallback<AuthContextValue["signUp"]>(
    async ({ organizationName, displayName, email, password }) => {
      const emailNorm = email.trim().toLowerCase();
      let result: Awaited<ReturnType<typeof supabase.auth.signUp>>;
      try {
        result = await supabase.auth.signUp({
          email: emailNorm,
          password,
          options: {
            data: {
              organization_name: organizationName.trim(),
              display_name: displayName.trim(),
            },
          },
        });
      } catch (e) {
        throw new Error(mapNetworkError(e));
      }
      if (result.error) {
        throw new Error(mapSignUpError(result.error));
      }
      // Email confirmation disabled → a session is returned immediately.
      if (result.data.session) {
        try {
          await refreshProfile();
        } catch (e) {
          throw new Error(mapNetworkError(e));
        }
        return { needsConfirmation: false };
      }
      // Email confirmation enabled → the magasin + ADMIN profile were created by
      // the DB trigger, but the user must confirm before they can sign in.
      return { needsConfirmation: true };
    },
    [supabase, refreshProfile],
  );

  const logout = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setProfileLoadError(null);
  }, [supabase]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      supabase,
      profileLoadError,
      ready,
      login,
      signUp,
      logout,
      refreshProfile,
    }),
    [user, profile, supabase, profileLoadError, ready, login, signUp, logout, refreshProfile],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
