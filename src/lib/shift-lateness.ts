import type { Employee, Punch } from "./types.ts";
import { formatInTimezone, getShiftTimezone } from "./attendance.ts";
import { toDate } from "./time.ts";

/**
 * Every punch stores the schedule it was taken against. Reusing it keeps the
 * late log and the dashboard judging the same clock-in against the same shift,
 * so excusing or correcting a punch in one place lands in the other.
 */
export function scopeEmployeeToPunchSchedule(employee: Employee, punch?: Punch | null): Employee {
  const start = toDate(punch?.scheduledShiftStart);
  const end = toDate(punch?.scheduledShiftEnd);
  if (!start || !end) return employee;
  const timezone = punch?.shiftTimezone || getShiftTimezone(employee);
  const clockTime = (value: Date) =>
    formatInTimezone(value, timezone, { hour: "2-digit", minute: "2-digit", hour12: false });
  return {
    ...employee,
    isMultipleShift: false,
    shifts: undefined,
    shiftTimezone: timezone,
    shiftStartTime: clockTime(start),
    shiftEndTime: clockTime(end),
    requiredWorkMinutes: punch?.requiredWorkMinutes ?? employee.requiredWorkMinutes,
  };
}

/**
 * Lateness belongs to the shift, not to each clock-in inside it. Overtime and
 * off-shift work are never late, and a second clock-in after an auto punch-out
 * or a client switch only continues a shift that was already judged.
 */
export function opensRegularShift(punch: Punch): boolean {
  return punch.type === "in" && !punch.isOffShiftDay;
}

/** Identifies one employee's shift for a client, so both screens agree on it. */
export function shiftLatenessKey(companyId: string, shiftStart: Date): string {
  return `${companyId}:${shiftStart.getTime()}`;
}
