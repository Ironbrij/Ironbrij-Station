import type { Timestamp } from "firebase/firestore";

export const DEFAULT_LOGO =
  "https://ironbrij.com.au/wp-content/uploads/2024/11/ironbrij-logo-circle-blue.jpg";

export type PunchType = "in" | "out" | "extra_in" | "extra_out" | "lunch_start" | "lunch_end";

export type HolidayTargetType = "all" | "companies" | "departments" | "states" | "employees";

export interface CompanyHoliday {
  id: string;
  date: string; // YYYY-MM-DD
  name?: string;
  targetType: HolidayTargetType;
  companyIds?: string[];
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
  punchOutGraceMinutes?: number;
  punchOutReminderMinutes?: number;
  timezone?: string;
  breakAllowanceMinutes?: number;
  maxDailyBreaks?: number;
  archived?: boolean;
  status?: "active" | "archived";
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

export interface ShiftInterval {
  id?: string;
  name?: string;
  startTime: string; // e.g. "04:00"
  endTime: string; // e.g. "07:00"
  workingDays?: number[]; // Specific working days for this shift interval: 0=Sun..6=Sat
}

export type ReportingRequirement = "sod_only" | "eod_only" | "sod_eod" | "none";
export type DailyReportType = "sod" | "eod";
export type DailyReportStatus = "submitted";

export interface Employee {
  id: string;
  companyId?: string;
  companyIds?: string[]; // Multi-company membership (can belong to 1 or more companies)
  companyMemberships?: Record<string, CompanyMembership>;
  deptId?: string;
  name: string;
  email: string;
  jobTitle?: string;
  status: EmployeeStatus;
  authUid?: string;
  photoUrl?: string;
  photoURL?: string; // Legacy/Firebase-style Google profile photo field
  inviteStatus: InviteStatus;
  isMultipleShift?: boolean;
  shifts?: ShiftInterval[];
  shiftStartTime?: string; // e.g. "09:00"
  shiftEndTime?: string; // e.g. "17:00"
  country?: CountryCode; // "NP" = Nepal, "AU" = Australia, "PH" = Philippines
  state?: string; // Optional state/province/region; "N/A" means not assigned
  timezone?: string; // employee local timezone
  shiftTimezone?: string; // timezone used to interpret shift start/end
  createdAt?: string; // ISO timestamp for when the employee profile was created
  reportingRequirement?: ReportingRequirement;
  workingDays?: number[]; // Custom per-employee working days 0=Sun..6=Sat
  requiredWorkMinutes?: number; // Legacy/default requirement; company membership overrides this
  breakAllowanceMinutes?: number; // Break duration in minutes (e.g., 30, 40, 60, 90; default 30)
  maxDailyBreaks?: number; // Number of breaks allowed per day (e.g., 1, 2, 3; default 1)
}

export interface CompanyMembership {
  companyId: string;
  role?: "employee" | "manager" | "admin";
  status?: "active" | "inactive";
  requiredWorkMinutes?: number;
  shiftId?: string;
  isMultipleShift?: boolean;
  shifts?: ShiftInterval[];
  shiftStartTime?: string;
  shiftEndTime?: string;
  shiftTimezone?: string;
  workingDays?: number[];
  departmentId?: string;
  breakAllowanceMinutes?: number;
  maxDailyBreaks?: number;
  joinedAt?: string;
  updatedAt?: string;
}

export interface ReportQuestion {
  id: string;
  question?: string;
  text?: string;
  reportType?: DailyReportType;
  type?: "text" | "textarea";
  required?: boolean;
  order?: number;
}

export interface ReportingSettings {
  sodEnabled?: boolean;
  eodEnabled?: boolean;
  sodDeadline?: string;
  eodDeadline?: string;
  sodDeadlineTime?: string;
  eodDeadlineTime?: string;
  lockAfterDeadline?: boolean;
  questions?: ReportQuestion[];
}

export interface MentionItem {
  id: string; // employeeId or departmentId
  type: "person" | "department";
  name: string;
  displayTag: string; // e.g. "@Bevet Smith" or "@Engineering"
  deptId?: string;
  deptName?: string;
  companyId?: string;
  email?: string;
}

export interface DailyReportAnswer {
  questionId: string;
  question: string;
  answer: string;
  mentions?: MentionItem[];
}

export interface DailyReport {
  id: string;
  userId: string;
  employeeId?: string;
  companyId?: string;
  userName: string;
  userEmail: string;
  reportDate: string;
  reportType: DailyReportType;
  answers: DailyReportAnswer[];
  submittedAt: Timestamp;
  timezone: string;
  submittedLate: boolean;
  status: DailyReportStatus;
  mentions?: MentionItem[];
}

export interface Punch {
  id: string;
  employeeId: string;
  employeeName?: string;
  date?: string;
  type: PunchType;
  timestamp: Timestamp;
  source: "app" | "auto";
  companyId?: string;
  companyName?: string;
  shiftId?: string;
  attendanceDate?: string;
  scheduledShiftStart?: string;
  scheduledShiftEnd?: string;
  shiftTimezone?: string;
  requiredWorkMinutes?: number;
  normalWorkMinutes?: number;
  overtimeMinutes?: number;
  totalEligibleMinutes?: number;
  attendanceStatus?: AttendanceStatus;
  isEarly?: boolean;
  isAuto?: boolean;
  autoReason?: "suspension" | "approved_leave" | "company_holiday" | "shift_timeout";
  isExcused?: boolean;
  excusedBy?: string;
  excusedAt?: string;
  excuseReason?: string;
  isOffShiftDay?: boolean;
  overtimeRequestId?: string;
}

export type AttendanceStatus = "in_progress" | "complete" | "missing_punch_out";

export type OvertimeStatus = "pending" | "approved" | "rejected";

export type OvertimeRequestType = "overtime" | "off_shift_work" | "early_clock_in";

export interface OvertimeRequest {
  id: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  date: string;
  requestType?: OvertimeRequestType;
  punchOutId?: string;
  punchInId?: string;
  overtimeMinutes: number;
  normalWorkMinutes?: number;
  isOffShiftDay: boolean;
  reason: string;
  status: OvertimeStatus;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
}

export interface LeaveDayItem {
  date: string; // YYYY-MM-DD
  leaveType?: "full_day" | "half_day" | "timed_break";
  paymentStatus?: "paid" | "unpaid";
  leaveCategory?: "annual" | "sick" | "personal" | "other";
  halfDayPeriod?: "first_half" | "second_half";
  startTime?: string;
  endTime?: string;
  notes?: string;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  companyId?: string; // Optional only for historical requests
  leaveCategory?: "annual" | "sick" | "personal" | "other";
  paymentStatus?: "paid" | "unpaid";
  remarks?: string;
  leaveType?: "full_day" | "half_day" | "timed_break";
  halfDayPeriod?: "first_half" | "second_half";
  startTime?: string; // HH:mm in the employee shift timezone
  endTime?: string; // HH:mm in the employee shift timezone
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;
  dates?: LeaveDayItem[];
  reason: string;
  status: "pending" | "approved" | "rejected";
  createdAt: Timestamp;
  decidedAt?: string;
  decidedBy?: string;
  decisionSource?: "admin" | "automatic";
  decisionReason?: string;
}

export interface PunchOutReminder {
  id: string;
  employeeId: string;
  companyId: string;
  punchInId: string;
  attendanceDate: string;
  shiftEndAt: string;
  status: "pending" | "sent" | "failed";
  createdAt: string;
  sentAt?: string;
  error?: string;
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
