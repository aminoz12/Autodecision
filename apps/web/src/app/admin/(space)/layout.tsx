import { DashboardGate } from "@/components/auth/DashboardGate";
import { BillingGate } from "@/components/billing/BillingGate";
import { Sidebar } from "@/components/layout/Sidebar";

/** /admin — the magasin admin space, same shell as the dashboard. */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <DashboardGate loginHref="/admin/login">
      <div className="dashboard-shell">
        <Sidebar />
        <main className="dashboard-main">
          <BillingGate>{children}</BillingGate>
        </main>
      </div>
    </DashboardGate>
  );
}
