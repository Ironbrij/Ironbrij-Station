import type { Company, Employee, LeaveRequest, Punch } from "./types.ts";
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getPunchCompanyId,
  normalizeCompanyId,
  indexPunchesByEmployee,
  getIndexedEmployeePunches,
} from "./company-context.ts";
import {
  getActiveWorkingSession,
  getEmployeeShiftWindow,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEffectiveEmployeeWorkingDays,
  getEffectiveLateGraceMinutes,
  getShiftTimezone,
  zonedDateKey,
  zonedDateTimeToDate,
  computeEmployeeLateness,
} from "./attendance.ts";
import { calculateAttendanceSession } from "./attendance-calculation.ts";
import {
  opensRegularShift,
  scopeEmployeeToPunchSchedule,
  shiftLatenessKey,
} from "./shift-lateness.ts";
import { getPunchShiftClient } from "./shift-clients.ts";
import { toDate, toMillis } from "./time.ts";

export type AttendanceLogStatus =
  "working" | "break" | "completed" | "missing" | "upcoming" | "leave" | "off" | "review";
export interface AttendanceLogRow {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  companyName: string;
  state: string;
  date: string;
  timezone: string;
  scheduleStart: Date;
  scheduleEnd: Date;
  timeIn: Date | null;
  timeOut: Date | null;
  hours: number | null;
  overtime: number | null;
  lateMinutes: number;
  excused: boolean;
  excuseReason: string;
  status: AttendanceLogStatus;
  automatic: boolean;
}
interface Session {
  start: Punch;
  end?: Punch;
  switchedAt?: Date;
  punches: Punch[];
}

