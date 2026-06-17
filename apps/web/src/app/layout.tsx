import type { Metadata } from "next";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { ThemeInitializer } from "@/components/theme/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pièces Auto — Gestion",
  description: "SaaS gestion pièces auto — tableau de bord magasin",
  // Tell translators not to translate the app: Google Translate rewrites text
  // nodes and breaks React's DOM reconciliation (insertBefore NotFoundError).
  other: { google: "notranslate" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" translate="no" className="notranslate" suppressHydrationWarning>
      <body>
        <ThemeInitializer />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
