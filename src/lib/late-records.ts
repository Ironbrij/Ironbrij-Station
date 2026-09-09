import type { Company, Employee, LeaveRequest, Punch } from "./types.ts";
import { computeEmployeeLateness, getActiveWorkingSession, getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday, getEmployeeHolidayDates, getEmployeeShiftWindow, getLiveAttendanceStatus,
  getShiftTimezone, zonedDateKey, formatInTimezone } from "./attendance.ts";
import { getEmployeeCompanyIds, getEmployeeForCompany, getEmployeePunchesForCompany, normalizeCompanyId } from "./company-context.ts";
import { toDate, toMillis } from "./time.ts";
export type LateRecord = {
  id: string; employee: Employee; dateKey: string; scheduledAt: Date; punchedAt?: Date;
  minutesLate: number; kind: "arrival" | "missing"; isExcused?: boolean; excuseReason?: string;
  punch?: Punch; isEarly?: boolean; minutesEarly?: number; companyId: string; companyName: string; shiftLabel?: string;
};
export function buildLateRecords(employees: Employee[], punches: Punch[], leaves: LeaveRequest[], companies: Company[], now: Date): LateRecord[] {
  const result: LateRecord[] = [];
  for (const employee of employees.filter((e) => e.status === "active" && e.inviteStatus === "accepted")) {
    const active = getActiveWorkingSession(punches, employee, now, companies);
    for (const companyId of getEmployeeCompanyIds(employee)) {
      const scoped = getEmployeeForCompany(employee, companyId);
      const company = companies.find((c) => normalizeCompanyId(c.id) === companyId);
      const companyName = company?.name || companyId;
      const ownPunches = getEmployeePunchesForCompany(punches, employee, companyId, company?.name);
      const firstByShift = new Map<number, Punch>();
      for (const punch of ownPunches) {
        const at = toDate(punch.timestamp);
        if (punch.type !== "in" || !at || at > now) continue;
        const shift = getEmployeeShiftWindow(scoped, at);
        if (at >= shift.end || punch.isOffShiftDay) continue;
        const key = shift.start.getTime();
        const existing = firstByShift.get(key);
        if (!existing || toMillis(existing.timestamp) > at.getTime()) firstByShift.set(key, punch);
      }
      const ownLeaves = leaves.filter((leave) => !leave.companyId || normalizeCompanyId(leave.companyId) === companyId);
      for (const punch of firstByShift.values()) {
        const at = toDate(punch.timestamp)!;
        const shift = getEmployeeShiftWindow(scoped, at);
        const status = getLiveAttendanceStatus(scoped, [], at, company?.lateGraceMinutes, company?.workingDays, getEmployeeHolidayDates(company, scoped));
        if (!status.isScheduledDay || getEmployeeHoliday(company, scoped, shift.dateKey) || getEmployeeApprovedLeaveForDate(scoped, ownLeaves, shift.dateKey)) continue;
        const late = computeEmployeeLateness(at, scoped, company?.lateGraceMinutes, Boolean(punch.isExcused));
        if (!late.naturallyLate && !punch.isExcused) continue;
        result.push({ id: punch.id, employee: scoped, dateKey: shift.dateKey, scheduledAt: shift.start,
          punchedAt: at, minutesLate: late.rawMinutes, kind: "arrival", isExcused: punch.isExcused,
          excuseReason: punch.excuseReason, punch, companyId, companyName,
          shiftLabel: `${formatInTimezone(shift.start, shift.timezone)} – ${formatInTimezone(shift.end, shift.timezone)}` });
      }
      const status = getLiveAttendanceStatus(scoped, ownPunches, now, company?.lateGraceMinutes, company?.workingDays, getEmployeeHolidayDates(company, scoped));
      if (!active.activeCompanyId && status.isMissingLate && !getEmployeeApprovedLeaveForDate(scoped, ownLeaves, status.shift.dateKey)) {
        result.push({ id: `missing-${employee.id}-${companyId}-${status.shift.start.toISOString()}`, employee: scoped,
          dateKey: status.shift.dateKey, scheduledAt: status.shift.start, minutesLate: status.minutesLate,
          kind: "missing", companyId, companyName });
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
