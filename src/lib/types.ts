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
  id?: string;
  name: string;
  code?: string;
  logoUrl?: string;
  defaultShiftHours: number;
  holidays: string[]; // Legacy company-wide YYYY-MM-DD dates
  holidayAssignments?: CompanyHoliday[];
  workingDays: number[]; // 0=Sun..6=Sat
  lateGraceMinutes?: number;
  isMain?: boolean;
  createdAt?: string;
}

export interface Department {
  id: string;
  companyId?: string; // Belongs to specific company ID (defaults to COMPANY_ID for legacy)
  name: string;
  state?: string;
}

export type EmployeeStatus = "active" | "inactive";
export type InviteStatus = "pending" | "accepted";

export type CountryCode = "NP" | "AU" | "PH";

export type ReportingRequirement = "sod_only" | "eod_only" | "sod_eod" | "none";
export type DailyReportType = "sod" | "eod";
export type DailyReportStatus = "submitted";

export interface Employee {
  id: string;
  companyId: string;
  companyIds?: string[]; // Multi-company membership (can belong to 1 or more companies)
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
  reportingRequirement?: ReportingRequirement;
  workingDays?: number[]; // Custom per-employee working days 0=Sun..6=Sat
}

export interface ReportQuestion {
  id: string;
  text: string;
  type: "text" | "textarea";
  required: boolean;
  order: number;
}

export interface ReportingSettings {
  sodEnabled: boolean;
  eodEnabled: boolean;
  sodDeadlineTime: string;
  eodDeadlineTime: string;
  questions: ReportQuestion[];
}

export interface DailyReportAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface DailyReport {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  reportDate: string;
  reportType: DailyReportType;
  answers: DailyReportAnswer[];
  submittedAt: Timestamp;
  timezone: string;
  submittedLate: boolean;
  status: DailyReportStatus;
}

export interface Punch {
  id: string;
  employeeId: string;
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
  targetType: "all" | "dept" | "states" | "employee" | "companies";
  targetCompanyIds?: string[];
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
