import { createFileRoute } from "@tanstack/react-router";
import { buildReportRows, type ReportRow } from "@/lib/report-rows";
import { resolveReportWeek } from "@/lib/weekly-report";
import { normalizeCompanyId } from "@/lib/company-context";
import { deliverReportEmail } from "@/lib/report-email";
import { fromFirestoreFields, type FirestoreValue } from "@/lib/firestore-rest";
import { applyReportEdits, readReportEdits, reportEditsDocId } from "@/lib/report-edits";
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

function getFirestoreConfig() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "ironbrij-timestation";
  const apiKey =
    process.env.VITE_FIREBASE_API_KEY || "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw";
  return {
    apiKey,
    baseUrl: `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`,
  };
}

/** Reads a whole collection, following Firestore's paging. */
async function listCollection<T>(collection: string, pageLimit = 40): Promise<T[]> {
  const { baseUrl, apiKey } = getFirestoreConfig();
  const out: T[] = [];
  let pageToken = "";
  for (let page = 0; page < pageLimit; page += 1) {
    const url = new URL(`${baseUrl}/${collection}`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Could not read ${collection}: ${response.status}`);
    }
    const data = (await response.json()) as {
      documents?: { name: string; fields?: Record<string, FirestoreValue> }[];
      nextPageToken?: string;
    };
    for (const document of data.documents || []) {
      out.push({
        ...fromFirestoreFields(document.fields),
        id: document.name.split("/").pop(),
      } as T);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

/**
 * Documents whose date field falls within a period. Punches and overtime grow
 * every day, so the period is pushed down to Firestore rather than reading the
 * whole collection on every run.
 */
async function listWithinDates<T>(
  collectionId: string,
  field: string,
  from: string,
  to: string,
): Promise<T[]> {
  const { baseUrl, apiKey } = getFirestoreConfig();
  const response = await fetch(`${baseUrl}:runQuery?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: field },
                  op: "GREATER_THAN_OR_EQUAL",
                  value: { stringValue: from },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: field },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { stringValue: to },
                },
              },
            ],
          },
        },
        limit: 5000,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not read ${collectionId}: ${response.status}`);
  }
  const rows = (await response.json()) as {
    document?: { name: string; fields?: Record<string, FirestoreValue> };
  }[];
  return rows
    .filter((row) => row.document)
    .map(
      (row) =>
        ({
          ...fromFirestoreFields(row.document!.fields),
          id: row.document!.name.split("/").pop(),
        }) as T,
    );
}

/**
 * The edits an admin saved on the Reports page for this company and period, if
 * any. The emailed report lays them over the calculated rows exactly as the
 * screen does, so a client never receives numbers that differ from it.
 */
async function readSavedReportEdits(companyFilter: string, from: string, to: string) {
  const { baseUrl, apiKey } = getFirestoreConfig();
  const response = await fetch(
    `${baseUrl}/reportEdits/${encodeURIComponent(reportEditsDocId(companyFilter, from, to))}?key=${encodeURIComponent(apiKey)}`,
  );
  if (response.status === 404) return { edits: null, readable: true };
  if (!response.ok) return { edits: null, readable: false };
  const data = (await response.json()) as { fields?: Record<string, FirestoreValue> };
  return { edits: readReportEdits(fromFirestoreFields(data.fields)), readable: true };
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseRecipients(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\s]+/)
      : [];
  return [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(validEmail))];
}

/**
 * The master key, or any active key minted on the MCP Connect page. A scheduler
 * is configured with a minted key, and rejecting those made the automation fail
 * at its first call.
 */
async function isAuthorisedKey(token: string): Promise<boolean> {
  if (!token || token.length < 20) return false;
  const masterKey =
    process.env.ADMIN_API_KEY || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
  if (token === masterKey) return true;
  const { baseUrl, apiKey } = getFirestoreConfig();
  const response = await fetch(
    `${baseUrl}/adminApiTokens/${encodeURIComponent(token)}?key=${encodeURIComponent(apiKey)}`,
  );
  if (!response.ok) return false;
  const data = (await response.json()) as { fields?: Record<string, FirestoreValue> };
  return fromFirestoreFields(data.fields).active !== false;
}

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

function summarise(rows: ReportRow[]) {
  return rows.reduce(
    (acc, row) => ({
      totalHours: acc.totalHours + (Number(row.regularHours) || 0),
      totalOvertime: acc.totalOvertime + (Number(row.overtimeHours) || 0),
      totalPaidLeave: acc.totalPaidLeave + (Number(row.paidLeaveDays) || 0),
      totalUnpaidLeave: acc.totalUnpaidLeave + (Number(row.unpaidLeaveDays) || 0),
      totalEmployees: acc.totalEmployees + 1,
    }),
    {
      totalHours: 0,
      totalOvertime: 0,
      totalPaidLeave: 0,
      totalUnpaidLeave: 0,
      totalEmployees: 0,
    },
  );
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

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const token =
    request.headers.get("x-admin-key")?.trim() || bearer || read("token").trim() || "";
  if (!(await isAuthorisedKey(token))) {
    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  }

  const wantsList = String(read("list")) === "true";
  const requestedCompany = (read("companyId") || "all").trim();
  const weeksAgo = Math.max(0, Math.min(52, Number(read("weeksAgo")) || 0));
  const dryRun = String(read("dryRun")) === "true";
  const overrideRecipients = parseRecipients(body.recipients ?? url.searchParams.get("recipients"));

  const [companies, employees, departments, leaves] = await Promise.all([
    listCollection<Company>("companies"),
    listCollection<Employee>("employees"),
    listCollection<Department>("departments"),
    listCollection<LeaveRequest>("leaveRequests"),
  ]);

  // A scheduler asks which clients to send for, so adding a client never means
  // editing the schedule: configure recipients and it joins the next run.
  if (wantsList) {
    const main = companies.find((item) => item.isMain) || companies[0] || null;
    const targets = companies
      .filter((item) => !item.archived && item.status !== "archived")
      .map((item) => ({
        companyId: normalizeCompanyId(item.id),
        companyName: item.name,
        recipients: parseRecipients(
          (item as unknown as Record<string, unknown>).weeklyReportRecipients,
        ),
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
  const configured = parseRecipients(
    isAll
      ? (company as unknown as Record<string, unknown>)?.weeklyReportAllRecipients
      : (company as unknown as Record<string, unknown>)?.weeklyReportRecipients,
  );
  const recipients = overrideRecipients.length ? overrideRecipients : configured;
  const summary = summarise(rows);

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
  const delivery = await deliverReportEmail(
    {
      recipientEmails: recipients,
      subject: `${companyName} weekly report (${week.label})`,
      customMessage: `Automated weekly report covering ${week.label}.`,
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
    },
    "automation@savytimes",
  );

  if (!delivery.ok) {
    return Response.json(
      { ...result, ok: false, skippedReason: `delivery failed: ${delivery.error}` },
      { status: delivery.status >= 400 ? delivery.status : 502 },
    );
  }

  return Response.json({ ...result, sent: true });
}

export const Route = createFileRoute("/api/weekly-report")({
  server: {
    handlers: {
      GET: ({ request }) => runWeeklyReport(request),
      POST: ({ request }) => runWeeklyReport(request),
    },
  },
});
