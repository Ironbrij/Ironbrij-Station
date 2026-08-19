import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import { companyEmailBranding } from "@/lib/email-branding";
import type { LeaveRequest } from "@/lib/types";
import { toast } from "sonner";
import { CalendarDays, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { format } from "date-fns";
import { toDate, toMillis } from "@/lib/time";

export const Route = createFileRoute("/_authenticated/app/leave")({
  head: () => ({
    meta: [
      { title: "Leave — SavyTimes" },
      { name: "description", content: "Request leave and view history." },
      { property: "og:title", content: "Leave — SavyTimes" },
      { property: "og:description", content: "Request leave and view history." },
    ],
  }),
  component: LeavePage,
});

function LeavePage() {
  const { employee, user, company, activeCompanyId } = useAuth();
  const [leaveType, setLeaveType] = useState<NonNullable<LeaveRequest["leaveType"]>>("full_day");
  const [leaveCategory, setLeaveCategory] =
    useState<NonNullable<LeaveRequest["leaveCategory"]>>("annual");
  const [paymentStatus, setPaymentStatus] =
    useState<NonNullable<LeaveRequest["paymentStatus"]>>("paid");
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
          .filter(
            (leave) =>
              (leave.companyId || employee.companyIds?.[0] || employee.companyId) ===
              activeCompanyId,
          )
          .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)),
      );
    });
  }, [activeCompanyId, employee]);

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
        companyId: activeCompanyId,
        leaveType,
        leaveCategory,
        paymentStatus,
        ...(leaveType === "half_day" ? { halfDayPeriod } : {}),
        ...(leaveType === "timed_break" ? { startTime, endTime } : {}),
        dateFrom,
        dateTo: finalDateTo,
        reason,
        remarks: reason,
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
              company: companyEmailBranding(company, employee.companyId),
              leaveRequestId: leaveRef.id,
              employeeId: employee.id,
              employeeName: employee.name,
              employeeEmail: employee.email,
              companyId: activeCompanyId,
              dateFrom,
              dateTo: finalDateTo,
              leaveType,
              leaveCategory,
              paymentStatus,
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

  async function cancelLeaveRequest(id: string) {
    if (!window.confirm("Are you sure you want to cancel this leave request?")) return;
    try {
      await updateDoc(doc(db(), "leaveRequests", id), {
        status: "rejected",
        decidedAt: new Date().toISOString(),
        decidedBy: employee?.name || user?.email || "Employee",
        decisionReason: "Cancelled by employee",
      });
      toast.success("Leave request cancelled.");
    } catch (err) {
      toast.error("Could not cancel leave: " + (err as Error).message);
    }
  }

  const counts = {
    pending: history.filter((i) => i.status === "pending").length,
    approved: history.filter((i) => i.status === "approved").length,
    rejected: history.filter((i) => i.status === "rejected").length,
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Leave management</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Submit new leave requests or review your application history.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={submit} className="rounded-xl border bg-card p-5 space-y-4 shadow-lift">
          <h2 className="font-semibold text-foreground border-b pb-2">Request leave</h2>

          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
              Leave Type
            </label>
            <select
              value={leaveType}
              onChange={(e) =>
                setLeaveType(e.target.value as NonNullable<LeaveRequest["leaveType"]>)
              }
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
            >
              <option value="full_day">Full Day Leave</option>
              <option value="half_day">Half Day Leave</option>
              <option value="timed_break">Timed Break / Short Leave</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
                Leave category
              </label>
              <select
                value={leaveCategory}
                onChange={(event) =>
                  setLeaveCategory(event.target.value as NonNullable<LeaveRequest["leaveCategory"]>)
                }
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
              >
                <option value="annual">Annual leave</option>
                <option value="sick">Sick leave</option>
                <option value="personal">Personal leave</option>
                <option value="other">Other leave</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
                Payment
              </label>
              <select
                value={paymentStatus}
                onChange={(event) =>
                  setPaymentStatus(event.target.value as NonNullable<LeaveRequest["paymentStatus"]>)
                }
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
              >
                <option value="paid">Paid leave</option>
                <option value="unpaid">Unpaid leave</option>
              </select>
            </div>
          </div>

          {leaveType === "half_day" && (
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
                Half Day Period
              </label>
              <select
                value={halfDayPeriod}
                onChange={(e) =>
                  setHalfDayPeriod(e.target.value as NonNullable<LeaveRequest["halfDayPeriod"]>)
                }
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
              >
                <option value="first_half">First Half (Morning)</option>
                <option value="second_half">Second Half (Afternoon)</option>
              </select>
            </div>
          )}

          {leaveType === "timed_break" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
                  Start Time
                </label>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
                  End Time
                </label>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
                  required
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
                From Date
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
                To Date
              </label>
              <input
                type="date"
                value={dateTo}
                disabled={leaveType !== "full_day"}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium disabled:opacity-50"
                required={leaveType === "full_day"}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-muted-foreground uppercase mb-1">
              Reason / Notes
            </label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="State reason for leave..."
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm font-medium"
              required
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full py-2.5 rounded-lg bg-primary font-bold text-sm text-primary-foreground shadow-md transition-all btn-lift"
          >
            {busy ? "Submitting..." : "Submit Leave Application"}
          </button>
        </form>

        <div className="rounded-xl border bg-card p-5 space-y-4 shadow-lift">
          <div className="flex items-center justify-between border-b pb-2">
            <h2 className="font-semibold text-foreground">Leave history</h2>
            <div className="flex gap-2 text-xs">
              <ActivityCount label="Pending" count={counts.pending} tone="amber" />
              <ActivityCount label="Approved" count={counts.approved} tone="emerald" />
            </div>
          </div>

          <ul className="divide-y max-h-[500px] overflow-y-auto pr-1">
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
                      <div className="mt-1 text-[11px] font-semibold text-muted-foreground">
                        {(leave.leaveCategory || "other").replace("_", " ")} ·{" "}
                        {leave.paymentStatus === "unpaid"
                          ? "Unpaid"
                          : leave.paymentStatus === "paid"
                            ? "Paid"
                            : "Not classified"}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{leave.reason}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={leave.status} />
                      {(leave.status === "pending" || leave.status === "approved") && (
                        <button
                          type="button"
                          onClick={() => cancelLeaveRequest(leave.id)}
                          className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-bold text-rose-700 hover:bg-rose-100"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>
                      Submitted{" "}
                      {toDate(leave.createdAt)
                        ? format(toDate(leave.createdAt)!, "MMM d, yyyy · h:mm a")
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
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
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
