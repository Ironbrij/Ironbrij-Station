import { createFileRoute } from "@tanstack/react-router";
import { buildReportRows } from "@/lib/report-rows";
import { resolveReportWeek } from "@/lib/weekly-report";
import { normalizeCompanyId } from "@/lib/company-context";
import { shareHolidays } from "@/lib/holidays";
import { clientEmailsFor } from "@/lib/client-emails";
import { weeklyReportSubject, deliverReportEmail, type SendReportInput } from "@/lib/report-email";
import { automationIdToken, createDocument } from "@/lib/admin-request";
import { newReportHistoryEntry, reportHistoryId } from "@/lib/report-history";
import { buildReportCoverMessage } from "@/lib/report-cover-message";
import { applyReportEdits } from "@/lib/report-edits";
import {
  isAuthorisedKey,
  listCollection,
  listWithinDates,
  parseRecipients,
  readSavedReportEdits,
  summariseRows,
} from "@/lib/report-automation";
import { COMPANY_ID } from "@/lib/types";
import type {
  Company,
  Department,
  Employee,
  LeaveRequest,
  OvertimeRequest,
  Punch,
} from "@/lib/types";

/**
 * Sends one client's Monday-to-Friday report by email.
 *
 * Built for an external scheduler: point a cron at
 *   POST /api/weekly-report?companyId=<id|all>
 * with the admin key, once a week. The window is resolved from the run time, so
 * the caller never has to work out dates, and `weeksAgo` replays a missed send.
 */

export interface WeeklyReportResult {
  ok: boolean;
  companyId: string;
  companyName: string;
  period: string;
  from: string;
  to: string;
  employees: number;
  totalHours: number;
  totalOvertime: number;
  recipients: string[];
  sent: boolean;
  /** Whether an admin's saved edits to this week's report were laid over it. */
  editsApplied?: boolean;
  warning?: string;
  skippedReason?: string;
}

