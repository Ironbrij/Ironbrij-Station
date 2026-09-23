import type { Company, Employee, LeaveRequest, Punch } from "./types.ts";
import { computeEmployeeLateness, getActiveWorkingSession, getEmployeeApprovedLeaveForDate,
  getEffectiveEmployeeWorkingDays, getEffectiveLateGraceMinutes,
  getEmployeeHoliday, getEmployeeHolidayDates, getEmployeeShiftWindow, getLiveAttendanceStatus,
  getShiftTimezone, zonedDateKey, zonedDateTimeToDate, formatInTimezone } from "./attendance.ts";
import { getEmployeeCompanyIds, getEmployeeForCompany, getEmployeePunchesForCompany, normalizeCompanyId } from "./company-context.ts";
import { opensRegularShift, scopeEmployeeToPunchSchedule } from "./shift-lateness.ts";
import { toDate, toMillis } from "./time.ts";
export type LateRecord = {
  id: string; employee: Employee; dateKey: string; scheduledAt: Date; punchedAt?: Date;
  minutesLate: number; kind: "arrival" | "missing"; isExcused?: boolean; excuseReason?: string;
  punch?: Punch; isEarly?: boolean; minutesEarly?: number; companyId: string; companyName: string; shiftLabel?: string;
};
function nextDateKey(dateKey: string): string {
  const next = new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}
