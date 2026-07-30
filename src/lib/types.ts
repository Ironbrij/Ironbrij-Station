import type { Timestamp } from "firebase/firestore";

export type PunchType = "in" | "out" | "extra_in" | "extra_out";

export type HolidayTargetType = "all" | "departments" | "states" | "employees";

export interface CompanyHoliday {
  id: string;
  date: string; // YYYY-MM-DD
  name?: string;
  targetType: HolidayTargetType;
  departmentIds?: string[];
  stateCodes?: string[];
  employeeIds?: string[];
}

export interface Company {
  name: string;
  logoUrl?: string;
  defaultShiftHours: number;
  holidays: string[]; // Legacy company-wide YYYY-MM-DD dates
  holidayAssignments?: CompanyHoliday[];
  workingDays: number[]; // 0=Sun..6=Sat
  lateGraceMinutes?: number;
}

export interface Department {
  id: string;
  companyId: string;
  name: string;
  state?: string;
}

export type EmployeeStatus = "active" | "inactive";
export type InviteStatus = "pending" | "accepted";

export type CountryCode = "NP" | "AU" | "PH";

export interface Employee {
  id: string;
  companyId: string;
  deptId: string;
  name: string;
  email: string;
  jobTitle: string;
  status: EmployeeStatus;
  authUid?: string;
  photoUrl?: string;
  photoURL?: string; // Legacy/Firebase-style Google profile photo field
  inviteStatus: InviteStatus;
  shiftStartTime?: string; // e.g. "09:00"
  shiftEndTime?: string; // e.g. "17:00"
  country?: CountryCode; // "NP" = Nepal, "AU" = Australia, "PH" = Philippines
  state?: string; // Optional state/province/region; "N/A" means not assigned
  timezone?: string; // employee local timezone
  shiftTimezone?: string; // timezone used to interpret shift start/end
  createdAt?: string; // ISO timestamp for when the employee profile was created
}

export interface Punch {
  id: string;
  employeeId: string;
  employeeName?: string;
  date?: string; // YYYY-MM-DD
  type: PunchType;
  timestamp: Timestamp;
  source: "app" | "auto";
  isEarly?: boolean;
  isAuto?: boolean;
  autoReason?: "suspension" | "approved_leave" | "company_holiday" | "shift_timeout";
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  leaveType?: "full_day" | "half_day" | "timed_break";
  halfDayPeriod?: "first_half" | "second_half";
  startTime?: string; // HH:mm in the employee shift timezone
  endTime?: string; // HH:mm in the employee shift timezone
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Timestamp;
  decidedAt?: string;
  decidedBy?: string;
  decisionSource?: "admin" | "automatic";
  decisionReason?: string;
}

export interface DailySummary {
  hoursWorked: number;
  overtimeHours: number;
  date: string;
  employeeId: string;
}

export interface Quote {
  id: string;
  text: string;
  author: string;
}

export interface CompanyNotice {
  id: string;
  title: string;
  message: string;
  priority: "info" | "warning" | "urgent";
  targetType: "all" | "dept" | "states" | "employee";
  targetDeptId?: string;
  targetDeptIds?: string[];
  targetStateCodes?: string[];
  targetEmployeeId?: string;
  targetEmployeeIds?: string[];
  createdAt: string;
  publishAt?: string;
  authorName: string;
}

export const COMPANY_ID = "default";
