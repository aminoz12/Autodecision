import { GarageGate } from "@/components/auth/GarageGate";
import { GarageNav } from "@/components/garage/GarageNav";
import { NewVersionNotice } from "@/components/ui/NewVersionNotice";

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
        <NewVersionNotice />
      </div>
    </GarageGate>
  );
}
