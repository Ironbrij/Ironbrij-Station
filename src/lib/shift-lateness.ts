import type { Punch } from "./types.ts";

// The schedule a punch was made on. It lives beside computeEmployeeLateness so
// every lateness check, the live one included, can use it.
export { scopeEmployeeToPunchSchedule } from "./attendance.ts";

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
