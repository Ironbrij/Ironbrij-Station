import { getEmployeeShiftWindow, getShiftTimezone, zonedDateKey } from "./attendance.ts";
import { getRequiredWorkMinutes } from "./company-context.ts";
import { toMillis } from "./time.ts";
import { normalizeCompanyId } from "./company-context.ts";
import { breakDurationMs } from "./work-breaks.ts";
import type { AttendanceStatus, Company, Employee, Punch } from "./types.ts";

export const DEFAULT_PUNCH_OUT_GRACE_MINUTES = 20;
export const DEFAULT_PUNCH_OUT_REMINDER_MINUTES = 20;

export interface AttendanceCalculation {
  attendanceDate: string;
  scheduledShiftStart: Date;
  scheduledShiftEnd: Date;
  requiredWorkMinutes: number;
  actualWorkMinutes: number;
  normalWorkMinutes: number;
  overtimeMinutes: number;
  earlyStartMinutes?: number;
  totalEligibleMinutes: number;
  graceMinutes: number;
  graceApplied: boolean;
  missingPunchOut: boolean;
  status: AttendanceStatus;
}

export interface AttendanceCalculationInput {
  employee: Employee;
  company?: Company | null;
  punchIn: Date;
  punchOut?: Date | null;
  now?: Date;
  requiredWorkMinutes?: number;
  punchOutGraceMinutes?: number;
  isOffShiftDay?: boolean;
  punches?: Punch[];
}

function positiveMinutes(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! >= 0 ? Math.round(value!) : fallback;
}

