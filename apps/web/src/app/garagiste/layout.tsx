import { AuthProvider } from "@/components/providers/AuthProvider";

/**
 * The garagiste area runs its own AuthProvider with a separate session store
 * (storageKey), so a garagiste and a magasin can be logged in at the same time
 * in one browser without overwriting each other's session.
 */
export default function GaragisteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AuthProvider storageKey="sb-garagiste-auth">{children}</AuthProvider>;
}
