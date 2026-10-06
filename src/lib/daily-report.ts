import {
  addCalendarDays,
  getEffectiveEmployeeWorkingDays,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getShiftTimezone,
  getShiftWindow,
  zonedDateKey,
  zonedDateTimeToDate,
} from "./attendance.ts";
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getEmployeeLeavesForCompany,
  normalizeCompanyId,
} from "./company-context.ts";
import { getShiftIntervals } from "./shift-clients.ts";
import { readableDate } from "./weekly-report.ts";
import type { ReportRow } from "./report-rows.ts";
import type { Company, Employee, LeaveRequest } from "./types.ts";

/**
 * When a client's report for one day is ready: once every VA's shift that day
 * has ended and they have clocked out. A scheduler asks every few minutes; this
 * answers from the schedules and the live punches, so nothing is sent while
 * someone is still working and nothing waits for a fixed time of day.
 */

/** How long after a shift ends the VA has to clock out before the report counts them as not. */
export const DEFAULT_GRACE_MINUTES = 15;
/** The longest a report is held for a VA who is still clocked in or never clocked out. */
export const DEFAULT_MAX_WAIT_MINUTES = 180;
/** Past this long after it could have gone, a day's report is no longer sent by itself. */
export const EXPIRES_AFTER_MINUTES = 12 * 60;

/** "Mon 5 Oct 2026", for the report's period and the email body. */
export function reportDayLabel(date: string): string {
  return `${readableDate(date)} ${date.slice(0, 4)}`;
}

/**
 * One subject per client for every daily report, so they share a thread. The day
 * each covers is in the email.
 */
export function dailyReportSubject(clientName: string): string {
  const name = clientName.trim();
  return name ? `${name} VAs Daily Attendance Report` : "VAs Daily Attendance Report";
}

/**
 * The days a run may still send: yesterday as well as today, because a shift
 * that starts late in one day ends in the next and is reported for the day it
 * started.
 */
export function candidateReportDays(now: Date, timezone: string): string[] {
  const today = zonedDateKey(now, timezone);
  return [addCalendarDays(today, -1), today];
}

export interface PlannedShift {
  id: string;
  name: string;
  /** When their last shift of the day is due to end. */
  endsAt: Date;
}

/**
 * The VAs due to work a client's day, each with when their last shift ends.
 * Leave, holidays, days off, inactive people and anyone who has not accepted
 * their invite are left out, exactly as the report leaves them out of "absent".
 */
export function plannedShifts({
  employees,
  leaves,
  company,
  companyFilter,
  date,
}: {
  employees: Employee[];
  leaves: LeaveRequest[];
  company: Company | null;
  companyFilter: string;
  date: string;
}): PlannedShift[] {
  const companyId = companyFilter === "all" ? null : normalizeCompanyId(companyFilter);
  const calendar = companyFilter === "all" && company ? { ...company, id: "all" } : company;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const planned: PlannedShift[] = [];
  for (const raw of employees) {
    if (raw.status === "inactive" || raw.inviteStatus !== "accepted") continue;
    if (companyId && !getEmployeeCompanyIds(raw).includes(companyId)) continue;
    const employee = companyFilter === "all" ? raw : getEmployeeForCompany(raw, companyFilter);
    const approved = getEmployeeLeavesForCompany(leaves, raw, companyFilter).filter(
      (leave) => leave.status === "approved",
    );
    if (getEmployeeApprovedLeaveForDate(employee, approved, date)) continue;
    if (getEmployeeHoliday(calendar, employee, date)) continue;
    if (!getEffectiveEmployeeWorkingDays(employee, company?.workingDays).includes(weekday))
      continue;
    const timezone = getShiftTimezone(employee);
    const ends = getShiftIntervals(employee)
      .filter(
        (slot) =>
          !Array.isArray(slot.workingDays) ||
          slot.workingDays.length === 0 ||
          slot.workingDays.map(Number).includes(weekday),
      )
      .map((slot) => getShiftWindow(date, slot.startTime, slot.endTime, timezone).end.getTime());
    if (ends.length === 0) continue;
    planned.push({
      id: employee.id,
      name: employee.name?.trim() || employee.email,
      endsAt: new Date(Math.max(...ends)),
    });
  }
  return planned;
}

