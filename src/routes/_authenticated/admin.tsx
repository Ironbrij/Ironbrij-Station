import { createFileRoute, Outlet, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { useCompanyShiftAutoPunchOut } from "@/lib/use-shift-auto-punch-out";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminLayout,
});

function AdminLayout() {
  const { isAdmin, employee, loading } = useAuth();
  useCompanyShiftAutoPunchOut(isAdmin && !loading);

  if (loading) return null;
  if (!isAdmin) return <Navigate to="/app/punch" />;

  const adminNav = [
    { to: "/admin", label: "Dashboard", exact: true },
    { to: "/admin/employees", label: "Employees" },
    { to: "/admin/users", label: "Users" },
    { to: "/admin/late", label: "Late Logs" },
    { to: "/admin/notices", label: "Notifications" },
    { to: "/admin/departments", label: "Departments" },
    { to: "/admin/company", label: "Company" },
    { to: "/admin/leaves", label: "Leave" },
    { to: "/admin/sod-eod", label: "SOD & EOD" },
    { to: "/admin/reports", label: "Reports" },
  ];


  return (
    <AppShell
      title="SavyTime — Admin"
      nav={adminNav}
    >
      <Outlet />
    </AppShell>
  );
}

