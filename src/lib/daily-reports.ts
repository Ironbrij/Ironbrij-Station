import type {
  DailyReport,
  DailyReportType,
  Employee,
  ReportingRequirement,
  ReportingSettings,
} from "./types";
import { getEmployeeTimezone, zonedDateKey, zonedDateTimeToDate } from "./attendance";

export const DEFAULT_REPORTING_SETTINGS: ReportingSettings = {
  sodDeadline: "10:00",
  eodDeadline: "18:00",
  lockAfterDeadline: false,
};

export const DEFAULT_REPORT_QUESTIONS = {
  sod: [
    { id: "sod_priorities", question: "What are your main priorities today? *" },
    { id: "sod_team_note", question: "Is there anything important the team should know? *" },
  ],
  eod: [
    { id: "eod_completed", question: "What did you complete today? *" },
    { id: "eod_team_note", question: "Is there anything important the team should know? *" },
  ],
} as const;

export function reportingRequirementLabel(value?: ReportingRequirement) {
  if (value === "sod_only") return "SOD only";
  if (value === "eod_only") return "EOD only";
  if (value === "sod_eod") return "SOD and EOD";
  return "No reporting required";
}

export function requiredReportTypes(value?: ReportingRequirement): DailyReportType[] {
  if (value === "none") return [];
  if (value === "sod_only") return ["sod"];
  if (value === "eod_only") return ["eod"];
  return ["sod", "eod"];
}

export function reportTypeLabel(type: DailyReportType) {
  return type === "sod" ? "Start of Day" : "End of Day";
}

export function reportDocumentId(userId: string, date: string, type: DailyReportType) {
  return `${userId}_${date}_${type}`;
}

export function reportDateForEmployee(employee: Employee, now = new Date()) {
  return zonedDateKey(now, getEmployeeTimezone(employee));
}

export function deadlineForReport(
  employee: Employee,
  type: DailyReportType,
  date: string,
  settings: ReportingSettings,
) {
  const deadline =
    (type === "sod"
      ? settings.sodDeadline || settings.sodDeadlineTime
      : settings.eodDeadline || settings.eodDeadlineTime) ||
    (type === "sod" ? "10:00" : "18:00");
  return zonedDateTimeToDate(date, deadline, getEmployeeTimezone(employee));
}

export function isReportDeadlinePassed(
  employee: Employee,
  type: DailyReportType,
  date: string,
  settings: ReportingSettings,
  now = new Date(),
) {
  const employeeToday = reportDateForEmployee(employee, now);
  if (date < employeeToday) return true;
  if (date > employeeToday) return false;
  return now.getTime() > deadlineForReport(employee, type, date, settings).getTime();
}

export function reportDisplayStatus(input: {
  required: boolean;
  report?: DailyReport | null;
  deadlinePassed: boolean;
}) {
  if (!input.required) return "not_required" as const;
  if (input.report) return "submitted" as const;
  if (input.deadlinePassed) return "missed" as const;
  return "not_submitted" as const;
}
