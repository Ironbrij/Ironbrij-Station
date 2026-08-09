import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { useShiftAutoPunchOut } from "@/lib/use-shift-auto-punch-out";

export const Route = createFileRoute("/_authenticated/app")({
  component: EmployeeLayout,
});

function EmployeeLayout() {
  const { employee, isAdmin } = useAuth();
  useShiftAutoPunchOut(employee);

  const nav = [
    { to: "/app/punch", label: "Start/Stop Work" },
    { to: "/app/extra", label: "Extra Time" },
    { to: "/app/leave", label: "Leave" },
    { to: "/app/sod-eod", label: "SOD & EOD" },
    { to: "/app/notices", label: "Notifications" },
    { to: "/app/automation", label: "Help & Feedback" },
  ];

  if (isAdmin) {
    nav.push({ to: "/admin", label: "🛡️ Admin Dashboard" });
  }

  return (
    <AppShell title="SavyTimes" nav={nav}>
      <Outlet />
    </AppShell>
  );
}
