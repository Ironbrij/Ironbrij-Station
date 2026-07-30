import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Headphones, LogOut, User } from "lucide-react";
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
    <div className="min-h-screen flex flex-col bg-background text-foreground antialiased selection:bg-primary/20 selection:text-primary">
      <header className="sticky top-0 z-50 w-full border-b bg-background/90 shadow-xs backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2.5 sm:px-6">
          <Link
            to="/"
            className="group flex shrink-0 items-center gap-2.5 text-base font-black text-primary"
          >
            <img
              src={
                company?.logoUrl ||
                "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg"
              }
              alt={company?.name || "ironbrij"}
              className="h-8 w-8 shrink-0 rounded-full border bg-background object-contain shadow-xs transition-transform group-hover:scale-105"
            />
            <span className="font-extrabold tracking-tight text-primary">
              {company?.name || "ironbrij"}
            </span>
          </Link>

          <div className="flex shrink-0 items-center gap-2.5">
            {isAdmin && (
              <Link
                to="/admin/support"
                className="btn-lift inline-flex items-center gap-1.5 rounded-lg border bg-background px-3 py-2 text-xs font-bold text-primary hover:bg-muted/60"
              >
                <Headphones className="h-4 w-4" /> Support
              </Link>
            )}

            {!isAdmin && (
              <div className="hidden items-center gap-1.5 rounded-lg border bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground sm:inline-flex">
                <User className="h-3.5 w-3.5 text-muted-foreground" />
                {employee?.name ?? user?.email}
              </div>
            )}

            <div className="hidden text-right text-xs lg:block">
              <div className="max-w-[190px] truncate font-extrabold leading-tight text-foreground">
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
              className="btn-lift rounded-lg border p-2 transition-colors hover:border-rose-500/30 hover:bg-rose-500/10 hover:text-rose-600"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="hidden border-t bg-muted/20 md:block">
          <nav className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 py-3 sm:px-6 scrollbar-none">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className="relative inline-flex shrink-0 items-center whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-semibold text-muted-foreground transition-all hover:bg-muted/70 hover:text-foreground"
                activeProps={{
                  className:
                    "relative inline-flex shrink-0 items-center whitespace-nowrap rounded-lg bg-primary px-3.5 py-2 text-sm font-extrabold text-primary-foreground shadow-xs transition-all",
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

        <div className="flex gap-1 overflow-x-auto border-t bg-muted/20 px-4 py-2.5 md:hidden scrollbar-none">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              className="relative shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
              activeProps={{
                className:
                  "relative shrink-0 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground shadow-xs",
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

      <footer className="border-t bg-card/50 py-4 text-center text-xs font-medium text-muted-foreground">
        {company?.name ? `${company.name} — ${title}` : title}
      </footer>
    </div>
  );
}
