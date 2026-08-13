import { getShiftTimezone, getShiftWindow, zonedDateKey } from "./attendance.ts";
import { getRequiredWorkMinutes } from "./company-context.ts";
import type { AttendanceStatus, Company, Employee } from "./types.ts";

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
}: AttendanceCalculationInput): AttendanceCalculation {
  const timezone = getShiftTimezone(employee);
  const attendanceDate = zonedDateKey(punchIn, timezone);
  const shift = getShiftWindow(
    attendanceDate,
    employee.shiftStartTime || "09:00",
    employee.shiftEndTime || "17:00",
    timezone,
  );
  const required = positiveMinutes(requiredWorkMinutes, getRequiredWorkMinutes(employee, company));
  const graceMinutes = positiveMinutes(
    punchOutGraceMinutes ?? company?.punchOutGraceMinutes,
    DEFAULT_PUNCH_OUT_GRACE_MINUTES,
  );

  if (!punchOut) {
    const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - punchIn.getTime()) / 60_000));
    const missingPunchOut = now.getTime() > shift.end.getTime();
    const normalWorkMinutes = Math.min(required, elapsedMinutes);
    return {
      attendanceDate,
      scheduledShiftStart: shift.start,
      scheduledShiftEnd: shift.end,
      requiredWorkMinutes: required,
      actualWorkMinutes: elapsedMinutes,
      normalWorkMinutes,
      overtimeMinutes: 0,
      totalEligibleMinutes: normalWorkMinutes,
      graceMinutes,
      graceApplied: false,
      missingPunchOut,
      status: missingPunchOut ? "missing_punch_out" : "in_progress",
    };
  }

  const graceBoundary = new Date(shift.end.getTime() + graceMinutes * 60_000);
  const graceWindowStart = new Date(shift.end.getTime() - graceMinutes * 60_000);
  const isInsideGrace = punchOut >= graceWindowStart && punchOut <= graceBoundary;
  const normalizedOut = isInsideGrace ? shift.end : punchOut;
  const actualWorkMinutes = Math.max(
    0,
    Math.floor((punchOut.getTime() - punchIn.getTime()) / 60_000),
  );
  const normalizedWorkMinutes = Math.max(
    0,
    Math.floor((normalizedOut.getTime() - punchIn.getTime()) / 60_000),
  );
  const normalWorkMinutes = Math.min(required, normalizedWorkMinutes);
  const overtimeMinutes =
    punchOut > graceBoundary
      ? Math.max(0, Math.floor((punchOut.getTime() - graceBoundary.getTime()) / 60_000))
      : 0;

  return {
    attendanceDate,
    scheduledShiftStart: shift.start,
    scheduledShiftEnd: shift.end,
    requiredWorkMinutes: required,
    actualWorkMinutes,
    normalWorkMinutes,
    overtimeMinutes,
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
  const timezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(punchIn, timezone);
  const shift = getShiftWindow(
    dateKey,
    employee.shiftStartTime || "09:00",
    employee.shiftEndTime || "17:00",
    timezone,
  );
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
