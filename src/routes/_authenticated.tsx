import { createFileRoute, Outlet, Navigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/_authenticated")({
  component: Guard,
});

function Guard() {
  const { user, employee, isAdmin, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="h-10 w-40 skeleton-shimmer" />
      </div>
    );
  }
  if (!user || (!isAdmin && (!employee || employee.status !== "active" || employee.inviteStatus !== "accepted"))) {
    return <Navigate to="/login" />;
  }
  return <Outlet />;
}
