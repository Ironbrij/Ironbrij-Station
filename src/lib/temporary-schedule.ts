import type { CompanyMembership, Employee, ShiftInterval, TemporarySchedule } from "./types.ts";
import { normalizeCompanyId } from "./company-context.ts";

/**
 * A temporary schedule, such as for daylight saving: the saved shift times of
 * some of a person's companies move by a set number of minutes, and the times
 * they had are kept so switching it off puts them back exactly.
 *
 * The saved times themselves change, so attendance, lateness and reports all
 * follow the temporary hours with nothing else to know about.
 */

type ShiftTimes = Pick<CompanyMembership, "shiftStartTime" | "shiftEndTime" | "shifts">;

/** "09:00" moved by 60 -> "10:00"; wraps past midnight. */
export function moveTime(time: string | undefined, minutes: number): string | undefined {
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) return time;
  const [hour, minute] = time.split(":").map(Number);
  const total = (((hour * 60 + minute + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function moveTimes(times: ShiftTimes, minutes: number): ShiftTimes {
  return {
    shiftStartTime: moveTime(times.shiftStartTime, minutes),
    shiftEndTime: moveTime(times.shiftEndTime, minutes),
    shifts: times.shifts?.map((shift): ShiftInterval => ({
      ...shift,
      startTime: moveTime(shift.startTime, minutes)!,
      endTime: moveTime(shift.endTime, minutes)!,
    })),
  };
}

function pickTimes(source: ShiftTimes | undefined): ShiftTimes {
  return {
    shiftStartTime: source?.shiftStartTime,
    shiftEndTime: source?.shiftEndTime,
    shifts: source?.shifts,
  };
}

/** Firestore rejects undefined; a missing value stays missing. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function memberships(employee: Employee): Record<string, CompanyMembership> {
  const saved = employee.companyMemberships;
  return saved && !Array.isArray(saved) && typeof saved === "object" ? saved : {};
}

/** The key a company's membership is saved under, if it has one. */
function membershipKey(employee: Employee, companyId: string): string | null {
  const id = normalizeCompanyId(companyId);
  for (const [key, membership] of Object.entries(memberships(employee))) {
    if (normalizeCompanyId(membership?.companyId || key) === id) return key;
  }
  return null;
}

/**
 * The profile fields that move these companies' shifts by `minutes`. The
 * profile's own times follow the primary company, as the edit form saves them.
 */
export function startTemporarySchedule(
  employee: Employee,
  companyIds: string[],
  minutes: number,
  now = new Date(),
): Partial<Employee> & { temporarySchedule: TemporarySchedule } {
  const ids = companyIds.map(normalizeCompanyId);
  const primary = normalizeCompanyId(employee.companyId);
  const nextMemberships = { ...memberships(employee) };
  const original: TemporarySchedule["original"] = { profile: {}, memberships: {} };
  for (const id of ids) {
    const key = membershipKey(employee, id);
    if (!key) continue;
    original.memberships[key] = defined(pickTimes(nextMemberships[key]));
    nextMemberships[key] = defined({
      ...nextMemberships[key],
      ...moveTimes(nextMemberships[key], minutes),
    });
  }
  const movesProfile = ids.includes(primary) || Object.keys(memberships(employee)).length === 0;
  original.profile = movesProfile ? defined(pickTimes(employee)) : {};
  return {
    ...(movesProfile ? defined(moveTimes(employee, minutes)) : {}),
    ...(Object.keys(nextMemberships).length > 0 ? { companyMemberships: nextMemberships } : {}),
    temporarySchedule: { minutes, companyIds: ids, startedAt: now.toISOString(), original },
  };
}

/** The profile fields that put the saved times back, and end the temporary schedule. */
export function endTemporarySchedule(
  employee: Employee,
): Partial<Employee> & { temporarySchedule: null } {
  const temporary = employee.temporarySchedule;
  if (!temporary) return { temporarySchedule: null };
  const nextMemberships = { ...memberships(employee) };
  for (const [key, times] of Object.entries(temporary.original.memberships)) {
    if (!nextMemberships[key]) continue;
    const { shiftStartTime: _s, shiftEndTime: _e, shifts: _x, ...rest } = nextMemberships[key];
    nextMemberships[key] = { ...rest, ...times } as CompanyMembership;
  }
  return {
    ...temporary.original.profile,
    ...(Object.keys(nextMemberships).length > 0 ? { companyMemberships: nextMemberships } : {}),
    temporarySchedule: null,
  };
}
