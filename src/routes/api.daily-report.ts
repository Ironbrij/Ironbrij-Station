import { createFileRoute } from "@tanstack/react-router";
import { addCalendarDays } from "@/lib/attendance";
import { buildReportRows } from "@/lib/report-rows";
import { normalizeCompanyId } from "@/lib/company-context";
import { shareHolidays } from "@/lib/holidays";
import { clientEmailsFor } from "@/lib/client-emails";
import { companyClockTimezone } from "@/lib/dst-email";
import { deliverReportEmail, type SendReportInput } from "@/lib/report-email";
import { automationIdToken, createDocument, readDocument } from "@/lib/admin-request";
import {
  dailyReportHistoryId,
  newReportHistoryEntry,
  type ReportHistoryEntry,
} from "@/lib/report-history";
import { buildReportCoverMessage } from "@/lib/report-cover-message";
import { applyReportEdits } from "@/lib/report-edits";
import {
  candidateReportDays,
  dailyReportSubject,
  dayReadiness,
  dayTiming,
  hasAttendanceToReport,
  plannedShifts,
  reportDayLabel,
  DEFAULT_GRACE_MINUTES,
  DEFAULT_MAX_WAIT_MINUTES,
  type Waiting,
} from "@/lib/daily-report";
import {
  isAuthorisedKey,
  listCollection,
  listWithinDates,
  parseRecipients,
  readSavedReportEdits,
  summariseRows,
} from "@/lib/report-automation";
import type {
  Company,
  Department,
  Employee,
  LeaveRequest,
  OvertimeRequest,
  Punch,
} from "@/lib/types";

/**
 * Emails each client their VAs' attendance for the day, once every shift that
 * day has finished.
 *
 * Built for an external scheduler: point it at
 *   POST /api/daily-report
 * with the admin key every 15 minutes. Each run looks at every client that has
 * switched the daily report on, and for each of yesterday and today:
 *
 * - waits while any VA's shift is still running, or they are still clocked in;
 * - sends once they have all finished, with the figures as they are at that moment;
 * - sends after `maxWaitMinutes` anyway if someone never clocked out, with that
 *   marked in the report;
 * - never sends a day twice: the record kept in the report history is how the
 *   next run knows.
 *
 * Reading everything on every run would be wasteful, so a run reads only the
 * schedules first and loads punches only for a day that could be ready.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Status =
  | "sent"
  | "ready"
  | "waiting"
  | "already sent"
  | "nothing to report"
  | "expired"
  | "no recipients"
  | "needs automation login"
  | "failed";

interface DayOutcome {
  companyId: string;
  companyName: string;
  date: string;
  period: string;
  status: Status;
  detail?: string;
  waitingFor?: Waiting[];
  /** The report goes out at this time whatever is still open. */
  sendAnywayAt?: string;
  /** Sent only because the longest wait passed, with people still open. */
  forced?: boolean;
  employees?: number;
  totalHours?: number;
  totalOvertime?: number;
  recipients?: string[];
  historySaved?: boolean;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.max(min, number)) : fallback;
}

