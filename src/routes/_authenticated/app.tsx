import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { AppShell } from "@/components/AppShell";
import { usePunchOutReminder } from "@/lib/use-punch-out-reminder";
import { useLunchBreakReminder } from "@/lib/use-lunch-break-reminder";
import { useShiftAutoPunchOut } from "@/lib/use-shift-auto-punch-out";
import { useClockBallBridge } from "@/lib/use-clock-ball";
import { ClockBallConnectPrompt } from "@/components/ClockBall";

export const Route = createFileRoute("/_authenticated/app")({
  component: EmployeeLayout,
});

function EmployeeLayout() {
  const { isAdmin, user, employee, company, activeCompanyId } = useAuth();
  usePunchOutReminder({ user, employee, company, activeCompanyId });
  useLunchBreakReminder({ user, employee, company, activeCompanyId });
  useShiftAutoPunchOut({ employee, company, activeCompanyId });
  const askToConnectClockBall = useClockBallBridge(employee);

  const nav = [
    { to: "/app/punch", label: "Start/Stop Work" },
    { to: "/app/clock-ball", label: "Extension" },
    { to: "/app/leave", label: "Leave" },
    { to: "/app/sod-eod", label: "SOD & EOD" },
    { to: "/app/notices", label: "Notifications" },
    { to: "/app/automation", label: "Help & Feedback" },
  ];

  if (isAdmin) {
    nav.push({ to: "/admin", label: "Admin" });
  }

  return (
    <AppShell title="SavyTime" nav={nav}>
      {askToConnectClockBall && employee && <ClockBallConnectPrompt employee={employee} />}
      {company && activeCompanyId && activeCompanyId !== "all" ? <Outlet /> : (
        <p role="status" className="rounded-lg border bg-background p-6 text-sm">
          No assigned company is available yet. Please ask your administrator to check your company assignment.
        </p>
      )}
    </AppShell>
  );
}