async function runWeeklyReport(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // A cron may POST with no body; the query string still carries the options.
    }
  }
  const read = (name: string) =>
    (body[name] as string | undefined) ?? url.searchParams.get(name) ?? "";

  const bearer = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  const token = request.headers.get("x-admin-key")?.trim() || bearer || read("token").trim() || "";
  if (!(await isAuthorisedKey(token))) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const wantsList = String(read("list")) === "true";
  const requestedCompany = (read("companyId") || "all").trim();
  const weeksAgo = Math.max(0, Math.min(52, Number(read("weeksAgo")) || 0));
  const dryRun = String(read("dryRun")) === "true";
  const overrideRecipients = parseRecipients(body.recipients ?? url.searchParams.get("recipients"));

  const [savedCompanies, employees, departments, leaves] = await Promise.all([
    listCollection<Company>("companies"),
    listCollection<Employee>("employees"),
    listCollection<Department>("departments"),
    listCollection<LeaveRequest>("leaveRequests"),
  ]);
  // Holidays are saved on the main company; every client's report reads them.
  const companies = shareHolidays(savedCompanies);

  // A scheduler asks which clients to send for, so adding a client never means
  // editing the schedule: configure recipients and it joins the next run.
  if (wantsList) {
    const main = companies.find((item) => item.isMain) || companies[0] || null;
    const targets = companies
      .filter((item) => !item.archived && item.status !== "archived")
      .map((item) => ({
        companyId: normalizeCompanyId(item.id),
        companyName: item.name,
        recipients: clientEmailsFor(item, "weeklyReport"),
      }))
      .filter((item) => item.recipients.length > 0);
    const allRecipients = parseRecipients(
      (main as unknown as Record<string, unknown> | null)?.weeklyReportAllRecipients,
    );
    if (allRecipients.length > 0) {
      targets.push({
        companyId: "all",
        companyName: "All Companies",
        recipients: allRecipients,
      });
    }
    return Response.json({ ok: true, count: targets.length, targets });
  }

  const isAll = requestedCompany === "all";
  const company = isAll
    ? companies.find((item) => item.isMain) || companies[0] || null
    : companies.find(
        (item) => normalizeCompanyId(item.id) === normalizeCompanyId(requestedCompany),
      ) || null;

  if (!isAll && !company) {
    return Response.json(
      { ok: false, error: `No company matches "${requestedCompany}"` },
      { status: 404 },
    );
  }

  const timezone = company?.timezone || "Australia/Sydney";
  const week = resolveReportWeek(new Date(), timezone, weeksAgo);
  const [punches, overtimeRequests] = await Promise.all([
    listWithinDates<Punch>("punches", "attendanceDate", week.from, week.to),
    listWithinDates<OvertimeRequest>("overtimeRequests", "date", week.from, week.to),
  ]);

  const companyFilter = isAll ? "all" : normalizeCompanyId(requestedCompany);
  const calculatedRows = buildReportRows({
    employees,
    punches,
    leaves,
    overtimeRequests,
    departments,
    companies,
    companyFilter,
    fallbackCompany: company,
    from: week.from,
    to: week.to,
  });
  const saved = await readSavedReportEdits(companyFilter, week.from, week.to);
  const rows = saved.edits ? applyReportEdits(calculatedRows, saved.edits) : calculatedRows;

  const companyName = isAll ? "All Companies" : company?.name || requestedCompany;
  const configured = isAll
    ? parseRecipients((company as unknown as Record<string, unknown>)?.weeklyReportAllRecipients)
    : clientEmailsFor(company, "weeklyReport");
  const recipients = overrideRecipients.length ? overrideRecipients : configured;
  const summary = summariseRows(rows);

  const result: WeeklyReportResult = {
    ok: true,
    companyId: isAll ? "all" : normalizeCompanyId(requestedCompany) || COMPANY_ID,
    companyName,
    period: week.label,
    from: week.from,
    to: week.to,
    employees: summary.totalEmployees,
    totalHours: Math.round(summary.totalHours * 10) / 10,
    totalOvertime: Math.round(summary.totalOvertime * 10) / 10,
    recipients,
    sent: false,
    editsApplied: Boolean(saved.edits),
    // Firestore rules keep report edits to signed-in admins, and this route
    // reads without a user. Say so rather than silently sending other figures.
    ...(saved.readable
      ? {}
      : { warning: "Saved report edits could not be read; calculated figures were used." }),
  };

  if (dryRun) {
    return Response.json({ ...result, skippedReason: "dryRun", rows });
  }

  if (recipients.length === 0) {
    return Response.json({ ...result, skippedReason: "no recipients configured" });
  }
  if (rows.length === 0) {
    return Response.json({ ...result, skippedReason: "no attendance in this week" });
  }

  // The same renderer and workflow as the report screen's Send button, called
  // directly: this endpoint has already authenticated the scheduler.
  const report: SendReportInput = {
    companyId: isAll ? "all" : normalizeCompanyId(requestedCompany) || COMPANY_ID,
    recipientEmails: recipients,
    // The same subject every week, so the client's reports share one thread.
    subject: weeklyReportSubject(isAll ? "" : companyName),
    // The same letter an admin gets pre-written on the report screen.
    customMessage: buildReportCoverMessage({
      clientName: isAll ? "" : companyName,
      from: week.from,
      to: week.to,
      rows,
    }),
    companyName,
    clientName: isAll ? "" : companyName,
    periodLabel: week.label,
    periodFrom: week.from,
    periodTo: week.to,
    summary,
    rows: rows.map((row) => ({
      employeeName: row.employeeName,
      employeeEmail: row.employeeEmail,
      role: row.role,
      department: row.department,
      client: row.client,
      status: row.status,
      hoursPerDay: row.hoursPerDay,
      workedDays: row.workedDays,
      regularHours: row.regularHours,
      overtimeHours: row.overtimeHours,
      overtimeDates: row.overtimeDates,
      paidLeaveDays: row.paidLeaveDays,
      unpaidLeaveDays: row.unpaidLeaveDays,
      paidLeaveUsed: row.paidLeaveUsed,
      unpaidLeaveUsed: row.unpaidLeaveUsed,
      availableLeaveCredit: row.availableLeaveCredit,
      remarks: row.remarks,
    })),
  };
  const delivery = await deliverReportEmail(report, "automation@savytimes");

  if (!delivery.ok) {
    return Response.json(
      { ...result, ok: false, skippedReason: `delivery failed: ${delivery.error}` },
      { status: delivery.status >= 400 ? delivery.status : 502 },
    );
  }

  // Kept in the report history when the automation has a login to save with.
  const idToken = await automationIdToken();
  let historySaved = false;
  if (idToken) {
    const now = new Date();
    const entry = newReportHistoryEntry({
      report,
      recipients: delivery.recipients ?? recipients,
      sentBy: "Weekly automation",
      source: "automation",
      now,
    });
    historySaved = await createDocument(
      "reportHistory",
      reportHistoryId(entry.companyId, entry.from, now),
      { ...entry },
      idToken,
    )
      .then(() => true)
      .catch(() => false);
  }

  return Response.json({
    ...result,
    sent: true,
    historySaved,
    ...(idToken
      ? {}
      : {
          historyNote:
            "Set AUTOMATION_EMAIL and AUTOMATION_PASSWORD to keep automated reports in the history.",
        }),
  });
}

export const Route = createFileRoute("/api/weekly-report")({
  server: {
    handlers: {
      GET: ({ request }) => runWeeklyReport(request),
      POST: ({ request }) => runWeeklyReport(request),
    },
  },
});
