import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, onSnapshot, query, serverTimestamp, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { LeaveRequest, Punch } from "@/lib/types";
import { ymd } from "@/lib/time";
import { toast } from "sonner";
import { Clock, ShieldAlert, CheckCircle2, Lock } from "lucide-react";
import { format } from "date-fns";
import {
  getActiveEmployeeLeave,
  getEmployeeHoliday,
  getEmployeeShiftWindow,
  getEmployeeTimezone,
  getLeaveLabel,
  zonedDateKey,
} from "@/lib/attendance";
import { getPunchCompanyId, getRequiredWorkMinutes } from "@/lib/company-context";

export const Route = createFileRoute("/_authenticated/app/extra")({
  head: () => ({
    meta: [
      { title: "Extra Time & Overtime — SavyTimes" },
      { name: "description", content: "Log overtime hours worked outside shift." },
      { property: "og:title", content: "Extra Time — SavyTimes" },
      { property: "og:description", content: "Log overtime hours worked outside shift." },
    ],
  }),
  component: ExtraPage,
});

function ExtraPage() {
  const { employee, company, activeCompanyId } = useAuth();
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const todayStr = employee
    ? zonedDateKey(new Date(), getEmployeeTimezone(employee))
    : ymd(new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const companyPunches = useMemo(
    () => allPunches.filter((punch) => getPunchCompanyId(punch, employee) === activeCompanyId),
    [activeCompanyId, allPunches, employee],
  );
  const companyLeaves = useMemo(
    () =>
      leaves.filter(
        (leave) =>
          (leave.companyId || employee?.companyIds?.[0] || employee?.companyId) === activeCompanyId,
      ),
    [activeCompanyId, employee, leaves],
  );

  useEffect(() => {
    if (!employee) return;
    const q1 = query(collection(db(), "punches"), where("employeeId", "==", employee.id));
    const un1 = onSnapshot(q1, (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }));
      const sorted = list.sort(
        (a, b) => (a.timestamp?.toMillis() || 0) - (b.timestamp?.toMillis() || 0),
      );
      setAllPunches(sorted);
    });

    const q2 = query(collection(db(), "leaveRequests"), where("employeeId", "==", employee.id));
    const un2 = onSnapshot(q2, (snap) => {
      setLeaves(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LeaveRequest, "id">) })));
    });

    return () => {
      un1();
      un2();
    };
  }, [employee]);

  const isHoliday = useMemo(() => {
    return Boolean(getEmployeeHoliday(company, employee, todayStr));
  }, [company, employee, todayStr]);

  const activeLeave = useMemo(
    () => (employee ? getActiveEmployeeLeave(employee, companyLeaves, now) : null),
    [employee, companyLeaves, now],
  );
  const onLeaveToday = Boolean(activeLeave);

  // Determine latest status
  const latestPunch = useMemo(() => companyPunches[companyPunches.length - 1], [companyPunches]);
  const isRegularPunchedIn = useMemo(() => latestPunch?.type === "in", [latestPunch]);
  const isExtraPunchedIn = useMemo(() => latestPunch?.type === "extra_in", [latestPunch]);

  // Check if currently within regular shift hours
  const isCurrentlyInShiftHours = useMemo(() => {
    if (!employee) return false;
    const shift = getEmployeeShiftWindow(employee, now);
    return now >= shift.start && now < shift.end;
  }, [employee, now]);

  // Shift restriction is bypassed on holidays!
  const shiftBlocked = !isHoliday && isCurrentlyInShiftHours && !isExtraPunchedIn;

  const todayExtras = useMemo(() => {
    return companyPunches.filter(
      (p) =>
        (p.type === "extra_in" || p.type === "extra_out") &&
        p.timestamp &&
        employee &&
        zonedDateKey(p.timestamp.toDate(), getEmployeeTimezone(employee)) === todayStr,
    );
  }, [companyPunches, employee, todayStr]);

  async function toggleExtra() {
    if (!employee) return;

    if (onLeaveToday) {
      toast.error(
        `Overtime logging is disabled during ${getLeaveLabel(activeLeave).toLowerCase()}.`,
      );
      return;
    }

    // Rule 1: Cannot start extra time if punched IN on regular shift
    if (!isExtraPunchedIn && isRegularPunchedIn) {
      toast.error(
        "You are currently punched IN on your regular shift! Please punch out from your regular shift before logging extra time.",
        {
          duration: 5000,
        },
      );
      return;
    }

    // Rule 2: Cannot start extra time during regular shift hours (unless it's a holiday)
    if (!isExtraPunchedIn && shiftBlocked) {
      toast.warning(
        `Cannot start Extra Time during regular shift hours (${employee.shiftStartTime || "09:00"} - ${employee.shiftEndTime || "17:00"}). Extra time can only be logged outside scheduled shift hours.`,
        {
          duration: 6000,
        },
      );
      return;
    }

    setBusy(true);
    try {
      const nextType = isExtraPunchedIn ? "extra_out" : "extra_in";
      const overtimeMinutes =
        nextType === "extra_out" && latestPunch?.timestamp
          ? Math.max(0, Math.floor((Date.now() - latestPunch.timestamp.toMillis()) / 60_000))
          : undefined;
      await addDoc(collection(db(), "punches"), {
        employeeId: employee.id,
        employeeName: employee.name,
        companyId: activeCompanyId,
        companyName: company?.name || "Company",
        date: todayStr,
        attendanceDate: todayStr,
        type: nextType,
        timestamp: serverTimestamp(),
        source: "app",
        requiredWorkMinutes: getRequiredWorkMinutes(employee, company),
        ...(overtimeMinutes === undefined
          ? { attendanceStatus: "in_progress" }
          : {
              normalWorkMinutes: 0,
              overtimeMinutes,
              totalEligibleMinutes: overtimeMinutes,
              attendanceStatus: "complete",
            }),
      });
      toast.success(
        isExtraPunchedIn
          ? "Extra Time Ended!"
          : isHoliday
            ? "Holiday Overtime Started!"
            : "Extra Time Started!",
      );
    } catch (e) {
      toast.error("Action failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!employee)
    return <div className="p-8 text-center text-muted-foreground">No employee profile active.</div>;

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div className="rounded-xl border bg-card p-5 sm:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center justify-center gap-2">
            <Clock className="h-6 w-6 text-muted-foreground" /> Overtime & Extra Hours
          </h1>
          <p className="mt-1 text-sm text-muted-foreground font-medium">
            Log overtime hours worked outside shift{" "}
            {isHoliday
              ? "(Holiday Overtime Enabled 🎉)"
              : `(${employee.shiftStartTime || "09:00 AM"} - ${employee.shiftEndTime || "05:00 PM"})`}
            .
          </p>
        </div>

        {isHoliday && (
          <div className="flex items-center gap-2.5 rounded-lg border bg-muted/40 p-4 text-left text-xs text-foreground">
            <Clock className="h-5 w-5 text-muted-foreground shrink-0" />
            <div>
              <span className="block text-sm font-semibold text-foreground">Company holiday</span>
              It is a company holiday today! Shift hour restrictions are bypassed. Extra time can
              still be recorded separately.
            </div>
          </div>
        )}

        {onLeaveToday && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-300 text-xs font-semibold flex items-center gap-2.5 text-left shadow-xs">
            <Lock className="h-5 w-5 text-amber-600 shrink-0" />
            <div>
              <span className="font-extrabold block text-sm text-amber-900 dark:text-amber-200">
                {getLeaveLabel(activeLeave)}
              </span>
              Extra time and overtime logging are disabled while on approved leave. You can still
              view your logs below.
            </div>
          </div>
        )}

        {shiftBlocked && !onLeaveToday && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-900 dark:text-amber-300 text-xs font-semibold flex items-center gap-2.5 text-left shadow-xs">
            <ShieldAlert className="h-5 w-5 text-amber-600 shrink-0" />
            <div>
              <span className="font-extrabold block text-sm text-amber-900 dark:text-amber-200">
                Shift In Progress
              </span>
              You are currently within your regular shift hours. Extra time can only be started
              after completing your shift.
            </div>
          </div>
        )}

        <div>
          <button
            disabled={busy || onLeaveToday || shiftBlocked}
            onClick={toggleExtra}
            className={`mx-auto flex min-h-14 w-full max-w-sm flex-col items-center justify-center rounded-md px-5 py-3 text-base font-semibold text-white transition-colors ${
              isExtraPunchedIn
                ? "bg-rose-600 hover:bg-rose-700"
                : onLeaveToday || shiftBlocked
                  ? "bg-slate-400 cursor-not-allowed opacity-60"
                  : "bg-primary hover:bg-primary/90"
            }`}
          >
            <span>
              {onLeaveToday
                ? "Disabled"
                : isExtraPunchedIn
                  ? "End Extra"
                  : isHoliday
                    ? "Start Holiday Extra"
                    : "Start Extra"}
            </span>
            <span className="mt-0.5 text-xs font-normal opacity-85">
              {onLeaveToday
                ? "On Leave"
                : isExtraPunchedIn
                  ? "Overtime Active"
                  : isHoliday
                    ? "Holiday Overtime"
                    : "Outside Shift"}
            </span>
          </button>
        </div>

        <div className="text-xs text-muted-foreground font-medium">
          Extra time is recorded separately from regular shift attendance.
        </div>
      </div>

      <div className="rounded-xl border bg-card p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Today's Extra Time Logs (
          {todayExtras.length})
        </h2>
        {todayExtras.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground italic border border-dashed rounded-lg">
            No extra time logged today.
          </div>
        ) : (
          <div className="divide-y text-xs font-mono">
            {todayExtras.map((p) => (
              <div key={p.id} className="py-2.5 flex items-center justify-between">
                <span
                  className={`font-bold ${p.type === "extra_in" ? "text-emerald-600" : "text-rose-600"}`}
                >
                  {p.type === "extra_in" ? "▶ Started Extra" : "⏹ Ended Extra"}
                </span>
                <span className="text-muted-foreground font-semibold">
                  {p.timestamp ? format(p.timestamp.toDate(), "hh:mm:ss a") : "Just now"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
