import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AuthProvider } from "@/components/providers/AuthProvider";
import { ThemeInitializer } from "@/components/theme/ThemeToggle";
import "./globals.css";
import "./design-system.css";

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
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#635BFF",
  width: "device-width",
  initialScale: 1,
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
        {/* The remembered sidebar state, applied before the first paint so it never flashes open. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('sidebar')==='collapsed')document.documentElement.setAttribute('data-sidebar','collapsed')}catch(e){}",
          }}
        />
        <ThemeInitializer />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
