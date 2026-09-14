import type { Metadata } from "next";

// The installable « Livraisons » app is the livreur space only: the manifest
// (scope /livreur) and the iOS home-screen title are declared here, not on
// the whole site.
export const metadata: Metadata = {
  title: "Ma tournée — Livraisons",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Livraisons" },
};

export default function LivreurLayout({ children }: { children: React.ReactNode }) {
  return children;
}
