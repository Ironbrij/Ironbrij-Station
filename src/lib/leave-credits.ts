import type { Employee, LeaveDayItem, LeaveRequest } from "./types.ts";

export interface LeaveCreditBalance {
  /** Paid leave days the employee is given for the year. */
  credits: number;
  /** Paid leave days taken from 1 January up to the balance date. */
  used: number;
  /** Credits left. Below zero means more paid leave was taken than credited. */
  remaining: number;
}

export interface LeaveCreditOptions {
  /** Days that can be charged; leave over a weekend or holiday is not leave taken. */
  isWorkingDay?: (dateKey: string) => boolean;
  /** Length of the employee's working day, used to weigh a timed break. */
  hoursPerDay?: number;
}

function nextDay(dateKey: string): string {
  const next = new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

/**
 * Hours of work one leave day takes: the whole day, half of it, or a timed
 * break's own length. The report's Paid Leave Used and the credit balance both
 * read this, so the two always agree.
 */
export function leaveDayHours(
  day: Pick<LeaveDayItem, "leaveType" | "startTime" | "endTime">,
  hoursPerDay: number,
): number {
  if (day.leaveType === "half_day") return hoursPerDay / 2;
  if (day.leaveType === "timed_break") {
    if (!day.startTime || !day.endTime) return 0;
    const minutes = (minutesOfDay(day.endTime) - minutesOfDay(day.startTime) + 1440) % 1440;
    return Math.min(hoursPerDay, minutes / 60);
  }
  return hoursPerDay;
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
  { isWorkingDay, hoursPerDay = 8 }: LeaveCreditOptions = {},
): LeaveCreditBalance | null {
  const credits = employee.annualLeaveCredits;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return null;

  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const counts = (date: string) =>
    date >= yearStart && date <= asOf && (!isWorkingDay || isWorkingDay(date));

  // Keyed by date so two approved requests covering one day charge it once.
  const charged = new Map<string, number>();
  const charge = (date: string, hours: number) =>
    charged.set(date, Math.max(charged.get(date) || 0, hours));

  for (const leave of leaves) {
    if (leave.status !== "approved") continue;
    if (leave.employeeId !== employee.id && leave.employeeId !== employee.authUid) continue;

    if (Array.isArray(leave.dates) && leave.dates.length > 0) {
      for (const day of leave.dates) {
        if (!day.date || !counts(day.date)) continue;
        if ((day.paymentStatus || leave.paymentStatus || "paid") === "unpaid") continue;
        charge(
          day.date,
          leaveDayHours(
            {
              leaveType: day.leaveType || leave.leaveType,
              startTime: day.startTime || leave.startTime,
              endTime: day.endTime || leave.endTime,
            },
            hoursPerDay,
          ),
        );
      }
    } else if (leave.paymentStatus !== "unpaid" && leave.dateFrom && leave.dateTo) {
      const first = leave.dateFrom > yearStart ? leave.dateFrom : yearStart;
      const last = leave.dateTo < asOf ? leave.dateTo : asOf;
      for (let date = first; date <= last; date = nextDay(date)) {
        if (counts(date)) charge(date, leaveDayHours(leave, hoursPerDay));
      }
    }
  }

  const usedHours = [...charged.values()].reduce((sum, hours) => sum + hours, 0);
  const used = Math.round((usedHours / hoursPerDay) * 100) / 100;
  return { credits, used, remaining: Math.round((credits - used) * 100) / 100 };
}
