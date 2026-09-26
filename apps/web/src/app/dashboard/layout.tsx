import { DashboardGate } from "@/components/auth/DashboardGate";
import { BillingGate } from "@/components/billing/BillingGate";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";

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
          <Topbar />
          <BillingGate>{children}</BillingGate>
        </main>
      </div>
    </DashboardGate>
  );
}