export function calculateAttendanceSession({
  employee,
  company,
  punchIn,
  punchOut,
  now = new Date(),
  requiredWorkMinutes,
  punchOutGraceMinutes,
  isOffShiftDay = false,
  punches = [],
}: AttendanceCalculationInput): AttendanceCalculation {
  const timezone = getShiftTimezone(employee);
  const attendanceDate = zonedDateKey(punchIn, timezone);
  const end = punchOut || now;
  const sessionPunches = punches.filter((p) => !p.voidedAt &&
    (p.employeeId === employee.id || p.employeeId === employee.authUid) &&
    (!p.companyId || !employee.companyId || normalizeCompanyId(p.companyId) === normalizeCompanyId(employee.companyId)) &&
    toMillis(p.timestamp) >= punchIn.getTime() && toMillis(p.timestamp) <= end.getTime());
  const shift = getEmployeeShiftWindow(employee, punchIn, sessionPunches.filter((p) => p.type !== "out" && p.type !== "extra_out"), end);
  const workedMinutes = (start: Date, finish: Date) => Math.max(0, Math.floor(
    (finish.getTime() - start.getTime() - breakDurationMs(sessionPunches, start, finish)) / 60_000,
  ));
  const required = positiveMinutes(requiredWorkMinutes, getRequiredWorkMinutes(employee, company));
  const graceMinutes = positiveMinutes(
    punchOutGraceMinutes ?? company?.punchOutGraceMinutes,
    DEFAULT_PUNCH_OUT_GRACE_MINUTES,
  );

  // If working on an off-shift day, company holiday, or after scheduled shift end: all worked time is overtime
  const isPostShift = punchIn.getTime() >= shift.end.getTime();

  if (isOffShiftDay || isPostShift) {
    if (!punchOut) {
      const elapsedMinutes = workedMinutes(punchIn, now);
      return {
        attendanceDate,
        scheduledShiftStart: shift.start,
        scheduledShiftEnd: shift.end,
        requiredWorkMinutes: required,
        actualWorkMinutes: elapsedMinutes,
        normalWorkMinutes: 0,
        overtimeMinutes: elapsedMinutes,
        totalEligibleMinutes: elapsedMinutes,
        graceMinutes,
        graceApplied: false,
        missingPunchOut: false,
        status: "in_progress",
      };
    }

    const actualWorkMinutes = workedMinutes(punchIn, punchOut);
    return {
      attendanceDate,
      scheduledShiftStart: shift.start,
      scheduledShiftEnd: shift.end,
      requiredWorkMinutes: required,
      actualWorkMinutes,
      normalWorkMinutes: 0,
      overtimeMinutes: actualWorkMinutes,
      totalEligibleMinutes: actualWorkMinutes,
      graceMinutes,
      graceApplied: false,
      missingPunchOut: false,
      status: "complete",
    };
  }

  const isEarlyStart = punchIn.getTime() < shift.start.getTime();
  const earlyStartMinutes = isEarlyStart ? Math.floor((shift.start.getTime() - punchIn.getTime()) / 60000) : 0;
  const earlyWorkedMinutes = isEarlyStart
    ? workedMinutes(punchIn, new Date(Math.min(end.getTime(), shift.start.getTime()))) : 0;

  if (!punchOut) {
    const elapsedMinutes = workedMinutes(punchIn, now);
    const isBeforeShift = now.getTime() < shift.start.getTime();
    const shiftElapsedMinutes = isBeforeShift
      ? 0
      : workedMinutes(shift.start, now);
    const missingPunchOut = now.getTime() > shift.effectiveEnd.getTime();
    const normalWorkMinutes = Math.min(
      required,
      isEarlyStart ? shiftElapsedMinutes : elapsedMinutes,
    );
    const overtimeMinutes = isEarlyStart
      ? earlyWorkedMinutes + Math.max(0, shiftElapsedMinutes - required)
      : Math.max(0, elapsedMinutes - required);

    return {
      attendanceDate,
      scheduledShiftStart: shift.start,
      scheduledShiftEnd: shift.end,
      requiredWorkMinutes: required,
      actualWorkMinutes: elapsedMinutes,
      normalWorkMinutes,
      overtimeMinutes,
      earlyStartMinutes,
      totalEligibleMinutes: normalWorkMinutes + overtimeMinutes,
      graceMinutes,
      graceApplied: false,
      missingPunchOut,
      status: missingPunchOut ? "missing_punch_out" : "in_progress",
    };
  }

  const graceBoundary = new Date(shift.effectiveEnd.getTime() + graceMinutes * 60_000);
  const graceWindowStart = new Date(shift.effectiveEnd.getTime() - graceMinutes * 60_000);
  const isInsideGrace = punchOut >= graceWindowStart && punchOut <= graceBoundary;
  const normalizedOut = isInsideGrace ? shift.effectiveEnd : punchOut;
  const actualWorkMinutes = workedMinutes(punchIn, punchOut);

  // If punched in early, normal work hours start from shift.start
  const effectiveIn = isEarlyStart ? shift.start : punchIn;
  const normalizedWorkMinutes = workedMinutes(effectiveIn, normalizedOut);
  const normalWorkMinutes = Math.min(required, normalizedWorkMinutes);

  // Overtime starts after required hours or after grace boundary, plus any early start minutes
  const postShiftOvertime =
    punchOut > graceBoundary || normalizedWorkMinutes > required
      ? Math.max(
          0,
          workedMinutes(effectiveIn, punchOut) - normalWorkMinutes,
        )
      : 0;
  const overtimeMinutes = earlyWorkedMinutes + postShiftOvertime;

  return {
    attendanceDate,
    scheduledShiftStart: shift.start,
    scheduledShiftEnd: shift.end,
    requiredWorkMinutes: required,
    actualWorkMinutes,
    normalWorkMinutes,
    overtimeMinutes,
    earlyStartMinutes,
    totalEligibleMinutes: normalWorkMinutes + overtimeMinutes,
    graceMinutes,
    graceApplied: isInsideGrace,
    missingPunchOut: false,
    status: "complete",
  };
}

export function isPunchOutReminderDue({
  employee,
  punchIn,
  now = new Date(),
  reminderMinutes = DEFAULT_PUNCH_OUT_REMINDER_MINUTES,
}: {
  employee: Employee;
  punchIn: Date;
  now?: Date;
  reminderMinutes?: number;
}): boolean {
  const shift = getEmployeeShiftWindow(employee, punchIn);
  const startsAt = shift.end.getTime() - positiveMinutes(reminderMinutes, 20) * 60_000;
  return now.getTime() >= startsAt && now.getTime() < shift.end.getTime();
}

export function formatWorkMinutes(minutes: number): string {
  const safeMinutes = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const remainder = safeMinutes % 60;
  if (hours === 0) return `${remainder}m`;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}
