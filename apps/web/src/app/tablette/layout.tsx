import type { Metadata, Viewport } from "next";

// The stock tablet: « Suivi des commandes » alone, full screen, installable
// (its own manifest, scope /tablette) so it opens like an app and can be pinned.
export const metadata: Metadata = {
  title: "Suivi des commandes — Tablette",
  manifest: "/tablette.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Suivi commandes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Fingers on a counter: no accidental pinch-zoom.
  maximumScale: 1,
  userScalable: false,
};

export default function TabletteLayout({ children }: { children: React.ReactNode }) {
  return children;
}
