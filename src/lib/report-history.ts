import type { SendReportInput } from "./report-email.ts";

/**
 * Every attendance report that went out, kept as it was sent: the figures, the
 * note and who it went to. The email is rebuilt from these when opened, so a
 * past report reads the same even after punches or edits change later.
 */

export interface ReportHistoryEntry {
  /** The company the report was for, or "all" for the all-clients report. */
  companyId: string;
  companyName: string;
  subject: string;
  periodLabel: string;
  /** First and last day covered, YYYY-MM-DD. */
  from: string;
  to: string;
  recipients: string[];
  /** Who sent it: an admin's email, "Weekly automation" or "Daily automation". */
  sentBy: string;
  sentAt: string;
  source: "screen" | "automation";
  totalEmployees: number;
  totalHours: number;
  totalOvertime: number;
  /** Everything needed to show the email again. */
  report: SendReportInput;
}

/** A readable id, unique per send: "acme-2026-10-05-1759900000000". */
export function reportHistoryId(companyId: string, from: string, sentAt: Date): string {
  const safe = (companyId || "all").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return `${safe}-${from || "period"}-${sentAt.getTime()}`;
}

/**
 * One id per client per day for the daily report, so the record that it went
 * out is also how the next run knows not to send it again.
 */
export function dailyReportHistoryId(companyId: string, date: string): string {
  const safe = (companyId || "all").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  return `daily-${safe}-${date}`;
}

export function newReportHistoryEntry({
  report,
  recipients,
  sentBy,
  source,
  now = new Date(),
}: {
  report: SendReportInput;
  recipients: string[];
  sentBy: string;
  source: ReportHistoryEntry["source"];
  now?: Date;
}): ReportHistoryEntry {
  const companyName = report.companyName || report.company?.name || "Company";
  return {
    companyId: report.companyId || "all",
    companyName,
    subject:
      report.subject?.trim() || `${companyName} Attendance & Hours Report (${report.periodLabel})`,
    periodLabel: report.periodLabel,
    from: report.periodFrom || "",
    to: report.periodTo || "",
    recipients,
    sentBy,
    sentAt: now.toISOString(),
    source,
    totalEmployees: report.summary.totalEmployees,
    totalHours: Math.round(report.summary.totalHours * 100) / 100,
    totalOvertime: Math.round(report.summary.totalOvertime * 100) / 100,
    // The recipient list is kept on the entry; the rest is what the email showed.
    report: { ...report, recipientEmails: recipients },
  };
}
