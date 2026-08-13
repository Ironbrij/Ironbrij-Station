import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { ArrowLeftRight, Headphones, LogOut } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAdminLateNotificationCount } from "@/lib/use-admin-late-notification-count";
import { useAutoRejectExpiredLeaves } from "@/lib/use-auto-reject-expired-leaves";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { COMPANY_ID, type Punch } from "@/lib/types";
import { getPunchCompanyId } from "@/lib/company-context";

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
  const [employeePunches, setEmployeePunches] = useState<Punch[]>([]);
  const [pendingCompanyId, setPendingCompanyId] = useState(activeCompanyId);
  const unreadLateCount = useAdminLateNotificationCount({ enabled: isAdmin, company });
  useAutoRejectExpiredLeaves(isAdmin);

  useEffect(() => {
    setPendingCompanyId(activeCompanyId);
  }, [activeCompanyId]);

  useEffect(() => {
    if (!employee) return;
    const punchesQuery = query(collection(db(), "punches"), where("employeeId", "==", employee.id));
    return onSnapshot(punchesQuery, (snapshot) => {
      setEmployeePunches(
        snapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) }))
          .filter((punch) => punch.timestamp)
          .sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis()),
      );
    });
  }, [employee]);

  const activeAttendanceCompanyIds = useMemo(() => {
    const latestByCompany = new Map<string, Punch>();
    employeePunches.forEach((punch) => {
      if (punch.type === "in" || punch.type === "out") {
        latestByCompany.set(getPunchCompanyId(punch, employee), punch);
      }
    });
    return [...latestByCompany.entries()]
      .filter(([, punch]) => punch.type === "in")
      .map(([companyId]) => companyId);
  }, [employee, employeePunches]);

  function switchCompany() {
    const companyId = pendingCompanyId;
    if (companyId === activeCompanyId) return;
    const otherActiveCompanyId = activeAttendanceCompanyIds.find((id) => id !== companyId);
    if (otherActiveCompanyId) {
      const activeName =
        companies.find((item) => (item.id || COMPANY_ID) === otherActiveCompanyId)?.name ||
        "another company";
      const shouldContinue = window.confirm(
        `You are still punched in to ${activeName}. Switching company will not move or close that attendance session. Continue?`,
      );
      if (!shouldContinue) return;
    }
    setActiveCompanyId(companyId);
  }

  const companySwitcher =
    companies.length > 1 ? (
      <div className="flex shrink-0 items-center gap-2 rounded-md border bg-muted/30 p-1.5">
        <label className="flex items-center gap-2">
          <span className="hidden text-xs font-medium text-muted-foreground xl:inline">
            Company
          </span>
          <select
            value={pendingCompanyId}
            onChange={(event) => setPendingCompanyId(event.target.value)}
            className="max-w-36 rounded-md border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground sm:max-w-48"
            aria-label="Choose company"
          >
            {companies.map((item) => (
              <option key={item.id || item.name} value={item.id || COMPANY_ID}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={switchCompany}
          disabled={pendingCompanyId === activeCompanyId}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground"
        >
          Switch
        </button>
      </div>
    ) : null;

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
              alt={company?.name || "ironbrij"}
              className="h-8 w-8 shrink-0 rounded-lg border bg-background object-contain"
            />
            <span className="hidden max-w-[180px] truncate font-semibold tracking-tight text-foreground sm:inline">
              {company?.name || "ironbrij"}
            </span>
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
              {activeAttendanceCompanyIds.some((id) => id !== activeCompanyId) && (
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
          <nav className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 py-2 sm:px-6 scrollbar-none">
            {companySwitcher}
            {companySwitcher && <div className="mx-1 h-7 w-px shrink-0 bg-border" />}
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className="relative inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                activeProps={{
                  className:
                    "relative inline-flex shrink-0 items-center whitespace-nowrap rounded-md bg-muted px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted hover:text-foreground",
                }}
              >
                {item.label}
                {item.to === "/admin/notices" && unreadLateCount > 0 && (
                  <span
                    aria-label={`${unreadLateCount} unread late alerts`}
                    className="absolute -right-1.5 -top-1.5 flex min-h-5 min-w-5 items-center justify-center rounded-full border-2 border-background bg-red-600 px-1 text-[10px] font-bold leading-none text-white shadow-sm"
                  >
                    +{unreadLateCount}
                  </span>
                )}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex gap-1 overflow-x-auto border-t bg-background px-4 py-2 md:hidden scrollbar-none">
          {companySwitcher}
          {companySwitcher && <div className="mx-1 h-7 w-px shrink-0 self-center bg-border" />}
          {nav.map((item) => (
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
              {item.to === "/admin/notices" && unreadLateCount > 0 && (
                <span
                  aria-label={`${unreadLateCount} unread late alerts`}
                  className="absolute -right-1.5 -top-1.5 flex min-h-4 min-w-4 items-center justify-center rounded-full border-2 border-background bg-red-600 px-1 text-[9px] font-bold leading-none text-white shadow-sm"
                >
                  +{unreadLateCount}
                </span>
              )}
            </Link>
          ))}
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 md:py-8">
        {children ?? <Outlet />}
      </main>
    </div>
  );
}
