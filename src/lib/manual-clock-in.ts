import type { Employee, Punch } from "./types.ts";
import {
  getEmployeeShiftWindow,
  getShiftTimezone,
  zonedDateKey,
  zonedDateTimeToDate,
} from "./attendance.ts";
import { getEmployeePunchesForCompany } from "./company-context.ts";
import { scopeEmployeeToPunchSchedule } from "./shift-lateness.ts";
import { toDate, toMillis } from "./time.ts";

/** An overnight shift ends on the next calendar day, so a clock-out that reads
 *  earlier than the clock-in rolls forward instead of landing before it. */
export function resolveManualClockOut(
  dateKey: string,
  time: string,
  timezone: string,
  punchIn: Date,
): Date {
  const sameDay = zonedDateTimeToDate(dateKey, time, timezone);
  if (sameDay.getTime() > punchIn.getTime()) return sameDay;
  const next = new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return zonedDateTimeToDate(next.toISOString().slice(0, 10), time, timezone);
}

/**
 * Plans a retroactive correction of one shift's clock-in, and of its clock-out
 * when the admin supplies one. An explicit clock-out closes the shift, so it
 * corrects the session's existing out punch instead of reopening the shift.
 */
export function planManualClockIn(
  employee: Employee,
  punches: Punch[],
  at: Date,
  now: Date,
  reopen: boolean,
  out?: Date | null,
) {
  if (!Number.isFinite(at.getTime()) || at.getTime() > now.getTime() + 60000)
    throw new Error("Clock-in cannot be in the future. Check the date and timezone.");
  if (out) {
    if (!Number.isFinite(out.getTime())) throw new Error("Enter a valid clock-out time.");
    if (out.getTime() > now.getTime() + 60000)
      throw new Error("Clock-out cannot be in the future. Check the date and timezone.");
    if (out.getTime() <= at.getTime())
      throw new Error("Clock-out must come after the clock-in time.");
  }
  const shift = getEmployeeShiftWindow(employee, at);
  const companyPunches = getEmployeePunchesForCompany(
    punches,
    employee,
    employee.companyId || "default",
  );
  const sameShift = companyPunches.filter((p) => {
    const time = toDate(p.timestamp);
    if (!time) return false;
    // A punch can store an older schedule than the employee's current one. Either
    // reading placing it in this shift means the correction belongs to that punch,
    // so a fix never leaves a duplicate clock-in behind on the dashboard.
    return [employee, scopeEmployeeToPunchSchedule(employee, p)].some(
      (profile) => getEmployeeShiftWindow(profile, time).start.getTime() === shift.start.getTime(),
    );
  });
  const existing = sameShift
    .filter((p) => p.type === "in")
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))[0];
  const currentShift = shift.dateKey === getEmployeeShiftWindow(employee, now).dateKey;
  const closing = companyPunches
    .filter((p) => {
      const time = toMillis(p.timestamp);
      return (
        (p.punchInId && p.punchInId === existing?.id) ||
        (time >= at.getTime() &&
          time <= Math.max(shift.end.getTime(), toMillis(existing?.timestamp)))
      );
    })
    .filter(
      (p) => (p.type === "out" || p.type === "extra_out") && toMillis(p.timestamp) >= at.getTime(),
    );
  const reopening = reopen && !out;
  if (
    reopening &&
    currentShift &&
    closing.some(
      (p) =>
        !p.isAuto ||
        (p.autoReason &&
          !["shift_timeout", "forgot_punch_out", "switch_company"].includes(p.autoReason)),
    )
  ) {
    throw new Error(
      "This shift has a manual or policy clock-out. Uncheck reopen to correct its history, enter a clock-out time to correct it, or use Start Work for a new session.",
    );
  }
  // Correct the session's own clock-out rather than stacking a second one.
  const existingOut = out
    ? closing
        .filter((p) => p.type === "out")
        .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))[0]
    : undefined;
  return {
    existing,
    existingOut,
    shift,
    dateKey: shift.dateKey || zonedDateKey(at, getShiftTimezone(employee)),
    voided: reopening && currentShift ? closing.filter((p) => p.isAuto) : [],
  };
}
