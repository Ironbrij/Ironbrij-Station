/**
 * One employee's punches as work sessions, with the figures every screen shows.
 *
 * The dashboard, the report and its daily view used to work these out three
 * different ways: the report took one span from a day's first clock-in to its
 * last clock-out, so time between two sessions counted as work, punched breaks
 * were never taken off, a clock-out nobody made was counted up to the moment
 * the report was opened, and lateness was judged against today's schedule
 * rather than the one the punch was made under. The dashboard was right; now
 * the report reads the same sessions.
 */

import type { Company, Employee, Punch } from "./types.ts";
import { getEmployeeForCompany, getPunchCompanyId, normalizeCompanyId } from "./company-context.ts";
import {
  computeEmployeeLateness,
  getActiveWorkingSession,
  getEmployeeShiftWindow,
  getShiftTimezone,
} from "./attendance.ts";
import {
  calculateAttendanceSession,
  type AttendanceCalculation,
} from "./attendance-calculation.ts";
import {
  opensRegularShift,
  scopeEmployeeToPunchSchedule,
  shiftLatenessKey,
} from "./shift-lateness.ts";
import { breakDurationMs } from "./work-breaks.ts";
import { toDate, toMillis } from "./time.ts";

export interface AttendanceSession {
  /** The id of the punch that started it. */
  id: string;
  companyId: string;
  company?: Company;
  start: Punch;
  end?: Punch;
  /** When work started at another company without this session being ended. */
  switchedAt?: Date;
  punches: Punch[];
  /** The employee as scheduled for this session's company. */
  base: Employee;
  /** The same, on the schedule saved with the punch that started it. */
  scoped: Employee;
  timezone: string;
  startedAt: Date;
  endedAt: Date | null;
  shift: ReturnType<typeof getEmployeeShiftWindow>;
  attendanceDate: string;
  /** Still running now. */
  active: boolean;
  /** Running and on a break right now. */
  onBreak: boolean;
  /** No clock-out record and not running: an admin has to fix it. */
  unresolved: boolean;
  calc: AttendanceCalculation;
  /** Punched break time inside the session, in minutes. */
  breakMinutes: number;
  /**
   * Lateness belongs to the shift, not to each clock-in inside it, so only the
   * session that opened its shift carries it.
   */
  lateness: { minutes: number; excused: boolean; reason: string } | null;
}

interface OpenSession {
  start: Punch;
  end?: Punch;
  switchedAt?: Date;
  punches: Punch[];
}

/**
 * `punches` are one person's punches (both of their ids), without voided ones,
 * oldest first, over whatever window the caller needs.
 */
