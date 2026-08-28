import type { Metadata } from "next";
import localFont from "next/font/local";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { ThemeInitializer } from "@/components/theme/ThemeToggle";
import "./globals.css";

// Inter (variable), self-hosted from ./fonts so builds never depend on Google.
// Exposed as --font-inter (see --font-main in globals.css).
const inter = localFont({
  src: [
    { path: "./fonts/inter-latin.woff2", weight: "100 900", style: "normal" },
    { path: "./fonts/inter-latin-ext.woff2", weight: "100 900", style: "normal" },
  ],
  display: "swap",
  variable: "--font-inter",
});

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
    <html
      lang="fr"
      translate="no"
      className={`notranslate ${inter.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeInitializer />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
