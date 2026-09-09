import { buildLateRecords, lateRecordInPeriod } from "./late-records";
import { getEmployeePunchesForCompany, normalizeCompanyId } from "./company-context";
import type { Company, Employee, LeaveRequest, Punch } from "./types";
import {
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getLiveAttendanceStatus,
  getShiftTimezone,
  zonedDateKey,
} from "./attendance";

export const LATE_ALERT_READ_EVENT = "late_alert_read_change";
const LATE_ALERT_READ_STORAGE_KEY = "admin_read_late_alert_ids";

export type AdminLateAlert = {
  id: string;
  employee: Employee;
  status: ReturnType<typeof getLiveAttendanceStatus>;
};

export function buildAdminLateAlerts({
  employees,
  punches,
  leaves,
  company,
  now,
}: {
  employees: Employee[];
  punches: Punch[];
  leaves: LeaveRequest[];
  company: Company | null;
  now: Date;
}): AdminLateAlert[] {
  return buildLateRecords(employees, punches, leaves, company && company.id !== "all" ? [company] : [], now)
    .filter((record) => lateRecordInPeriod(record, "today", now) && !record.isExcused &&
      (!company || company.id === "all" || normalizeCompanyId(record.companyId) === normalizeCompanyId(company.id)))
    .map((record) => ({
      id: `late:${record.dateKey}:${record.employee.id}:${record.companyId}:${record.scheduledAt.toISOString()}`,
      employee: record.employee,
      status: { ...getLiveAttendanceStatus(record.employee,
        getEmployeePunchesForCompany(punches, record.employee, record.companyId), now,
        company?.lateGraceMinutes, company?.workingDays),
        isLate: true, minutesLate: record.minutesLate, firstIn: record.punch },
    }))
    .sort((a, b) => b.status.minutesLate - a.status.minutesLate);
}

export function readLateAlertIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value = JSON.parse(localStorage.getItem(LATE_ALERT_READ_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function markLateAlertsRead(ids: Iterable<string>): Set<string> {
  const next = readLateAlertIds();
  for (const id of ids) next.add(id);
  if (typeof window !== "undefined") {
    localStorage.setItem(LATE_ALERT_READ_STORAGE_KEY, JSON.stringify([...next]));
    window.dispatchEvent(new Event(LATE_ALERT_READ_EVENT));
  }
  return next;
}
