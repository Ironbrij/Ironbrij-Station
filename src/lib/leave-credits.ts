import type { Employee, LeaveDayItem, LeaveRequest } from "./types.ts";

export interface LeaveCreditBalance {
  /** Paid leave days the employee is given for the year. */
  credits: number;
  /** Paid leave days taken from 1 January up to the balance date. */
  used: number;
  /** Credits left. Below zero means more paid leave was taken than credited. */
  remaining: number;
}

function nextDay(dateKey: string): string {
  const next = new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** A half day draws half a credit; a timed break is hours off, not a leave day. */
function creditWeight(leaveType: LeaveDayItem["leaveType"]): number {
  if (leaveType === "half_day") return 0.5;
  if (leaveType === "timed_break") return 0;
  return 1;
}

/**
 * The employee's paid leave balance for the calendar year that `asOf` falls in.
 *
 * Only approved paid leave up to `asOf` is counted, so re-running an old report
 * shows the balance that week had rather than today's. Credits belong to the
 * person, so leave filed under any client draws on them. Returns null when no
 * credits are set, which the report shows as blank rather than as zero left.
 */
export function computeLeaveCreditBalance(
  employee: Pick<Employee, "id" | "authUid" | "annualLeaveCredits">,
  leaves: LeaveRequest[],
  asOf: string,
  workingDays?: number[],
): LeaveCreditBalance | null {
  const credits = employee.annualLeaveCredits;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return null;

  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const counts = (date: string) =>
    date >= yearStart &&
    date <= asOf &&
    (!workingDays?.length || workingDays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()));

  // Keyed by date so two approved requests covering one day charge it once.
  const charged = new Map<string, number>();
  const charge = (date: string, weight: number) =>
    charged.set(date, Math.max(charged.get(date) || 0, weight));

  for (const leave of leaves) {
    if (leave.status !== "approved") continue;
    if (leave.employeeId !== employee.id && leave.employeeId !== employee.authUid) continue;

    if (Array.isArray(leave.dates) && leave.dates.length > 0) {
      for (const day of leave.dates) {
        if (!day.date || !counts(day.date)) continue;
        if ((day.paymentStatus || leave.paymentStatus || "paid") === "unpaid") continue;
        charge(day.date, creditWeight(day.leaveType || leave.leaveType));
      }
    } else if (leave.paymentStatus !== "unpaid" && leave.dateFrom && leave.dateTo) {
      const first = leave.dateFrom > yearStart ? leave.dateFrom : yearStart;
      const last = leave.dateTo < asOf ? leave.dateTo : asOf;
      for (let date = first; date <= last; date = nextDay(date)) {
        if (counts(date)) charge(date, creditWeight(leave.leaveType));
      }
    }
  }

  const used = [...charged.values()].reduce((sum, weight) => sum + weight, 0);
  return { credits, used, remaining: Math.round((credits - used) * 10) / 10 };
}

/** "7.5d", "10d": whole days read without a trailing ".0". */
export function formatLeaveDays(days: number): string {
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}
