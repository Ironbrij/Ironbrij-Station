import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { addDoc, collection, onSnapshot, query, serverTimestamp, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { LeaveRequest } from "@/lib/types";
import { toast } from "sonner";
import { CalendarDays, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/app/leave")({
  head: () => ({
    meta: [
      { title: "Leave — Time Station" },
      { name: "description", content: "Request leave and view history." },
      { property: "og:title", content: "Leave — Time Station" },
      { property: "og:description", content: "Request leave and view history." },
    ],
  }),
  component: LeavePage,
});

function LeavePage() {
  const { employee, user } = useAuth();
  const [leaveType, setLeaveType] = useState<NonNullable<LeaveRequest["leaveType"]>>("full_day");
  const [halfDayPeriod, setHalfDayPeriod] =
    useState<NonNullable<LeaveRequest["halfDayPeriod"]>>("first_half");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<LeaveRequest[]>([]);

  useEffect(() => {
    if (!employee) return;
    const employeeIds = [...new Set([employee.id, employee.authUid].filter(Boolean))] as string[];
    const q = query(
      collection(db(), "leaveRequests"),
      employeeIds.length > 1
        ? where("employeeId", "in", employeeIds)
        : where("employeeId", "==", employee.id),
    );
    return onSnapshot(q, (snap) => {
      setHistory(
        snap.docs
          .map((d) => ({ id: d.id, ...(d.data() as Omit<LeaveRequest, "id">) }))
          .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)),
      );
    });
  }, [employee]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!employee) return;
    setBusy(true);
    try {
      if (leaveType === "timed_break" && (!startTime || !endTime || startTime >= endTime)) {
        toast.error("Choose a valid break start and end time.");
        setBusy(false);
        return;
      }
      const finalDateTo = leaveType === "full_day" ? dateTo || dateFrom : dateFrom;
      const leaveRef = await addDoc(collection(db(), "leaveRequests"), {
        employeeId: employee.id,
        leaveType,
        ...(leaveType === "half_day" ? { halfDayPeriod } : {}),
        ...(leaveType === "timed_break" ? { startTime, endTime } : {}),
        dateFrom,
        dateTo: finalDateTo,
        reason,
        status: "pending",
        createdAt: serverTimestamp(),
      });
      toast.success("Leave request submitted");
      try {
        const idToken = await user?.getIdToken();
        if (idToken) {
          const notificationResponse = await fetch("/api/leave-notification", {
            method: "POST",
            headers: {
              authorization: `Bearer ${idToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              leaveRequestId: leaveRef.id,
              employeeId: employee.id,
              employeeName: employee.name,
              employeeEmail: employee.email,
              dateFrom,
              dateTo: finalDateTo,
              leaveType,
              halfDayPeriod: leaveType === "half_day" ? halfDayPeriod : undefined,
              startTime: leaveType === "timed_break" ? startTime : undefined,
              endTime: leaveType === "timed_break" ? endTime : undefined,
              reason,
            }),
          });
          if (!notificationResponse.ok) {
            toast.info("Request saved. Manager email automation is not configured yet.");
          }
        }
      } catch {
        toast.info("Request saved. Manager email could not be sent.");
      }
      setDateFrom("");
      setDateTo("");
      setReason("");
      setStartTime("");
      setEndTime("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!employee) return <div>No employee profile.</div>;

  return (
    <div className="max-w-2xl mx-auto grid gap-6">
      <form onSubmit={submit} className="rounded-xl border bg-card p-6 shadow-lift">
        <h1 className="text-xl font-semibold text-primary">Request Leave</h1>
        <div className="mt-4">
          <label className="text-sm font-medium">Request type</label>
          <select
            value={leaveType}
            onChange={(event) =>
              setLeaveType(event.target.value as NonNullable<LeaveRequest["leaveType"]>)
            }
            className="mt-1 w-full rounded-md border px-3 py-2 bg-background"
          >
            <option value="full_day">Full-day leave</option>
            <option value="half_day">Half-day leave</option>
            <option value="timed_break">Break at a specific time</option>
          </select>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">From</label>
            <input
              type="date"
              required
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 w-full rounded-md border px-3 py-2"
            />
          </div>
          {leaveType === "full_day" && (
            <div>
              <label className="text-sm font-medium">To (optional)</label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="mt-1 w-full rounded-md border px-3 py-2"
              />
            </div>
          )}
        </div>
        {leaveType === "half_day" && (
          <div className="mt-3">
            <label className="text-sm font-medium">Which half?</label>
            <select
              value={halfDayPeriod}
              onChange={(event) =>
                setHalfDayPeriod(event.target.value as NonNullable<LeaveRequest["halfDayPeriod"]>)
              }
              className="mt-1 w-full rounded-md border px-3 py-2 bg-background"
            >
              <option value="first_half">First half of shift</option>
              <option value="second_half">Second half of shift</option>
            </select>
          </div>
        )}
        {leaveType === "timed_break" && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Break starts</label>
              <input
                type="time"
                required
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className="mt-1 w-full rounded-md border px-3 py-2"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Break ends</label>
              <input
                type="time"
                required
                value={endTime}
                onChange={(event) => setEndTime(event.target.value)}
                className="mt-1 w-full rounded-md border px-3 py-2"
              />
            </div>
          </div>
        )}
        <div className="mt-3">
          <label className="text-sm font-medium">Reason</label>
          <textarea
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2 min-h-[80px]"
          />
        </div>
        <button
          disabled={busy}
          className="btn-lift mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          {busy ? "Submitting…" : "Submit request"}
        </button>
      </form>

      <div className="rounded-xl border bg-card p-6 shadow-lift">
        <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-semibold text-primary">Recent Leave Activity</h2>
            <p className="text-xs text-muted-foreground">
              Follow every request from submission to the final decision.
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-[10px] font-bold">
            <ActivityCount
              label="Pending"
              count={history.filter((item) => item.status === "pending").length}
              tone="amber"
            />
            <ActivityCount
              label="Approved"
              count={history.filter((item) => item.status === "approved").length}
              tone="emerald"
            />
            <ActivityCount
              label="Rejected"
              count={history.filter((item) => item.status === "rejected").length}
              tone="rose"
            />
          </div>
        </div>
        <ul className="mt-2 divide-y">
          {history.length === 0 && (
            <li className="py-8 text-center text-sm text-muted-foreground">
              No leave activity yet.
            </li>
          )}
          {history.map((leave) => (
            <li key={leave.id} className="flex items-start gap-3 py-4">
              <StatusIcon status={leave.status} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5 text-sm font-bold">
                      <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                      {leave.dateFrom}
                      {leave.dateFrom !== leave.dateTo ? ` → ${leave.dateTo}` : ""}
                    </div>
                    <div className="mt-1 text-xs font-semibold text-primary">
                      {!leave.leaveType || leave.leaveType === "full_day"
                        ? "Full-day leave"
                        : leave.leaveType === "half_day"
                          ? `Half-day · ${leave.halfDayPeriod === "second_half" ? "second half" : "first half"}`
                          : `Scheduled break · ${leave.startTime}–${leave.endTime}`}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{leave.reason}</div>
                  </div>
                  <StatusBadge status={leave.status} />
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>
                    Submitted{" "}
                    {leave.createdAt?.toDate
                      ? format(leave.createdAt.toDate(), "MMM d, yyyy · h:mm a")
                      : "just now"}
                  </span>
                  {leave.decidedAt && (
                    <span>
                      {leave.status === "approved"
                        ? "Approved"
                        : leave.decisionSource === "automatic"
                          ? "Rejected automatically"
                          : "Rejected"}{" "}
                      {format(new Date(leave.decidedAt), "MMM d, yyyy · h:mm a")}
                      {leave.decidedBy ? ` by ${leave.decidedBy}` : ""}
                    </span>
                  )}
                  {leave.decisionSource === "automatic" && leave.decisionReason && (
                    <span>{leave.decisionReason}</span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: LeaveRequest["status"] }) {
  const style = {
    pending: "bg-amber-500/10 text-amber-700",
    approved: "bg-emerald-500/10 text-emerald-700",
    rejected: "bg-rose-500/10 text-rose-700",
  }[status];
  const Icon = status === "approved" ? CheckCircle2 : status === "rejected" ? XCircle : Clock3;
  return (
    <span className={`mt-0.5 rounded-full p-2 ${style}`}>
      <Icon className="h-4 w-4" />
    </span>
  );
}

function ActivityCount({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: "amber" | "emerald" | "rose";
}) {
  const style = {
    amber: "border-amber-500/20 bg-amber-500/10 text-amber-700",
    emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700",
    rose: "border-rose-500/20 bg-rose-500/10 text-rose-700",
  }[tone];
  return (
    <span className={`rounded-full border px-2.5 py-1 ${style}`}>
      {count} {label}
    </span>
  );
}

function StatusBadge({ status }: { status: LeaveRequest["status"] }) {
  const map = {
    pending: { bg: "var(--sky-soft)", fg: "var(--primary)", label: "Pending" },
    approved: {
      bg: "color-mix(in oklab, var(--status-in) 20%, white)",
      fg: "var(--status-in)",
      label: "Approved",
    },
    rejected: {
      bg: "color-mix(in oklab, var(--status-out) 20%, white)",
      fg: "var(--status-out)",
      label: "Rejected",
    },
  }[status];
  return (
    <span
      className="rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: map.bg, color: map.fg }}
    >
      {map.label}
    </span>
  );
}
