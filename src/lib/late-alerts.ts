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
  return employees
    .filter((employee) => employee.status === "active" && employee.inviteStatus === "accepted")
    .flatMap((employee) => {
      const shiftDate = zonedDateKey(now, getShiftTimezone(employee));
      if (getEmployeeApprovedLeaveForDate(employee, leaves, shiftDate)) return [];
      if (getEmployeeHoliday(company, employee, shiftDate)) return [];

      const identities = new Set([employee.id, employee.authUid].filter(Boolean));
      const employeePunches = punches.filter((punch) => identities.has(punch.employeeId));
      const status = getLiveAttendanceStatus(
        employee,
        employeePunches,
        now,
        company?.lateGraceMinutes ?? 5,
        company?.workingDays,
        getEmployeeHolidayDates(company, employee),
      );

      if (!status.isLate) return [];
      return [{ id: `late:${shiftDate}:${employee.id}`, employee, status }];
    })
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