async function runDailyReport(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let body: Record<string, unknown> = {};
  if (request.method === "POST") {
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      // A scheduler may POST with no body; the query string still carries the options.
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

  const only = read("companyId").trim();
  const requestedDate = read("date").trim();
  const dryRun = String(read("dryRun")) === "true";
  const force = String(read("force")) === "true";
  const graceMinutes = clamp(read("graceMinutes"), DEFAULT_GRACE_MINUTES, 0, 120);
  const maxWaitMinutes = clamp(read("maxWaitMinutes"), DEFAULT_MAX_WAIT_MINUTES, 0, 720);
  const overrideRecipients = parseRecipients(body.recipients ?? url.searchParams.get("recipients"));

  if (requestedDate && !DATE.test(requestedDate)) {
    return Response.json({ ok: false, error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  if (only === "all") {
    return Response.json(
      {
        ok: false,
        error: "The daily report is sent per client; leave companyId out for every client",
      },
      { status: 400 },
    );
  }

  const now = new Date();
  const [savedCompanies, employees] = await Promise.all([
    listCollection<Company>("companies"),
    listCollection<Employee>("employees"),
  ]);
  const companies = shareHolidays(savedCompanies);

  const targets = companies.filter((company) => {
    if (company.archived || company.status === "archived") return false;
    if (only && normalizeCompanyId(company.id) !== normalizeCompanyId(only)) return false;
    return overrideRecipients.length > 0 || clientEmailsFor(company, "dailyReport").length > 0;
  });
  if (only && targets.length === 0) {
    return Response.json(
      {
        ok: false,
        error: `No client matches "${only}", or it has not switched the daily report on`,
      },
      { status: 404 },
    );
  }

  const plan = targets.map((company) => {
    const timezone = companyClockTimezone(company);
    return {
      company,
      timezone,
      days: requestedDate ? [requestedDate] : candidateReportDays(now, timezone),
    };
  });
  const allDays = plan.flatMap((item) => item.days).sort();
  const firstDay = allDays[0];
  const lastDay = allDays[allDays.length - 1];

  // Whether a day went already, and the record of this one, need the automation's
  // admin login; without it nothing could stop a report repeating every run.
  const idToken = await automationIdToken();

  // Leaves that could still matter: those ending from the day before the first day.
  const leaves = firstDay
    ? await listWithinDates<LeaveRequest>(
        "leaveRequests",
        "dateTo",
        addCalendarDays(firstDay, -1),
        "9999-12-31",
      )
    : [];

  // Everything heavier is read once, and only if a day turns out to be ready.
  let heavy: Promise<{
    allLeaves: LeaveRequest[];
    departments: Department[];
    punches: Punch[];
    overtimeRequests: OvertimeRequest[];
  }> | null = null;
  const loadHeavy = () => {
    heavy ??= Promise.all([
      listCollection<LeaveRequest>("leaveRequests"),
      listCollection<Department>("departments"),
      listWithinDates<Punch>("punches", "attendanceDate", addCalendarDays(firstDay, -1), lastDay),
      listWithinDates<OvertimeRequest>("overtimeRequests", "date", firstDay, lastDay),
    ]).then(([allLeaves, departments, punches, overtimeRequests]) => ({
      allLeaves,
      departments,
      punches,
      overtimeRequests,
    }));
    return heavy;
  };

  const outcomes: DayOutcome[] = [];

  for (const { company, timezone, days } of plan) {
    const companyId = normalizeCompanyId(company.id);
    const companyName = company.name?.trim() || companyId;
    const recipients = overrideRecipients.length
      ? overrideRecipients
      : clientEmailsFor(company, "dailyReport");

    for (const date of days) {
      const outcome = (status: Status, extra: Partial<DayOutcome> = {}): DayOutcome => {
        const result = {
          companyId,
          companyName,
          date,
          period: reportDayLabel(date),
          status,
          ...extra,
        };
        outcomes.push(result);
        return result;
      };

      const planned = plannedShifts({ employees, leaves, company, companyFilter: companyId, date });
      const timing = dayTiming({ planned, date, timezone, graceMinutes, maxWaitMinutes });
      const sendAnywayAt = timing.sendAnywayAt.toISOString();

      if (!force && !requestedDate && now.getTime() > timing.expiresAt.getTime()) {
        outcome("expired", { detail: "Too long after the shifts ended to send by itself" });
        continue;
      }
      // A weekend, holiday or day of leave for everyone: nothing to read, nothing to say.
      // Work on a day off is in the weekly report.
      if (planned.length === 0 && !force) {
        outcome("nothing to report", { detail: "No one is due to work this day" });
        continue;
      }
      // Before the last shift can have ended there is nothing to read.
      if (!force && now.getTime() < timing.settledAt.getTime()) {
        const waitingFor = planned
          .filter((shift) => now.getTime() < shift.endsAt.getTime() + graceMinutes * 60_000)
          .map((shift): Waiting => ({ name: shift.name, reason: "shift not finished" }));
        outcome("waiting", { waitingFor, sendAnywayAt });
        continue;
      }

      const recordId = dailyReportHistoryId(companyId, date);
      if (!force && !dryRun) {
        if (!idToken) {
          outcome("needs automation login", {
            detail:
              "Set AUTOMATION_EMAIL and AUTOMATION_PASSWORD so the daily report can remember what it has sent",
          });
          continue;
        }
        // If this cannot be checked, do not send: a repeat to a client is worse than a late report.
        let already: ReportHistoryEntry | null;
        try {
          already = await readDocument<ReportHistoryEntry>(`reportHistory/${recordId}`, idToken);
        } catch (error) {
          outcome("failed", {
            detail: `Could not check whether this was already sent: ${(error as Error).message}`,
          });
          continue;
        }
        if (already) {
          outcome("already sent", { recipients: already.recipients });
          continue;
        }
      }
      if (recipients.length === 0) {
        outcome("no recipients");
        continue;
      }

      const { allLeaves, departments, punches, overtimeRequests } = await loadHeavy();
      const calculated = buildReportRows({
        employees,
        punches,
        leaves: allLeaves,
        overtimeRequests: overtimeRequests.filter((item) => item.date === date),
        departments,
        companies,
        companyFilter: companyId,
        fallbackCompany: company,
        from: date,
        to: date,
        now,
      });
      const saved = await readSavedReportEdits(companyId, date, date);
      const rows = saved.edits ? applyReportEdits(calculated, saved.edits) : calculated;

      const readiness = dayReadiness({
        planned,
        rows,
        date,
        timezone,
        now,
        graceMinutes,
        maxWaitMinutes,
      });
      if (!force && !readiness.ready) {
        outcome("waiting", {
          waitingFor: readiness.waitingFor,
          sendAnywayAt: readiness.timing.sendAnywayAt.toISOString(),
        });
        continue;
      }
      if (!hasAttendanceToReport(rows)) {
        outcome("nothing to report", { detail: "No one worked and no one was absent" });
        continue;
      }

      const summary = summariseRows(rows);
      const figures = {
        employees: summary.totalEmployees,
        totalHours: Math.round(summary.totalHours * 10) / 10,
        totalOvertime: Math.round(summary.totalOvertime * 10) / 10,
      };
      if (dryRun) {
        outcome("ready", {
          ...figures,
          recipients,
          forced: readiness.forced,
          waitingFor: readiness.waitingFor,
        });
        continue;
      }

      const report: SendReportInput = {
        companyId,
        recipientEmails: recipients,
        // The same subject every day, so the client's daily reports share one thread.
        subject: dailyReportSubject(companyName),
        customMessage: buildReportCoverMessage({
          clientName: companyName,
          from: date,
          to: date,
          rows,
        }),
        companyName,
        clientName: companyName,
        periodLabel: reportDayLabel(date),
        periodFrom: date,
        periodTo: date,
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
        outcome("failed", { detail: delivery.error, recipients });
        continue;
      }

      // Kept under the day's own id, which is what stops the next run sending it again.
      let historySaved = false;
      if (idToken) {
        const entry = newReportHistoryEntry({
          report,
          recipients: delivery.recipients ?? recipients,
          sentBy: "Daily automation",
          source: "automation",
          now,
        });
        const id = force ? `${recordId}-${now.getTime()}` : recordId;
        // One retry: a record that is not saved means the next run sends the day again.
        for (let attempt = 0; attempt < 2 && !historySaved; attempt += 1) {
          historySaved = await createDocument("reportHistory", id, { ...entry }, idToken)
            .then(() => true)
            .catch(() => false);
        }
      }
      outcome("sent", {
        ...figures,
        recipients: delivery.recipients ?? recipients,
        forced: readiness.forced,
        waitingFor: readiness.forced ? readiness.waitingFor : undefined,
        historySaved,
        ...(idToken || force ? {} : { detail: "Not recorded: the automation login is not set" }),
      });
    }
  }

  const failed = outcomes.some((item) => item.status === "failed");
  return Response.json(
    {
      ok: !failed,
      now: now.toISOString(),
      sent: outcomes.filter((item) => item.status === "sent").length,
      reports: outcomes,
    },
    { status: failed ? 502 : 200 },
  );
}

export const Route = createFileRoute("/api/daily-report")({
  server: {
    handlers: {
      GET: ({ request }) => runDailyReport(request),
      POST: ({ request }) => runDailyReport(request),
    },
  },
});
