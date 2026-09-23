import type { Employee, Punch, ShiftInterval } from "./types.ts";
import { formatInTimezone, getShiftTimezone } from "./attendance.ts";
import { toDate } from "./time.ts";

/** The slots an employee actually works, single or multiple. */
export function getShiftIntervals(employee?: Employee | null): ShiftInterval[] {
  if (!employee) return [];
  if (employee.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0) {
    return employee.shifts;
  }
  return [
    {
      startTime: employee.shiftStartTime || "09:00",
      endTime: employee.shiftEndTime || "17:00",
      clientName: employee.shiftClientName,
      workingDays: employee.workingDays,
    },
  ];
}

function clockTime(value: Date, timezone: string): string {
  return formatInTimezone(value, timezone, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Minutes from midnight, so an overnight slot can be compared as a wrapped range. */
function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

function covers(shift: ShiftInterval, time: string): boolean {
  const start = minutesOfDay(shift.startTime);
  const end = minutesOfDay(shift.endTime);
  const at = minutesOfDay(time);
  // An end at or before the start means the slot runs past midnight.
  return end <= start ? at >= start || at < end : at >= start && at < end;
}

/** People clock in a few minutes early; that punch still belongs to the slot. */
const EARLY_ARRIVAL_MINUTES = 120;

function minutesUntilStart(shift: ShiftInterval, time: string): number {
  return (minutesOfDay(shift.startTime) - minutesOfDay(time) + 1440) % 1440;
}

/**
 * Finds the configured slot a punch belongs to. The schedule stored on the punch
 * names its slot exactly; without one, the punch's own clock time decides.
 */
export function findShiftIntervalForPunch(
  employee: Employee,
  punch: Punch,
): ShiftInterval | undefined {
  const shifts = getShiftIntervals(employee);
  if (shifts.length === 0) return undefined;
  if (shifts.length === 1) return shifts[0];
  const timezone = punch.shiftTimezone || getShiftTimezone(employee);
  const scheduled = toDate(punch.scheduledShiftStart);
  if (scheduled) {
    const startTime = clockTime(scheduled, timezone);
    const exact = shifts.find((shift) => shift.startTime === startTime);
    if (exact) return exact;
  }
  const punchedAt = toDate(punch.timestamp);
  if (!punchedAt) return undefined;
  const time = clockTime(punchedAt, timezone);
  const running = shifts.find((shift) => covers(shift, time));
  if (running) return running;
  return shifts
    .filter((shift) => minutesUntilStart(shift, time) <= EARLY_ARRIVAL_MINUTES)
    .sort((a, b) => minutesUntilStart(a, time) - minutesUntilStart(b, time))[0];
}

/** The client a punch was worked for, when the shift slot names one. */
export function getPunchShiftClient(employee: Employee, punch: Punch): string {
  return findShiftIntervalForPunch(employee, punch)?.clientName?.trim() || "";
}

export interface PunchShiftSlot {
  shift: ShiftInterval;
  /** 1-based position in the employee's configured slots, for "Shift 2 of 3". */
  position: number;
  total: number;
  client: string;
}

/** Which of an employee's configured slots a punch was worked in. */
export function getPunchShiftSlot(employee: Employee, punch: Punch): PunchShiftSlot | null {
  const shifts = getShiftIntervals(employee);
  const shift = findShiftIntervalForPunch(employee, punch);
  if (!shift) return null;
  return {
    shift,
    position: shifts.indexOf(shift) + 1,
    total: shifts.length,
    client: shift.clientName?.trim() || "",
  };
}

/** The slot a scheduled window belongs to, for a day with no punch to match on. */
export function getShiftSlotByStart(
  employee: Employee,
  startTime: string,
): PunchShiftSlot | null {
  const shifts = getShiftIntervals(employee);
  const index = shifts.findIndex((shift) => shift.startTime === startTime);
  if (index < 0) return null;
  return {
    shift: shifts[index],
    position: index + 1,
    total: shifts.length,
    client: shifts[index].clientName?.trim() || "",
  };
}

/** Reads "Shift 2 of 3", or the slot's own name when the admin gave it one. */
export function describePunchShiftSlot(slot: PunchShiftSlot | null): string {
  if (!slot) return "";
  if (slot.shift.name?.trim()) return slot.shift.name.trim();
  return slot.total > 1 ? `Shift ${slot.position} of ${slot.total}` : "";
}

/** Reads "09:00 – 13:00 · Ironbrij" for a slot, dropping the client when unset. */
export function describeShiftInterval(shift: ShiftInterval): string {
  const range = `${shift.startTime} – ${shift.endTime}`;
  const client = shift.clientName?.trim();
  return client ? `${range} · ${client}` : range;
}
