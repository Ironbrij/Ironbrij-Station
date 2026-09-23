import type { Company, Employee } from "./types.ts";
import { getEmployeeAllShiftDefinitions, type ShiftDefinition } from "./shift-conflict.ts";
import { getShiftTimezone, formatInTimezone, zonedDateKey } from "./attendance.ts";
import { normalizeCompanyId } from "./company-context.ts";

/** People clock in a little before their shift, so it is theirs already. */
export const SHIFT_LEAD_IN_MINUTES = 30;

function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

/** Minutes from `at` forward to the slot's start, wrapped over midnight. */
function minutesUntil(startTime: string, at: number): number {
  return (minutesOfDay(startTime) - at + 1440) % 1440;
}

function runs(shift: ShiftDefinition, at: number): boolean {
  const start = minutesOfDay(shift.startTime);
  const end = minutesOfDay(shift.endTime);
  // An end at or before the start means the slot runs past midnight.
  return end <= start ? at >= start || at < end : at >= start && at < end;
}

function worksToday(shift: ShiftDefinition, weekday: number, at: number): boolean {
  const days = shift.workingDays?.length ? shift.workingDays.map(Number) : [0, 1, 2, 3, 4, 5];
  const start = minutesOfDay(shift.startTime);
  const end = minutesOfDay(shift.endTime);
  // An overnight slot that began yesterday is still yesterday's scheduled day.
  const startedYesterday = end <= start && at < end;
  return days.includes(startedYesterday ? (weekday + 6) % 7 : weekday);
}

export interface ScheduledCompany {
  companyId: string;
  companyName: string;
  shift: ShiftDefinition;
  /** True while the shift is running; false when it is only about to start. */
  running: boolean;
}

/**
 * The client whose shift an employee is due on right now. A VA working several
 * clients has to be punched in against the right one, and asking them to switch
 * by hand is how attendance lands on the wrong company.
 */
export function resolveScheduledCompany(
  employee: Employee | null | undefined,
  companies: Company[],
  now: Date,
  leadInMinutes = SHIFT_LEAD_IN_MINUTES,
): ScheduledCompany | null {
  if (!employee) return null;
  const timezone = getShiftTimezone(employee);
  const at = minutesOfDay(
    formatInTimezone(now, timezone, { hour: "2-digit", minute: "2-digit", hour12: false }),
  );
  const weekday = new Date(`${zonedDateKey(now, timezone)}T12:00:00Z`).getUTCDay();
  const definitions = getEmployeeAllShiftDefinitions(employee, companies).filter(
    (shift) => shift.companyId && worksToday(shift, weekday, at),
  );
  if (definitions.length === 0) return null;

  const describe = (shift: ShiftDefinition, running: boolean): ScheduledCompany => ({
    companyId: normalizeCompanyId(shift.companyId),
    companyName: shift.companyName || shift.name,
    shift,
    running,
  });

  const running = definitions.filter((shift) => runs(shift, at));
  if (running.length > 0) {
    // Overlapping schedules are a configuration problem; the latest start wins
    // so a handover moves the employee onto the shift they just began.
    const latest = running.sort(
      (a, b) => minutesUntil(b.startTime, at) - minutesUntil(a.startTime, at),
    )[0];
    return describe(latest, true);
  }

  const upcoming = definitions
    .filter((shift) => minutesUntil(shift.startTime, at) <= leadInMinutes)
    .sort((a, b) => minutesUntil(a.startTime, at) - minutesUntil(b.startTime, at))[0];
  return upcoming ? describe(upcoming, false) : null;
}
