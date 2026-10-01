import { normalizeCompanyId } from "./company-context.ts";
import type { DstDecision, DstResponseLine } from "./dst-response.ts";
import { memberships, membershipKey } from "./temporary-schedule.ts";
import type { CompanyMembership, Employee } from "./types.ts";

/**
 * Puts a client's daylight saving choice into SavyTime by re-saving the VA's
 * shift for that client on the chosen clock, at the times it has now:
 *
 * - follow: on the client's clock (8:00 AM – 2:00 PM Sydney time), so the shift
 *   moves with the client's clocks at this change and every one after;
 * - keep: on the VA's own clock (3:45 AM – 9:45 AM NPT), so it never moves.
 *
 * The hours are the same until the clocks change, so this can be done as soon
 * as the client answers, with nothing to schedule for the day itself.
 */

type ShiftFields = Pick<
  CompanyMembership,
  "shiftTimezone" | "shiftStartTime" | "shiftEndTime" | "shifts" | "isMultipleShift"
>;

/** The clock and times a choice puts the shift on, or null when the record lacks them. */
export function chosenClock(
  lines: DstResponseLine[],
  clientTimezone: string,
  decision: DstDecision,
): { timezone: string; times: Map<number, { start: string; end: string }> } | null {
  const timezone = decision === "follow" ? clientTimezone : lines[0]?.vaTimezone;
  if (!timezone) return null;
  const times = new Map<number, { start: string; end: string }>();
  for (const line of lines) {
    const start = decision === "follow" ? line.clientStart : line.vaStart;
    const end = decision === "follow" ? line.clientEnd : line.vaEnd;
    if (!start || !end) return null;
    times.set(line.shiftIndex ?? 0, { start, end });
  }
  return { timezone, times };
}

/** One set of shift fields moved onto the chosen clock. */
function onClock(
  fields: ShiftFields,
  clock: NonNullable<ReturnType<typeof chosenClock>>,
): ShiftFields {
  const first = clock.times.get(0) ?? [...clock.times.values()][0];
  return fields.isMultipleShift && fields.shifts?.length
    ? {
        shiftTimezone: clock.timezone,
        shifts: fields.shifts.map((shift, index) => {
          const times = clock.times.get(index);
          return times ? { ...shift, startTime: times.start, endTime: times.end } : shift;
        }),
      }
    : { shiftTimezone: clock.timezone, shiftStartTime: first.start, shiftEndTime: first.end };
}

function sameShift(a: ShiftFields, b: ShiftFields): boolean {
  return (
    a.shiftTimezone === b.shiftTimezone &&
    (b.shiftStartTime === undefined || a.shiftStartTime === b.shiftStartTime) &&
    (b.shiftEndTime === undefined || a.shiftEndTime === b.shiftEndTime) &&
    (b.shifts === undefined || JSON.stringify(a.shifts) === JSON.stringify(b.shifts))
  );
}

/**
 * The profile fields that put one VA's shift for one client on the chosen
 * clock, or null when nothing needs to change or the choice lacks the times.
 */
export function chosenClockUpdate(
  employee: Employee,
  companyId: string,
  lines: DstResponseLine[],
  clientTimezone: string,
  decision: DstDecision,
): Partial<Employee> | null {
  const clock = chosenClock(lines, clientTimezone, decision);
  if (!clock) return null;
  const key = membershipKey(employee, companyId);
  const isPrimary =
    normalizeCompanyId(employee.companyId) === normalizeCompanyId(companyId) || !key;
  const update: Partial<Employee> = {};

  if (key) {
    const saved = memberships(employee)[key];
    // A membership without its own times uses the profile's, as the app reads it.
    const current: ShiftFields = {
      shiftTimezone: saved.shiftTimezone || employee.shiftTimezone,
      shiftStartTime: saved.shiftStartTime || employee.shiftStartTime,
      shiftEndTime: saved.shiftEndTime || employee.shiftEndTime,
      shifts: saved.shifts,
      isMultipleShift: saved.isMultipleShift,
    };
    const next = onClock(current, clock);
    if (!sameShift(current, next)) {
      update.companyMemberships = { ...memberships(employee), [key]: { ...saved, ...next } };
    }
  }
  if (isPrimary) {
    // The profile's own times mirror the primary company, as the edit form saves them.
    const current: ShiftFields = {
      shiftTimezone: employee.shiftTimezone,
      shiftStartTime: employee.shiftStartTime,
      shiftEndTime: employee.shiftEndTime,
      shifts: employee.shifts,
      isMultipleShift: employee.isMultipleShift,
    };
    const next = onClock(current, clock);
    if (!sameShift(current, next)) Object.assign(update, next);
  }
  return Object.keys(update).length > 0 ? update : null;
}

/** The lines of a choice that SavyTime would not give by itself, grouped by VA. */
export function linesToApply(
  lines: DstResponseLine[],
  decision: DstDecision,
): Map<string, DstResponseLine[]> {
  const byVa = new Map<string, DstResponseLine[]>();
  for (const line of lines) {
    if ((line.automatic ?? "follow") === decision) continue;
    byVa.set(line.id, [...(byVa.get(line.id) ?? []), line]);
  }
  return byVa;
}
