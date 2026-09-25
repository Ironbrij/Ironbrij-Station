import type { Company, Employee, LeaveRequest, Punch } from "./types.ts";
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  normalizeCompanyId,
  indexPunchesByEmployee,
  getIndexedEmployeePunches,
} from "./company-context.ts";
import {
  getEmployeeShiftWindow,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEffectiveEmployeeWorkingDays,
  getEffectiveLateGraceMinutes,
  getShiftTimezone,
  formatInTimezone,
  zonedDateKey,
  zonedDateTimeToDate,
} from "./attendance.ts";
import { buildAttendanceSessions } from "./attendance-sessions.ts";
import {
  describePunchShiftSlot,
  getPunchShiftSlot,
  getShiftSlotByStart,
} from "./shift-clients.ts";
import { toDate, toMillis } from "./time.ts";

export type AttendanceLogStatus =
  "working" | "break" | "completed" | "missing" | "upcoming" | "leave" | "off" | "review";
export interface AttendanceLogRow {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  /** The client this session is worked for: the shift's own, else the company. */
  companyName: string;
  /** The company behind that client, when a shift slot names a different one. */
  parentCompanyName: string;
  /** "Shift 2 of 3" for a multi-slot schedule, empty for a single shift. */
  shiftLabel: string;
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
    // The same sessions the report reads, so both show the same hours.
    const sessions = buildAttendanceSessions({ employee, punches: own, companies, now });
    const represented = new Set<string>();
    const activeCompanies = new Set<string>();
    const recordedCompanies = new Set<string>();
    for (const session of sessions) {
      const cid = session.companyId;
      if (companyId !== "all" && normalizeCompanyId(companyId) !== cid) continue;
      const { active, shift, attendanceDate, timezone, calc } = session;
      const rowDate = date || zonedDateKey(now, timezone);
      if (attendanceDate !== rowDate && !(date === "" && active)) continue;
      represented.add(`${cid}:${shift.start.getTime()}`);
      recordedCompanies.add(cid);
      if (active) activeCompanies.add(cid);
      const company = session.company;
      const end = session.endedAt;
      // A shift slot may name the client it is worked for, and say which of the
      // day's slots this is. One company can cover several clients, and the
      // table is where an admin tells them apart.
      const slot = getPunchShiftSlot(session.base, session.start);
      const parentCompanyName = company?.name || session.start.companyName || cid;
      rows.push({
        id: session.id,
        employeeId: employee.id,
        employeeName: employee.name || employee.email || "Unnamed employee",
        companyId: cid,
        companyName: slot?.client || parentCompanyName,
        parentCompanyName,
        shiftLabel: describePunchShiftSlot(slot),
        state: employee.state || employee.country || "",
        date: attendanceDate,
        timezone,
        scheduleStart: toDate(session.start.scheduledShiftStart) || shift.start,
        scheduleEnd: toDate(session.start.scheduledShiftEnd) || shift.end,
        timeIn: session.startedAt,
        timeOut: end,
        hours: session.unresolved ? null : calc.actualWorkMinutes / 60,
        overtime: session.unresolved ? null : calc.overtimeMinutes / 60,
        // Lateness belongs to the shift, not to each clock-in inside it. The late
        // log judges the first regular clock-in of a shift, so the table reads the
        // same punch: excusing or correcting it there lands here.
        lateMinutes: session.lateness?.minutes ?? 0,
        excused: session.lateness?.excused ?? false,
        excuseReason: session.lateness?.reason ?? "",
        status: active
          ? session.onBreak
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
      // A day with no punch still belongs to a slot, so the admin can see which
      // shift and which client was not covered.
      const slot = getShiftSlotByStart(
        scoped,
        formatInTimezone(shift.start, timezone, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );
      const parentCompanyName = company?.name || cid;
      rows.push({
        id: `missing-${employee.id}-${cid}-${rowDate}`,
        employeeId: employee.id,
        employeeName: employee.name || employee.email || "Unnamed employee",
        companyId: cid,
        companyName: slot?.client || parentCompanyName,
        parentCompanyName,
        shiftLabel: describePunchShiftSlot(slot),
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
