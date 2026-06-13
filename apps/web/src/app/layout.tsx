import type { Metadata } from "next";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { ThemeInitializer } from "@/components/theme/ThemeToggle";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pièces Auto — Gestion",
  description: "SaaS gestion pièces auto — tableau de bord magasin",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body>
        <ThemeInitializer />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
