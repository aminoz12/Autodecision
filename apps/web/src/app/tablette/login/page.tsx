import { SpaceLogin } from "@/components/auth/SpaceLogin";

// The stock tablet signs in once with a magasin account (a « Tablette stock »
// cashier is best), then always lands back on /tablette.
export default function TabletteLoginPage() {
  return <SpaceLogin space="caissier" home="/tablette" alsoAccept={["admin"]} />;
}
