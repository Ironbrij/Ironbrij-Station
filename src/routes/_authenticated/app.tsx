import { createFileRoute, Outlet, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { useShiftAutoPunchOut } from "@/lib/use-shift-auto-punch-out";

export const Route = createFileRoute("/_authenticated/app")({
  component: EmployeeLayout,
});

function EmployeeLayout() {
  const { isAdmin, employee } = useAuth();
  useShiftAutoPunchOut(employee);

  if (isAdmin) return <Navigate to="/admin" />;
  return (
    <AppShell
      title="Time Station"
      nav={[
        { to: "/app/punch", label: "Punch" },
        { to: "/app/extra", label: "Extra Time" },
        { to: "/app/leave", label: "Leave" },
        { to: "/app/notices", label: "Notifications" },
        { to: "/app/automation", label: "Automation" },
      ]}
    >
      <Outlet />
    </AppShell>
  );
}