export function buildAttendanceSessions({
  employee,
  punches,
  companies,
  now,
}: {
  employee: Employee;
  punches: Punch[];
  companies: Company[];
  now: Date;
}): AttendanceSession[] {
  const live = getActiveWorkingSession(punches, employee, now, companies);
  const sessions: OpenSession[] = [];
  const open = new Map<string, OpenSession>();
  const byStart = new Map<string, OpenSession>();
  const lastByCompany = new Map<string, OpenSession>();
  for (const punch of punches) {
    const cid = getPunchCompanyId(punch, employee, companies);
    if (punch.type === "in" || punch.type === "extra_in") {
      const previous = open.get(cid);
      // Repeated clicks during the same session must not duplicate work hours.
      if (previous) {
        const scoped = getEmployeeForCompany(employee, cid);
        const previousShift =
          previous.start.scheduledShiftStart ||
          getEmployeeShiftWindow(scoped, toDate(previous.start.timestamp)!).start.toISOString();
        const nextShift =
          punch.scheduledShiftStart ||
          getEmployeeShiftWindow(scoped, toDate(punch.timestamp)!).start.toISOString();
        if (previousShift === nextShift && previous.start.type === punch.type) continue;
      }
      for (const [otherId, other] of open) {
        if (otherId !== cid) {
          other.switchedAt = toDate(punch.timestamp) || undefined;
          open.delete(otherId);
        }
      }
      const session: OpenSession = { start: punch, punches: [punch] };
      sessions.push(session);
      open.set(cid, session);
      byStart.set(punch.id, session);
      lastByCompany.set(cid, session);
    } else {
      const closing = punch.type === "out" || punch.type === "extra_out";
      const session =
        closing && punch.punchInId
          ? byStart.get(punch.punchInId)
          : open.get(cid) || (closing ? lastByCompany.get(cid) : undefined);
      if (
        !session ||
        session.end ||
        getPunchCompanyId(session.start, employee, companies) !== cid ||
        toMillis(punch.timestamp) < toMillis(session.start.timestamp)
      )
        continue;
      session.punches.push(punch);
      if (closing) {
        session.end = punch;
        if (open.get(cid) === session) open.delete(cid);
      }
    }
  }

  const companyOf = (cid: string) => companies.find((c) => normalizeCompanyId(c.id) === cid);
  const shiftLateness = new Map<
    string,
    { punchId: string; minutes: number; excused: boolean; reason: string }
  >();
  for (const session of sessions) {
    if (!opensRegularShift(session.start)) continue;
    const cid = getPunchCompanyId(session.start, employee, companies);
    const scoped = scopeEmployeeToPunchSchedule(
      getEmployeeForCompany(employee, cid),
      session.start,
    );
    const start = toDate(session.start.timestamp)!;
    const key = shiftLatenessKey(cid, getEmployeeShiftWindow(scoped, start).start);
    if (shiftLateness.has(key)) continue;
    const lateness = computeEmployeeLateness(
      start,
      scoped,
      companyOf(cid)?.lateGraceMinutes,
      session.start.isExcused,
    );
    shiftLateness.set(key, {
      punchId: session.start.id,
      minutes: lateness.isLate ? lateness.minutes : 0,
      excused: Boolean(session.start.isExcused),
      reason: session.start.excuseReason || "",
    });
  }

  return sessions.map((session) => {
    const cid = getPunchCompanyId(session.start, employee, companies);
    const base = getEmployeeForCompany(employee, cid);
    const timezone = session.start.shiftTimezone || getShiftTimezone(base);
    const scoped = scopeEmployeeToPunchSchedule(base, session.start);
    const startedAt = toDate(session.start.timestamp)!;
    const shift = getEmployeeShiftWindow(scoped, startedAt);
    const endedAt = session.end ? toDate(session.end.timestamp) : null;
    const active =
      !session.end &&
      !session.switchedAt &&
      open.get(cid) === session &&
      live.activeCompanyId === cid;
    const company = companyOf(cid);
    const calc = calculateAttendanceSession({
      employee: scoped,
      company,
      punchIn: startedAt,
      punchOut: endedAt || session.switchedAt,
      now,
      punches: session.punches,
      isOffShiftDay: session.start.type === "extra_in" || session.start.isOffShiftDay,
    });
    const judged = shiftLateness.get(shiftLatenessKey(cid, shift.start));
    const finishedAt = endedAt || session.switchedAt || (active ? now : null);
    return {
      id: session.start.id,
      companyId: cid,
      company,
      start: session.start,
      end: session.end,
      switchedAt: session.switchedAt,
      punches: session.punches,
      base,
      scoped,
      timezone,
      startedAt,
      endedAt,
      shift,
      attendanceDate: session.start.attendanceDate || shift.dateKey,
      active,
      onBreak: active && live.sessionType === "break",
      // Without a clock-out record the end is a guess, even after a switch.
      unresolved: !endedAt && !active,
      calc,
      breakMinutes: finishedAt
        ? Math.round(breakDurationMs(session.punches, startedAt, finishedAt) / 60_000)
        : 0,
      lateness:
        judged?.punchId === session.start.id
          ? { minutes: judged.minutes, excused: judged.excused, reason: judged.reason }
          : null,
    };
  });
}
