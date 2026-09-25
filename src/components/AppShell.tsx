import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { ArrowLeftRight, Building2, Headphones, LogOut } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useNavigationBadgeCounts } from "@/lib/use-navigation-badge-counts";
import { useAutoRejectExpiredLeaves } from "@/lib/use-auto-reject-expired-leaves";
import { activePunchesInOrder, useEmployeePunchesLive } from "@/lib/live-data";
import { COMPANY_ID } from "@/lib/types";
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getEmployeePunchesForCompany,
  getPunchCompanyId,
} from "@/lib/company-context";
import { getActiveWorkingSession, getLiveAttendanceStatus } from "@/lib/attendance";
import { CompanySelector } from "@/components/CompanySelector";

interface NavItem {
  to: string;
  label: string;
  exact?: boolean;
}

export function AppShell({
  title,
  nav,
  children,
}: {
  title: string;
  nav: NavItem[];
  children?: ReactNode;
}) {
  const {
    logout,
    employee,
    user,
    isAdmin,
    company,
    companies,
    activeCompanyId,
    setActiveCompanyId,
  } = useAuth();
  const navigate = useNavigate();
  // The same live punches the punch page reads, so the header never disagrees.
  const employeePunchData = useEmployeePunchesLive(employee).data;
  const employeePunches = useMemo(
    () => activePunchesInOrder(employeePunchData ?? []),
    [employeePunchData],
  );
  const adminPortal = isAdmin && title.includes("Admin");
  const navBadges = useNavigationBadgeCounts({
    isAdmin: adminPortal,
    employee,
    company,
    activeCompanyId,
  });
  useAutoRejectExpiredLeaves(adminPortal);

  const activeAttendanceCompanyIds = useMemo(() => {
    if (!employee) return [];
    const activeSession = getActiveWorkingSession(employeePunches, employee, new Date(), companies);
    return activeSession.activeCompanyId ? [activeSession.activeCompanyId] : [];
  }, [employee, employeePunches, companies]);

  const companySwitcher = (
    <CompanySelector variant="header" allowAll={isAdmin && title.includes("Admin")} activeShiftCompanyIds={activeAttendanceCompanyIds} />
  );

  return (
    <div className="min-h-screen flex flex-col bg-muted/20 text-foreground antialiased selection:bg-primary/15 selection:text-foreground">
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
          <Link
            to="/"
            className="group flex shrink-0 items-center gap-2.5 text-base font-semibold text-foreground"
          >
            <img
              src={
                company?.logoUrl ||
                "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg"
              }
              alt={company?.name || "Ironbrij"}
              className="h-8 w-8 shrink-0 rounded-lg border bg-background object-contain shadow-xs"
            />
            <div className="hidden flex-col sm:flex text-left">
              <span className="max-w-[180px] truncate font-bold text-sm leading-tight tracking-tight text-foreground">
                {company?.name || "Ironbrij"}
              </span>
              <span className="text-[11px] font-medium text-muted-foreground leading-none mt-0.5">
                Time tracking
              </span>
            </div>
          </Link>

          <div className="flex shrink-0 items-center gap-2.5">
            {isAdmin && (
              <>
                <Link
                  to={title.includes("Admin") ? "/app/punch" : "/admin"}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ArrowLeftRight className="h-4 w-4" />
                  {title.includes("Admin") ? (
                    <span className="hidden sm:inline">Employee portal</span>
                  ) : (
                    <span className="hidden sm:inline">Admin portal</span>
                  )}
                </Link>

                <Link
                  to="/admin/support"
                  className="inline-flex items-center gap-1.5 rounded-md border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Headphones className="h-4 w-4" />
                  <span className="hidden sm:inline">Support</span>
                </Link>
              </>
            )}

            <div className="hidden text-right text-xs lg:block">
              <div className="max-w-[190px] truncate font-medium leading-tight text-foreground">
                {employee?.name ?? user?.email}
              </div>
              <div className="text-[10px] font-medium text-muted-foreground">
                {isAdmin ? "Admin / Owner" : employee?.jobTitle || "Employee"}
              </div>
              {activeCompanyId !== "all" && activeAttendanceCompanyIds.some((id) => id !== activeCompanyId) && (
                <div className="text-[10px] font-semibold text-amber-700">
                  Active shift elsewhere
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={async () => {
                await logout();
                navigate({ to: "/login" });
              }}
              className="rounded-md border p-2 text-muted-foreground transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="hidden border-t bg-background md:block">
          <nav className="mx-auto flex max-w-7xl flex-wrap items-center gap-1 px-4 py-1.5 sm:px-6">
            {companySwitcher}
            {companySwitcher && <div className="mx-1 h-6 w-px shrink-0 bg-border" />}
            {nav.map((item) => {
              const badgeCount = navBadges[item.to] ?? 0;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.exact }}
                  className="relative inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  activeProps={{
                    className:
                      "relative inline-flex shrink-0 items-center whitespace-nowrap rounded-md bg-muted px-2.5 py-1.5 text-xs font-bold text-foreground transition-colors hover:bg-muted hover:text-foreground",
                  }}
                >
                  {item.label}
                  {badgeCount > 0 && (
                    <span
                      aria-label={`${badgeCount} pending or unread items`}
                      className="absolute -right-1.5 -top-1.5 flex min-h-4 min-w-4 items-center justify-center rounded-full border-2 border-background bg-red-600 px-1 text-[9px] font-bold leading-none text-white shadow-sm animate-in zoom-in-50"
                    >
                      +{badgeCount > 99 ? "99" : badgeCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex flex-wrap gap-1 border-t bg-background px-4 py-1.5 md:hidden">
          {companySwitcher}
          {companySwitcher && <div className="mx-1 h-7 w-px shrink-0 self-center bg-border" />}
          {nav.map((item) => {
            const badgeCount = navBadges[item.to] ?? 0;
            return (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className="relative shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                activeProps={{
                  className:
                    "relative shrink-0 whitespace-nowrap rounded-md bg-muted px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted hover:text-foreground",
                }}
              >
                {item.label}
                {badgeCount > 0 && (
                  <span
                    aria-label={`${badgeCount} pending or unread items`}
                    className="absolute -right-1.5 -top-1.5 flex min-h-4 min-w-4 items-center justify-center rounded-full border-2 border-background bg-red-600 px-1 text-[9px] font-bold leading-none text-white shadow-sm animate-in zoom-in-50"
                  >
                    +{badgeCount > 99 ? "99" : badgeCount}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 md:py-8">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
