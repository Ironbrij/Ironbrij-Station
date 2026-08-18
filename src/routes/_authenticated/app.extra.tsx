import { createFileRoute } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/_authenticated/app/extra")({
  head: () => ({
    meta: [
      { title: "Overtime & Extra Time — SavyTimes" },
      { name: "description", content: "Automatic overtime tracking." },
    ],
  }),
  component: ExtraPage,
});

function ExtraPage() {
  const { employee } = useAuth();

  if (!employee)
    return <div className="p-8 text-center text-muted-foreground">No employee profile active.</div>;

  return (
    <div className="max-w-xl mx-auto space-y-6 pt-4">
      <div className="rounded-2xl border bg-card p-6 sm:p-8 space-y-6 text-center shadow-xs">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Clock className="h-7 w-7" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Overtime is Now Automatic!
          </h1>
          <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            You no longer need a separate extra time punch. Simply use the main{" "}
            <strong>Web Punch</strong> page — when you work beyond your scheduled hours or on an
            off-day/holiday, your overtime is automatically calculated and submitted for admin
            approval.
          </p>
        </div>

        <div className="pt-2">
          <a
            href="/app/punch"
            className="inline-flex items-center justify-center rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 transition-all"
          >
            Go to Web Punch
          </a>
        </div>
      </div>
    </div>
  );
}
