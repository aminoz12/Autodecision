import { DashboardGate } from "@/components/auth/DashboardGate";
import { BillingGate } from "@/components/billing/BillingGate";
import { Sidebar } from "@/components/layout/Sidebar";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardGate>
      <div className="dashboard-shell">
        <Sidebar />
        <main className="dashboard-main">
          <BillingGate>{children}</BillingGate>
        </main>
      </div>
    </DashboardGate>
  );
}