/** Read-only table model. Never invent a punch-out or change stored attendance. */
export function buildAttendanceLog({
  employees,
  punches,
  companies,
  leaves,
  now,
  date = "",
  companyId = "all",
}: {
  employees: Employee[];
  punches: Punch[];
  companies: Company[];
  leaves: LeaveRequest[];
  now: Date;
  date?: string;
  companyId?: string;
}): AttendanceLogRow[] {
  const rows: AttendanceLogRow[] = [];
  const indexed = indexPunchesByEmployee(punches);
  const profiles = new Map<string, Employee>();
  for (const employee of employees) {
    const key = employee.authUid || employee.id;
    const existing = profiles.get(key);
    if (!existing || (existing.inviteStatus !== "accepted" && employee.inviteStatus === "accepted"))
      profiles.set(key, employee);
  }
  for (const employee of profiles.values()) {
    const target = date || zonedDateKey(now, getShiftTimezone(employee));
    const cutoff = new Date(`${target}T00:00:00Z`).getTime() - 48 * 3600000;
    const own = getIndexedEmployeePunches(indexed, employee)
      .filter(
        (p) =>
          !p.voidedAt &&
          toMillis(p.timestamp) >= cutoff &&
          toMillis(p.timestamp) <= now.getTime() + 5 * 60000,
      )
      .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
    const live = getActiveWorkingSession(own, employee, now, companies);
    const sessions: Session[] = [];
    const open = new Map<string, Session>();
    const byStart = new Map<string, Session>();
    const lastByCompany = new Map<string, Session>();
    for (const punch of own) {
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
        const session = { start: punch, punches: [punch] };
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
    // Lateness belongs to the shift, not to each clock-in inside it. The late
    // log judges the first regular clock-in of a shift, so the table reads the
    // same punch: excusing or correcting it there lands here.
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
        companies.find((c) => normalizeCompanyId(c.id) === cid)?.lateGraceMinutes,
        session.start.isExcused,
      );
      shiftLateness.set(key, {
        punchId: session.start.id,
        minutes: lateness.isLate ? lateness.minutes : 0,
        excused: Boolean(session.start.isExcused),
        reason: session.start.excuseReason || "",
      });
    }
    const represented = new Set<string>();
    const activeCompanies = new Set<string>();
    const recordedCompanies = new Set<string>();
    for (const session of sessions) {
      const cid = getPunchCompanyId(session.start, employee, companies);
      if (companyId !== "all" && normalizeCompanyId(companyId) !== cid) continue;
      const base = getEmployeeForCompany(employee, cid);
      const timezone = session.start.shiftTimezone || getShiftTimezone(base);
      const scoped = scopeEmployeeToPunchSchedule(base, session.start);
      const start = toDate(session.start.timestamp)!;
      const shift = getEmployeeShiftWindow(scoped, start);
      const attendanceDate = session.start.attendanceDate || shift.dateKey;
      const active =
        !session.end &&
        !session.switchedAt &&
        open.get(cid) === session &&
        live.activeCompanyId === cid;
      const rowDate = date || zonedDateKey(now, timezone);
      if (attendanceDate !== rowDate && !(date === "" && active)) continue;
      represented.add(`${cid}:${shift.start.getTime()}`);
      recordedCompanies.add(cid);
      if (active) activeCompanies.add(cid);
      const company = companies.find((c) => normalizeCompanyId(c.id) === cid);
      const end = session.end ? toDate(session.end.timestamp) : null;
      const unresolved = !end && !active;
      const calc = calculateAttendanceSession({
        employee: scoped,
        company,
        punchIn: start,
        punchOut: end || session.switchedAt,
        now,
        punches: session.punches,
        isOffShiftDay: session.start.type === "extra_in" || session.start.isOffShiftDay,
      });
      const judged = shiftLateness.get(shiftLatenessKey(cid, shift.start));
      const carriesLateness = judged?.punchId === session.start.id;
      rows.push({
        id: session.start.id,
        employeeId: employee.id,
        employeeName: employee.name || employee.email || "Unnamed employee",
        companyId: cid,
        // A shift slot may name the client it is worked for; one company can
        // cover several, and the table is where an admin tells them apart.
        companyName:
          getPunchShiftClient(base, session.start) ||
          company?.name ||
          session.start.companyName ||
          cid,
        state: employee.state || employee.country || "",
        date: attendanceDate,
        timezone,
        scheduleStart: toDate(session.start.scheduledShiftStart) || shift.start,
        scheduleEnd: toDate(session.start.scheduledShiftEnd) || shift.end,
        timeIn: start,
        timeOut: end,
        hours: unresolved ? null : calc.actualWorkMinutes / 60,
        overtime: unresolved ? null : calc.overtimeMinutes / 60,
        lateMinutes: carriesLateness ? judged!.minutes : 0,
        excused: carriesLateness ? judged!.excused : false,
        excuseReason: carriesLateness ? judged!.reason : "",
        status: active
          ? live.sessionType === "break"
            ? "break"
            : "working"
          : end
            ? "completed"
            : "review",
        automatic: Boolean(session.end?.isAuto),
      });
    }
    if (employee.status !== "active" || employee.inviteStatus !== "accepted") continue;
    for (const cid of getEmployeeCompanyIds(employee)) {
      if (
        cid === "all" ||
        activeCompanies.has(cid) ||
        (companyId !== "all" && normalizeCompanyId(companyId) !== cid)
      )
        continue;
      const scoped = getEmployeeForCompany(employee, cid);
      if (!scoped.isMultipleShift && recordedCompanies.has(cid)) continue;
      const timezone = getShiftTimezone(scoped);
      const rowDate = date || zonedDateKey(now, timezone);
      if (employee.createdAt && rowDate < zonedDateKey(new Date(employee.createdAt), timezone))
        continue;
      const instant = date
        ? zonedDateTimeToDate(rowDate, scoped.shiftStartTime || "09:00", timezone)
        : now;
      const shift = getEmployeeShiftWindow(scoped, instant);
      if (represented.has(`${cid}:${shift.start.getTime()}`)) continue;
      const company = companies.find((c) => normalizeCompanyId(c.id) === cid);
      const holiday = getEmployeeHoliday(company, scoped, rowDate);
      const approvedLeave = getEmployeeApprovedLeaveForDate(
        scoped,
        leaves.filter((l) => !l.companyId || normalizeCompanyId(l.companyId) === cid),
        rowDate,
      );
      const weekday = new Date(`${rowDate}T12:00:00Z`).getUTCDay();
      const off =
        !getEffectiveEmployeeWorkingDays(scoped, company?.workingDays).includes(weekday) ||
        Boolean(holiday);
      rows.push({
        id: `missing-${employee.id}-${cid}-${rowDate}`,
        employeeId: employee.id,
        employeeName: employee.name || employee.email || "Unnamed employee",
        companyId: cid,
        companyName: company?.name || cid,
        state: employee.state || employee.country || "",
        date: rowDate,
        timezone,
        scheduleStart: shift.start,
        scheduleEnd: shift.end,
        timeIn: null,
        timeOut: null,
        hours: null,
        overtime: null,
        lateMinutes: 0,
        excused: false,
        excuseReason: "",
        automatic: false,
        // A shift only counts as missed once its grace has run out, which is when
        // the late log starts reporting it.
        status: approvedLeave
          ? "leave"
          : off
            ? "off"
            : Math.floor((now.getTime() - shift.start.getTime()) / 60000) <=
                getEffectiveLateGraceMinutes(company?.lateGraceMinutes)
              ? "upcoming"
              : "missing",
      });
    }
  }
  return rows.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.employeeName.localeCompare(b.employeeName) ||
      a.scheduleStart.getTime() - b.scheduleStart.getTime(),
  );
}
