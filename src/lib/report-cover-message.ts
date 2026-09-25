import { formatAmount, formatHours, formatLongPeriod } from "./report-format.ts";

/** The figures the cover message reads from each report row. */
export interface CoverMessageRow {
  employeeName: string;
  /** Length of a working day, to show leave in days and hours. Defaults to 8. */
  hoursPerDay?: number;
  regularHours: number;
  overtimeHours: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  /** Leave as typed or calculated, "2.5 Days (20 hours)". */
  paidLeaveUsed?: string;
  unpaidLeaveUsed?: string;
  availableLeaveCredit?: string | null;
}

export interface CoverMessageInput {
  /** Who the greeting is to; "Hi there," when blank. */
  clientName?: string;
  /** First and last day covered, YYYY-MM-DD. */
  from: string;
  to: string;
  rows: CoverMessageRow[];
  signOff?: string;
}

/** "4 days (32 hours)", "1 day (8 hours)", "0 days (0 hours)". */
function daysAndHours(days: number, hoursPerDay: number): string {
  const amount = formatAmount(days);
  return `${amount} ${amount === "1" || amount === "-1" ? "day" : "days"} (${formatHours(
    days * hoursPerDay,
  )})`;
}

/**
 * The figure the report table shows for a leave column, in the letter's
 * lowercase. A blank or bare "0" reads in full, "0 days (0 hours)".
 */
function leaveText(typed: string | null | undefined, days: number, hoursPerDay: number): string {
  const text = typed?.trim();
  if (!text || /^-?0+(\.0+)?$/.test(text)) return daysAndHours(days, hoursPerDay);
  return text.replace(/\bDays?\b/g, (word) => word.toLowerCase());
}

function vaSummary(row: CoverMessageRow): string {
  const hoursPerDay = row.hoursPerDay && row.hoursPerDay > 0 ? row.hoursPerDay : 8;
  const paidDays = Number(row.paidLeaveDays) || 0;
  const unpaidDays = Number(row.unpaidLeaveDays) || 0;
  return [
    `VA Name: ${row.employeeName}`,
    "",
    `Total Regular Hours: ${formatHours(Number(row.regularHours) || 0)}`,
    `Overtime: ${formatHours(Number(row.overtimeHours) || 0)}`,
    `Paid Leave Used: ${leaveText(row.paidLeaveUsed, paidDays, hoursPerDay)}`,
    `Unpaid Leave Used: ${leaveText(row.unpaidLeaveUsed, unpaidDays, hoursPerDay)}`,
    `Available Leave Credit: ${leaveText(row.availableLeaveCredit, 0, hoursPerDay)}`,
  ].join("\n");
}

/**
 * The letter that opens a report email, written from the report's own rows so
 * its figures always match the table under it. One summary per VA.
 */
export function buildReportCoverMessage({
  clientName,
  from,
  to,
  rows,
  signOff = "Accounts Team",
}: CoverMessageInput): string {
  const summaries = rows.length
    ? rows.map(vaSummary)
    : ["No attendance was recorded for this period."];
  return [
    `Hi ${clientName?.trim() || "there"},`,
    "I hope you’re doing well.",
    `Please see below the attendance summary for ${formatLongPeriod(from, to)}.`,
    "Attendance Summary",
    ...summaries,
    "The detailed attendance, overtime, leave records, and remarks are included in the report below for your reference.",
    "If you have any questions or need any additional information, please feel free to reach out.",
    "Thank you, and have a great day!",
    `Best regards,\n${signOff}`,
  ].join("\n\n");
}
