import type { Timestamp } from "firebase/firestore";

export type PunchType = "in" | "out" | "extra_in" | "extra_out";

export interface Company {
  name: string;
  logoUrl?: string;
  defaultShiftHours: number;
  holidays: string[]; // YYYY-MM-DD
  workingDays: number[]; // 0=Sun..6=Sat
  lateGraceMinutes?: number;
}

export interface Department {
  id: string;
  companyId: string;
  name: string;
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
  inviteStatus: InviteStatus;
  shiftStartTime?: string; // e.g. "09:00"
  shiftEndTime?: string; // e.g. "17:00"
  country?: CountryCode; // "NP" = Nepal, "AU" = Australia, "PH" = Philippines
  timezone?: string; // employee local timezone
  shiftTimezone?: string; // timezone used to interpret shift start/end
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
  autoReason?: "suspension" | "approved_leave" | "shift_timeout";
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Timestamp;
  decidedAt?: string;
  decidedBy?: string;
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
  targetType: "all" | "dept" | "employee";
  targetDeptId?: string;
  targetEmployeeId?: string;
  targetEmployeeIds?: string[];
  createdAt: string;
  authorName: string;
}

export const COMPANY_ID = "default";
