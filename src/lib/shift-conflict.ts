import type { Employee, ShiftInterval, CompanyMembership, Company } from "./types.ts";
import { formatWorkMinutes } from "./attendance-calculation.ts";

export interface ShiftDefinition {
  id?: string;
  name: string;
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
  workingDays: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  companyId?: string;
  companyName?: string;
}

export interface ShiftConflict {
  shift1Name: string;
  shift2Name: string;
  company1Name?: string;
  company2Name?: string;
  dayIndex: number;
  dayName: string;
  overlapMinutes: number;
  shift1TimeFormatted: string;
  shift2TimeFormatted: string;
  description: string;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return 0;
  return h * 60 + m;
}

function formatTime12h(timeStr: string): string {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return timeStr;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Checks for conflicts between two shift definitions across all days of the week.
 */
export function checkTwoShiftsConflict(s1: ShiftDefinition, s2: ShiftDefinition): ShiftConflict[] {
  const conflicts: ShiftConflict[] = [];

  const s1Days =
    Array.isArray(s1.workingDays) && s1.workingDays.length > 0
      ? s1.workingDays
      : [0, 1, 2, 3, 4, 5];
  const s2Days =
    Array.isArray(s2.workingDays) && s2.workingDays.length > 0
      ? s2.workingDays
      : [0, 1, 2, 3, 4, 5];

  const commonDays = s1Days.filter((d) => s2Days.includes(d));
  if (commonDays.length === 0) return conflicts;

  let s1Start = parseMinutes(s1.startTime);
  let s1End = parseMinutes(s1.endTime);
  if (s1End <= s1Start) s1End += 1440; // Spans midnight

  let s2Start = parseMinutes(s2.startTime);
  let s2End = parseMinutes(s2.endTime);
  if (s2End <= s2Start) s2End += 1440; // Spans midnight

  for (const day of commonDays) {
    const overlapStart = Math.max(s1Start, s2Start);
    const overlapEnd = Math.min(s1End, s2End);

    if (overlapStart < overlapEnd) {
      const overlapMinutes = overlapEnd - overlapStart;
      const dayName = DAY_NAMES[day] || `Day ${day}`;
      const shift1TimeFormatted = `${formatTime12h(s1.startTime)} – ${formatTime12h(s1.endTime)}`;
      const shift2TimeFormatted = `${formatTime12h(s2.startTime)} – ${formatTime12h(s2.endTime)}`;

      const c1 = s1.companyName ? ` [${s1.companyName}]` : "";
      const c2 = s2.companyName ? ` [${s2.companyName}]` : "";

      conflicts.push({
        shift1Name: s1.name,
        shift2Name: s2.name,
        company1Name: s1.companyName,
        company2Name: s2.companyName,
        dayIndex: day,
        dayName,
        overlapMinutes,
        shift1TimeFormatted,
        shift2TimeFormatted,
        description: `"${s1.name}"${c1} (${shift1TimeFormatted}) conflicts with "${s2.name}"${c2} (${shift2TimeFormatted}) on ${dayName} (${formatWorkMinutes(overlapMinutes)} overlap).`,
      });
    }
  }

  return conflicts;
}

/**
 * Finds all shift conflicts within a list of shifts (e.g. within an employee's multiple shifts,
 * or across multiple companies).
 */
export function findShiftConflicts(shifts: ShiftDefinition[]): ShiftConflict[] {
  const allConflicts: ShiftConflict[] = [];

  for (let i = 0; i < shifts.length; i++) {
    for (let j = i + 1; j < shifts.length; j++) {
      const pairConflicts = checkTwoShiftsConflict(shifts[i], shifts[j]);
      allConflicts.push(...pairConflicts);
    }
  }

  return allConflicts;
}

/**
 * Extracts all shift definitions configured for an employee across single shift,
 * multiple shifts, and cross-company memberships.
 */
export function getEmployeeAllShiftDefinitions(
  employee: Employee,
  companies: Company[] = [],
): ShiftDefinition[] {
  const definitions: ShiftDefinition[] = [];
  const companyMap = new Map(companies.map((c) => [c.id, c.name]));

  // 1. Primary shifts
  if (employee.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0) {
    employee.shifts.forEach((s, idx) => {
      definitions.push({
        id: s.id || `shift-${idx}`,
        name: s.name || `Shift ${idx + 1}`,
        startTime: s.startTime || "09:00",
        endTime: s.endTime || "17:00",
        workingDays:
          Array.isArray(s.workingDays) && s.workingDays.length > 0
            ? s.workingDays
            : employee.workingDays || [0, 1, 2, 3, 4, 5],
        companyId: employee.companyId,
        companyName: companyMap.get(employee.companyId || "") || "Primary Company",
      });
    });
  } else if (employee.shiftStartTime && employee.shiftEndTime) {
    definitions.push({
      id: "primary-single",
      name: "Primary Shift",
      startTime: employee.shiftStartTime,
      endTime: employee.shiftEndTime,
      workingDays: employee.workingDays || [0, 1, 2, 3, 4, 5],
      companyId: employee.companyId,
      companyName: companyMap.get(employee.companyId || "") || "Primary Company",
    });
  }

  // 2. Cross-company memberships
  if (Array.isArray(employee.companyMemberships)) {
    employee.companyMemberships.forEach((m, mIdx) => {
      const cName = companyMap.get(m.companyId) || `Company ${mIdx + 1}`;
      if (m.isMultipleShift && Array.isArray(m.shifts) && m.shifts.length > 0) {
        m.shifts.forEach((s, idx) => {
          definitions.push({
            id: `membership-${m.companyId}-${idx}`,
            name: s.name || `${cName} Shift ${idx + 1}`,
            startTime: s.startTime || "09:00",
            endTime: s.endTime || "17:00",
            workingDays:
              Array.isArray(s.workingDays) && s.workingDays.length > 0
                ? s.workingDays
                : m.workingDays || [0, 1, 2, 3, 4, 5],
            companyId: m.companyId,
            companyName: cName,
          });
        });
      } else if (m.shiftStartTime && m.shiftEndTime) {
        definitions.push({
          id: `membership-${m.companyId}`,
          name: `${cName} Shift`,
          startTime: m.shiftStartTime,
          endTime: m.shiftEndTime,
          workingDays: m.workingDays || [0, 1, 2, 3, 4, 5],
          companyId: m.companyId,
          companyName: cName,
        });
      }
    });
  }

  return definitions;
}
