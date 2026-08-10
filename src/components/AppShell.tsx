import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { ArrowLeftRight, Headphones, LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { useAdminLateNotificationCount } from "@/lib/use-admin-late-notification-count";
import { useAutoRejectExpiredLeaves } from "@/lib/use-auto-reject-expired-leaves";

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
  const { logout, employee, user, isAdmin, company } = useAuth();
  const navigate = useNavigate();
  const unreadLateCount = useAdminLateNotificationCount({ enabled: isAdmin, company });
  useAutoRejectExpiredLeaves(isAdmin);

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