export interface DayTiming {
  /** When the last planned shift ends; null when nobody is planned. */
  lastShiftEnd: Date | null;
  /** From here nobody is still on shift, so the report can be judged. */
  settledAt: Date;
  /** The report goes out at this time whatever is still open. */
  sendAnywayAt: Date;
  /** After this the day is too old for a run to send by itself. */
  expiresAt: Date;
}

const minutes = (value: number) => value * 60_000;

export function dayTiming({
  planned,
  date,
  timezone,
  graceMinutes = DEFAULT_GRACE_MINUTES,
  maxWaitMinutes = DEFAULT_MAX_WAIT_MINUTES,
}: {
  planned: PlannedShift[];
  date: string;
  timezone: string;
  graceMinutes?: number;
  maxWaitMinutes?: number;
}): DayTiming {
  const lastShiftEnd = planned.length
    ? new Date(Math.max(...planned.map((shift) => shift.endsAt.getTime())))
    : null;
  // A day with nobody planned is judged from the end of the day itself.
  const anchor = lastShiftEnd ?? zonedDateTimeToDate(addCalendarDays(date, 1), "00:00", timezone);
  const settledAt = new Date(anchor.getTime() + minutes(graceMinutes));
  const sendAnywayAt = new Date(anchor.getTime() + minutes(maxWaitMinutes));
  return {
    lastShiftEnd,
    settledAt,
    sendAnywayAt,
    expiresAt: new Date(sendAnywayAt.getTime() + minutes(EXPIRES_AFTER_MINUTES)),
  };
}

export interface Waiting {
  name: string;
  reason: "shift not finished" | "still clocked in" | "no clock-out yet";
}

export interface DayReadiness {
  ready: boolean;
  /** Sent only because the longest wait passed, with these people still open. */
  forced: boolean;
  waitingFor: Waiting[];
  timing: DayTiming;
}

/**
 * Whether the day's report can go now. Someone is waited for while their shift
 * is still running, while they are clocked in, or while a shift that ended has
 * no clock-out. `rows` are the day's report rows; those who never started have
 * none, which is why the planned shifts are checked as well.
 */
export function dayReadiness({
  planned,
  rows,
  date,
  timezone,
  now,
  graceMinutes = DEFAULT_GRACE_MINUTES,
  maxWaitMinutes = DEFAULT_MAX_WAIT_MINUTES,
}: {
  planned: PlannedShift[];
  rows: ReportRow[];
  date: string;
  timezone: string;
  now: Date;
  graceMinutes?: number;
  maxWaitMinutes?: number;
}): DayReadiness {
  const timing = dayTiming({ planned, date, timezone, graceMinutes, maxWaitMinutes });
  const waiting = new Map<string, Waiting>();

  for (const shift of planned) {
    if (now.getTime() < shift.endsAt.getTime() + minutes(graceMinutes)) {
      waiting.set(shift.id, { name: shift.name, reason: "shift not finished" });
    }
  }
  for (const row of rows) {
    const day = row.dailyIntervals.find((interval) => interval.date === date);
    if (!day) continue;
    const key = row.employeeId || row.employeeName;
    const clockedIn = (day.sessions ?? []).some((session) => session.type === "In Progress");
    if (clockedIn) waiting.set(key, { name: row.employeeName, reason: "still clocked in" });
    else if (day.isMissingPunchOut && !waiting.has(key)) {
      waiting.set(key, { name: row.employeeName, reason: "no clock-out yet" });
    }
  }

  const waitingFor = [...waiting.values()];
  const forced = waitingFor.length > 0 && now.getTime() >= timing.sendAnywayAt.getTime();
  return { ready: waitingFor.length === 0 || forced, forced, waitingFor, timing };
}

/** Whether a report is worth sending: someone worked, or was due and did not turn up. */
export function hasAttendanceToReport(rows: ReportRow[]): boolean {
  return rows.some((row) => row.workedDays > 0 || row.absentDays > 0);
}
