import { GarageGate } from "@/components/auth/GarageGate";
import { GarageNav } from "@/components/garage/GarageNav";

export default function GarageLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <GarageGate>
      <div className="gp-shell">
        <GarageNav />
        <main className="gp-main">{children}</main>
      </div>
    </GarageGate>
  );
}
