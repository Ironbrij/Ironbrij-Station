import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { COMPANY_ID, type Company, type LeaveRequest, type Punch } from "@/lib/types";
import { ymd } from "@/lib/time";
import { toast } from "sonner";
import { Clock, ShieldAlert, CheckCircle2, Lock, PartyPopper } from "lucide-react";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/app/extra")({
  head: () => ({
    meta: [
      { title: "Extra Time & Overtime — Time Station" },
      { name: "description", content: "Log overtime hours worked outside shift." },
      { property: "og:title", content: "Extra Time — Time Station" },
      { property: "og:description", content: "Log overtime hours worked outside shift." },
    ],
  }),
  component: ExtraPage,
});

function ExtraPage() {
  const { employee } = useAuth();
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [company, setCompany] = useState<Company | null>(null);
  const [busy, setBusy] = useState(false);

  const todayStr = ymd(new Date());

  useEffect(() => {
    const unsubComp = onSnapshot(doc(db(), "companies", COMPANY_ID), (s) => {
      if (s.exists()) setCompany(s.data() as Company);
    });
    return () => unsubComp();
  }, []);

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
    return company?.holidays?.includes(todayStr) ?? false;
  }, [company, todayStr]);

  const onLeaveToday = useMemo(() => {
    return leaves.some(
      (l) => l.status === "approved" && l.dateFrom <= todayStr && l.dateTo >= todayStr,
    );
  }, [leaves, todayStr]);

  // Determine latest status
  const latestPunch = useMemo(() => allPunches[allPunches.length - 1], [allPunches]);
  const isRegularPunchedIn = useMemo(() => latestPunch?.type === "in", [latestPunch]);
  const isExtraPunchedIn = useMemo(() => latestPunch?.type === "extra_in", [latestPunch]);

  // Check if currently within regular shift hours
  const isCurrentlyInShiftHours = useMemo(() => {
    if (!employee?.shiftStartTime || !employee?.shiftEndTime) return false;
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    const [sH, sM] = employee.shiftStartTime.split(":").map(Number);
    const [eH, eM] = employee.shiftEndTime.split(":").map(Number);

    const startMins = (sH || 9) * 60 + (sM || 0);
    const endMins = (eH || 17) * 60 + (eM || 0);

    return nowMins >= startMins && nowMins < endMins;
  }, [employee]);

  // Shift restriction is bypassed on holidays!
  const shiftBlocked = !isHoliday && isCurrentlyInShiftHours && !isExtraPunchedIn;

  const todayExtras = useMemo(() => {
    return allPunches.filter(
      (p) =>
        (p.type === "extra_in" || p.type === "extra_out") &&
        p.timestamp &&
        ymd(p.timestamp) === todayStr,
    );
  }, [allPunches, todayStr]);

  async function toggleExtra() {
    if (!employee) return;

    if (onLeaveToday) {
      toast.error("Overtime logging is disabled while on approved leave today.");
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
      await addDoc(collection(db(), "punches"), {
        employeeId: employee.id,
        employeeName: employee.name,
        date: todayStr,
        type: nextType,
        timestamp: serverTimestamp(),
        source: "app",
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
      <div className="rounded-xl border bg-card p-8 shadow-lift text-center space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center justify-center gap-2">
            <Clock className="h-6 w-6 text-primary" /> Overtime & Extra Hours
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
          <div className="p-4 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-900 dark:text-purple-300 text-xs font-semibold flex items-center gap-2.5 text-left shadow-xs">
            <PartyPopper className="h-5 w-5 text-purple-600 shrink-0" />
            <div>
              <span className="font-extrabold block text-sm text-purple-900 dark:text-purple-200">
                Company Holiday Overtime Mode 🎉
              </span>
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
                On Approved Leave Today
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

        <div className="py-4">
          <button
            disabled={busy || onLeaveToday || shiftBlocked}
            onClick={toggleExtra}
            className={`btn-lift h-36 w-36 rounded-full font-black text-lg text-white shadow-lift transition-all transform active:scale-95 mx-auto flex flex-col items-center justify-center ${
              isExtraPunchedIn
                ? "bg-rose-600 hover:bg-rose-700 ring-4 ring-rose-500/30"
                : onLeaveToday || shiftBlocked
                  ? "bg-slate-400 cursor-not-allowed opacity-60"
                  : "bg-emerald-600 hover:bg-emerald-700 ring-4 ring-emerald-500/30"
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
            <span className="text-[10px] uppercase tracking-wider opacity-80 font-mono mt-1">
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

      <div className="rounded-xl border bg-card p-6 shadow-lift space-y-3">
        <h2 className="text-sm font-extrabold text-primary flex items-center gap-2">
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
