import type {
  DailyReport,
  DailyReportType,
  Employee,
  MentionItem,
  ReportingRequirement,
  ReportingSettings,
} from "./types.ts";
import { getEmployeeTimezone, zonedDateKey, zonedDateTimeToDate } from "./attendance.ts";
import { normalizeCompanyId } from "./company-context.ts";

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

export function reportDocumentId(
  userId: string,
  date: string,
  type: DailyReportType,
  companyId?: string,
) {
  return companyId
    ? `${userId}_${encodeURIComponent(companyId)}_${date}_${type}`
    : `${userId}_${date}_${type}`;
}

export function findDailyReport(
  reports: DailyReport[],
  input: {
    employee: Pick<Employee, "id" | "authUid">;
    date: string;
    type: DailyReportType;
    companyId?: string;
  },
): DailyReport | undefined {
  const employeeIds = new Set(
    [input.employee.id, input.employee.authUid].filter(Boolean) as string[],
  );
  const scopedCompanyId =
    input.companyId && input.companyId !== "all"
      ? normalizeCompanyId(input.companyId)
      : undefined;

  return reports.find((report) => {
    if (report.reportDate !== input.date || report.reportType !== input.type) return false;
    if (
      !employeeIds.has(report.userId) &&
      !(report.employeeId && employeeIds.has(report.employeeId))
    ) {
      return false;
    }

    return (
      !scopedCompanyId ||
      !report.companyId ||
      normalizeCompanyId(report.companyId) === scopedCompanyId
    );
  });
}

export function reportDateForEmployee(employee: Employee, now = new Date()) {
  return zonedDateKey(now, getEmployeeTimezone(employee));
}

/** How many days after the day it is for a VA can still correct a submitted report. */
export const REPORT_EDIT_WINDOW_DAYS = 4;

/** The last day a report can be edited on, as YYYY-MM-DD ("" for a bad date). */
export function lastReportEditDate(reportDate: string) {
  const [year, month, day] = reportDate.split("-").map(Number);
  const last = new Date(Date.UTC(year, month - 1, day + REPORT_EDIT_WINDOW_DAYS));
  return Number.isNaN(last.getTime()) ? "" : last.toISOString().slice(0, 10);
}

/**
 * Whether a VA can still edit a submitted SOD or EOD: until it is four days old,
 * counted from their own today, so a report sent under the wrong client or as
 * the wrong type can be put right without rewriting old history.
 */
export function canEditReport(report: Pick<DailyReport, "reportDate">, today: string) {
  return report.reportDate <= today && today <= lastReportEditDate(report.reportDate);
}

/** Mentions an edit adds, so only newly tagged people are emailed again. */
export function mentionsAddedByEdit(before: MentionItem[], after: MentionItem[]) {
  const seen = new Set(before.map((mention) => `${mention.type}:${mention.id}`));
  return after.filter((mention) => !seen.has(`${mention.type}:${mention.id}`));
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
      : settings.eodDeadline || settings.eodDeadlineTime) || (type === "sod" ? "10:00" : "18:00");
  return zonedDateTimeToDate(date, deadline, getEmployeeTimezone(employee));
}

// Deadlines disabled: Users can submit SOD & EOD reports at any time
export function isReportDeadlinePassed(
  _employee: Employee,
  _type: DailyReportType,
  _date: string,
  _settings: ReportingSettings,
  _now = new Date(),
) {
  return false;
}

export function reportDisplayStatus(input: {
  required: boolean;
  report?: DailyReport | null;
  deadlinePassed: boolean;
}) {
  if (!input.required) return "not_required" as const;
  if (input.report) return "submitted" as const;
  return "not_submitted" as const;
}