export function buildLateRecords(employees: Employee[], punches: Punch[], leaves: LeaveRequest[], companies: Company[], now: Date, options: { period?: "today" | "week" | "month" | "all" } = {}): LateRecord[] {
  const result: LateRecord[] = [];
  const period = options.period || "all";
  const byEmployee = new Map<string, Punch[]>();
  for (const punch of punches) {
    const list = byEmployee.get(punch.employeeId);
    if (list) list.push(punch); else byEmployee.set(punch.employeeId, [punch]);
  }
  for (const employee of employees.filter((e) => e.status === "active" && e.inviteStatus === "accepted")) {
    const employeePunches = [...(byEmployee.get(employee.id) || []),
      ...(employee.authUid && employee.authUid !== employee.id ? byEmployee.get(employee.authUid) || [] : [])];
    const active = getActiveWorkingSession(employeePunches, employee, now, companies);
    for (const companyId of getEmployeeCompanyIds(employee)) {
      const scoped = getEmployeeForCompany(employee, companyId);
      const company = companies.find((c) => normalizeCompanyId(c.id) === companyId);
      const companyName = company?.name || companyId;
      const ownPunches = getEmployeePunchesForCompany(employeePunches, employee, companyId, company?.name);
      const firstByShift = new Map<number, Punch>();
      const todayKey = zonedDateKey(now, getShiftTimezone(scoped));
      const from = new Date(`${todayKey}T12:00:00Z`);
      from.setUTCDate(from.getUTCDate() - (period === "today" ? 0 : period === "week" ? 6 : 29));
      const fromKey = from.toISOString().slice(0, 10);
      const coarseCutoff = from.getTime() - 48 * 60 * 60 * 1000;
      for (const punch of ownPunches) {
        const at = toDate(punch.timestamp);
        if (!opensRegularShift(punch) || !at || at > now) continue;
        if (period !== "all" && at.getTime() < coarseCutoff) continue;
        const shift = getEmployeeShiftWindow(scopeEmployeeToPunchSchedule(scoped, punch), at);
        if (period !== "all" && (shift.dateKey < fromKey || shift.dateKey > todayKey)) continue;
        if (at >= shift.end) continue;
        const key = shift.start.getTime();
        const existing = firstByShift.get(key);
        if (!existing || toMillis(existing.timestamp) > at.getTime()) firstByShift.set(key, punch);
      }
      const ownLeaves = leaves.filter((leave) => !leave.companyId || normalizeCompanyId(leave.companyId) === companyId);
      for (const punch of firstByShift.values()) {
        const at = toDate(punch.timestamp)!;
        const punchScoped = scopeEmployeeToPunchSchedule(scoped, punch);
        const shift = getEmployeeShiftWindow(punchScoped, at);
        const status = getLiveAttendanceStatus(scoped, [], at, company?.lateGraceMinutes, company?.workingDays, getEmployeeHolidayDates(company, scoped));
        if (!status.isScheduledDay || getEmployeeHoliday(company, scoped, shift.dateKey) || getEmployeeApprovedLeaveForDate(scoped, ownLeaves, shift.dateKey)) continue;
        const late = computeEmployeeLateness(at, punchScoped, company?.lateGraceMinutes, Boolean(punch.isExcused));
        if (!late.naturallyLate && !punch.isExcused) continue;
        result.push({ id: punch.id, employee: scoped, dateKey: shift.dateKey, scheduledAt: shift.start,
          punchedAt: at, minutesLate: late.rawMinutes, kind: "arrival", isExcused: punch.isExcused,
          excuseReason: punch.excuseReason, punch, companyId, companyName,
          shiftLabel: `${formatInTimezone(shift.start, shift.timezone)} – ${formatInTimezone(shift.end, shift.timezone)}` });
      }
      // A scheduled day with no clock-in stays missed once the shift is over. The
      // dashboard lists one per date, so the late log has to cover the same days
      // instead of only the shift happening right now.
      const clockedInDays = new Set<string>();
      for (const punch of ownPunches) {
        const at = toDate(punch.timestamp);
        if (!at || (punch.type !== "in" && punch.type !== "extra_in")) continue;
        clockedInDays.add(getEmployeeShiftWindow(scopeEmployeeToPunchSchedule(scoped, punch), at).dateKey);
      }
      const timezone = getShiftTimezone(scoped);
      const graceMinutes = getEffectiveLateGraceMinutes(company?.lateGraceMinutes);
      const holidayDates = getEmployeeHolidayDates(company, scoped);
      const workingDays = getEffectiveEmployeeWorkingDays(scoped, company?.workingDays);
      const joinedKey = employee.createdAt ? zonedDateKey(new Date(employee.createdAt), timezone) : "";
      for (let dateKey = fromKey; dateKey <= todayKey; dateKey = nextDateKey(dateKey)) {
        if (clockedInDays.has(dateKey) || (joinedKey && dateKey < joinedKey)) continue;
        if (holidayDates.includes(dateKey) || getEmployeeHoliday(company, scoped, dateKey)) continue;
        if (!workingDays.includes(new Date(`${dateKey}T12:00:00Z`).getUTCDay())) continue;
        if (getEmployeeApprovedLeaveForDate(scoped, ownLeaves, dateKey)) continue;
        const shift = getEmployeeShiftWindow(
          scoped,
          zonedDateTimeToDate(dateKey, scoped.shiftStartTime || "09:00", timezone),
        );
        // Today's shift is only missed once its grace has run out, and never
        // while the employee is actually working somewhere.
        if (dateKey === todayKey && active.activeCompanyId) continue;
        const overdueMinutes = Math.floor(
          (Math.min(now.getTime(), shift.effectiveEnd.getTime()) - shift.start.getTime()) / 60000,
        );
        if (overdueMinutes <= graceMinutes) continue;
        result.push({ id: `missing-${employee.id}-${companyId}-${shift.start.toISOString()}`, employee: scoped,
          dateKey, scheduledAt: shift.start, minutesLate: overdueMinutes,
          kind: "missing", companyId, companyName,
          shiftLabel: `${formatInTimezone(shift.start, shift.timezone)} – ${formatInTimezone(shift.end, shift.timezone)}` });
      }
    }
  }
  return result.sort((a, b) => (b.punchedAt || b.scheduledAt).getTime() - (a.punchedAt || a.scheduledAt).getTime());
}
export function lateRecordInPeriod(record: LateRecord, period: "today" | "week" | "month" | "all", now: Date): boolean {
  if (period === "all") return true;
  const today = zonedDateKey(now, getShiftTimezone(record.employee));
  if (period === "today") return record.dateKey === today;
  const from = new Date(`${today}T12:00:00Z`);
  from.setUTCDate(from.getUTCDate() - (period === "week" ? 6 : 29));
  return record.dateKey >= from.toISOString().slice(0, 10) && record.dateKey <= today;
}
