import type { Employee, Punch } from "./types.ts";
import { getEmployeeShiftWindow, getShiftTimezone, zonedDateKey } from "./attendance.ts";
import { getEmployeePunchesForCompany } from "./company-context.ts";
import { toDate, toMillis } from "./time.ts";

export function planManualClockIn(employee: Employee, punches: Punch[], at: Date, now: Date, reopen: boolean) {
  if (!Number.isFinite(at.getTime()) || at.getTime() > now.getTime() + 60000) throw new Error("Clock-in cannot be in the future. Check the date and timezone.");
  const shift = getEmployeeShiftWindow(employee, at);
  const companyPunches = getEmployeePunchesForCompany(punches, employee, employee.companyId || "default");
  const sameShift = companyPunches.filter((p) => {
    const time = toDate(p.timestamp);
    return time && getEmployeeShiftWindow(employee, time).start.getTime() === shift.start.getTime();
  });
  const existing = sameShift.filter((p) => p.type === "in").sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))[0];
  const currentShift = shift.dateKey === getEmployeeShiftWindow(employee, now).dateKey;
  const closing = companyPunches.filter((p) => {
    const time = toMillis(p.timestamp);
    return (p.punchInId && p.punchInId === existing?.id) ||
      (time >= at.getTime() && time <= Math.max(shift.end.getTime(), toMillis(existing?.timestamp)));
  }).filter((p) => (p.type === "out" || p.type === "extra_out") && toMillis(p.timestamp) >= at.getTime());
  if (reopen && currentShift && closing.some((p) => !p.isAuto || (p.autoReason && !["shift_timeout", "forgot_punch_out", "switch_company"].includes(p.autoReason)))) {
    throw new Error("This shift has a manual or policy clock-out. Uncheck reopen to correct its history; use Start Work for a new session.");
  }
  return { existing, shift, dateKey: shift.dateKey || zonedDateKey(at, getShiftTimezone(employee)),
    voided: reopen && currentShift ? closing.filter((p) => p.isAuto) : [] };
}
