import type { CompanyEmailBranding } from "./email-branding";
import { escapeEmailHtml, renderCompanyEmail } from "./email-template";
import { formatAmount, formatCovered, formatDaysAndHours } from "./report-format";

export interface ReportEmployeeRowPayload {
  employeeName: string;
  employeeEmail?: string;
  role?: string;
  department?: string;
  /** Who the work was for; the report's client name is used when absent. */
  client?: string;
  /** "active" or "inactive". */
  status?: string;
  /** Length of a working day, to show leave in days and hours. Defaults to 8. */
  hoursPerDay?: number;
  workedDays?: number;
  regularHours: number;
  overtimeHours: number;
  overtimeDates?: string[];
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  /** Paid leave credit left, as typed or calculated: "7.54 Days (60.32 hours)". */
  availableLeaveCredit?: string | null;
  remarks?: string;
}

export interface SendReportInput {
  recipientEmails: string[];
  subject: string;
  customMessage?: string;
  company?: CompanyEmailBranding;
  companyName?: string;
  clientName?: string;
  periodLabel: string;
  /** First and last day covered, YYYY-MM-DD, for the Covered column. */
  periodFrom?: string;
  periodTo?: string;
  summary: {
    totalHours: number;
    totalOvertime: number;
    totalPaidLeave: number;
    totalUnpaidLeave: number;
    totalEmployees: number;
  };
  rows: ReportEmployeeRowPayload[];
}

// The client sheet's colours: navy over who, teal over the figures.
const NAVY = "#2f4677";
const TEAL = "#138f8f";
const NAVY_TINT = ["#f1f4fa", "#e6ebf5"];
const TEAL_TINT = ["#eef8f7", "#e0f1ef"];
const BORDER = "1px solid #cfd8e3";

/** "5.51 Days (44.12 hours)" as the sheet shows it: the hours under the days. */
function daysOverHours(value: string): string {
  const safe = escapeEmailHtml(value);
  const split = safe.indexOf(" (");
  return split > 0 ? `${safe.slice(0, split)}<br>${safe.slice(split + 1)}` : safe;
}

/** Section titles such as "Paid Leave:" in bold, one dated line under each. */
function renderRemarks(remarks: string | undefined): string {
  if (!remarks?.trim()) return '<span style="color: #94a3b8;">—</span>';
  return remarks
    .trim()
    .split("\n")
    .map((line) => {
      const text = line.trim();
      if (!text) return '<div style="height: 8px; line-height: 8px;">&nbsp;</div>';
      const weight = text.endsWith(":") ? "font-weight: 700;" : "";
      return `<div style="${weight}">${escapeEmailHtml(text)}</div>`;
    })
    .join("");
}

function renderReportHtmlTable(rows: ReportEmployeeRowPayload[], covered: string, client: string) {
  const th = (label: string, color: string) =>
    `<th style="padding: 9px 8px; background-color: ${color}; color: #ffffff; font-size: 11px; line-height: 14px; font-weight: 700; text-align: center; border: ${BORDER};">${label}</th>`;

  const rowHtml = rows
    .map((row, index) => {
      const navy = NAVY_TINT[index % 2];
      const teal = TEAL_TINT[index % 2];
      const cell = (content: string, background: string, align = "center", extra = "") =>
        `<td style="padding: 8px; background-color: ${background}; color: #1e293b; font-size: 12px; line-height: 17px; text-align: ${align}; vertical-align: middle; border: ${BORDER};${extra}">${content}</td>`;

      const hoursPerDay = row.hoursPerDay && row.hoursPerDay > 0 ? row.hoursPerDay : 8;
      const isActive = (row.status || "active") !== "inactive";
      const statusHtml = `<span style="display: inline-block; padding: 2px 10px; border-radius: 4px; background-color: ${
        isActive ? "#1f8f45" : "#94a3b8"
      }; color: #ffffff; font-size: 11px; font-weight: 700;">${isActive ? "Active" : "Inactive"}</span>`;

      const credit = row.availableLeaveCredit?.trim() || "";
      const creditHtml = credit
        ? `<span style="font-weight: 700; color: ${credit.startsWith("-") ? "#dc2626" : "#1e293b"};">${daysOverHours(credit)}</span>`
        : '<span style="color: #94a3b8;">—</span>';

      return `<tr>
        ${cell(escapeEmailHtml(row.employeeName), navy, "left", " font-weight: 700;")}
        ${cell(escapeEmailHtml(row.client?.trim() || client || "—"), navy, "left", " font-weight: 600;")}
        ${cell(statusHtml, navy)}
        ${cell(escapeEmailHtml(covered), teal, "center", " font-weight: 600; white-space: nowrap;")}
        ${cell(formatAmount(row.regularHours), teal, "center", " font-weight: 700;")}
        ${cell(formatAmount(row.overtimeHours), teal, "center", " font-weight: 700;")}
        ${cell(creditHtml, teal)}
        ${cell(daysOverHours(formatDaysAndHours(row.paidLeaveDays, hoursPerDay)), teal, "center", " font-weight: 600;")}
        ${cell(daysOverHours(formatDaysAndHours(row.unpaidLeaveDays, hoursPerDay)), teal, "center", " font-weight: 600;")}
        ${cell(renderRemarks(row.remarks), teal, "left", " min-width: 190px;")}
      </tr>`;
    })
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; border-collapse: collapse; margin-top: 12px; font-family: Arial, Helvetica, sans-serif;">
    <thead>
      <tr>
        ${th("VA Name", NAVY)}
        ${th("Client", NAVY)}
        ${th("Status", NAVY)}
        ${th("Covered", TEAL)}
        ${th("No. of Hours Worked", TEAL)}
        ${th("Overtime Hours", TEAL)}
        ${th("Leave Credits Available", TEAL)}
        ${th("Paid Leave Used", TEAL)}
        ${th("Unpaid Leave Used", TEAL)}
        ${th("Remarks", TEAL)}
      </tr>
    </thead>
    <tbody>
      ${rowHtml}
    </tbody>
  </table>`;
}

export interface ReportDeliveryResult {
  ok: boolean;
  status: number;
  recipientCount?: number;
  error?: string;
}

/**
 * Renders an attendance report and hands it to the report email workflow.
 *
 * The Reports screen's Send button and the weekly automation both call this
 * directly. The automation used to reach it over HTTP, which meant passing a
 * credential that endpoint did not accept, plus a request to its own origin.
 */
export async function deliverReportEmail(
  body: SendReportInput,
  authenticatedEmail: string,
): Promise<ReportDeliveryResult> {
  const validEmails = body.recipientEmails
    .map((e) => e.trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

  if (validEmails.length === 0) {
    return { ok: false, error: "No valid recipient email addresses provided", status: 400 };
  }

  const companyName = body.companyName || body.company?.name || "SavyTimes";
  const periodLabel = body.periodLabel || "Recent Period";
  const subject =
    body.subject?.trim() || `${companyName} Attendance & Hours Report (${periodLabel})`;

  // Build Email HTML
  const covered =
    body.periodFrom && body.periodTo ? formatCovered(body.periodFrom, body.periodTo) : periodLabel;
  const tableHtml = renderReportHtmlTable(body.rows || [], covered, body.clientName?.trim() || "");
  const summaryStatsHtml = `
      <div style="display: table; width: 100%; margin: 16px 0; background-color: #f1f5f9; border-radius: 8px; padding: 14px; box-sizing: border-box;">
        <div style="display: table-row;">
          <div style="display: table-cell; padding: 6px; text-align: center;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Team Members</div>
            <div style="font-size: 18px; font-weight: 800; color: #0f172a;">${body.summary.totalEmployees}</div>
          </div>
          <div style="display: table-cell; padding: 6px; text-align: center;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Regular Hours</div>
            <div style="font-size: 18px; font-weight: 800; color: #0284c7;">${body.summary.totalHours.toFixed(1)}h</div>
          </div>
          <div style="display: table-cell; padding: 6px; text-align: center;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Overtime</div>
            <div style="font-size: 18px; font-weight: 800; color: #d97706;">${body.summary.totalOvertime.toFixed(1)}h</div>
          </div>
          <div style="display: table-cell; padding: 6px; text-align: center;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Paid Leave Used</div>
            <div style="font-size: 18px; font-weight: 800; color: #16a34a;">${formatAmount(body.summary.totalPaidLeave)}d</div>
          </div>
          <div style="display: table-cell; padding: 6px; text-align: center;">
            <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Unpaid Leave Used</div>
            <div style="font-size: 18px; font-weight: 800; color: #dc2626;">${formatAmount(body.summary.totalUnpaidLeave)}d</div>
          </div>
        </div>
      </div>
    `;

  const customMessageHtml = body.customMessage?.trim()
    ? `<div style="margin: 16px 0; padding: 14px 18px; background-color: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 4px;">
          <div style="font-size: 12px; font-weight: 700; color: #1e40af; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.04em;">Note from Administrator</div>
          <div style="font-size: 14px; line-height: 22px; color: #1e3a8a; white-space: pre-wrap;">${escapeEmailHtml(
            body.customMessage,
          )}</div>
        </div>`
    : "";

  const clientGreeting = body.clientName
    ? `Report prepared for <strong>${escapeEmailHtml(body.clientName)}</strong> · `
    : "";

  const html = renderCompanyEmail({
    company: body.company || { name: companyName },
    preheader: `Work and attendance report for ${companyName} (${periodLabel})`,
    label: "Attendance Report",
    title: `${companyName} Summary`,
    introHtml: `${clientGreeting}Period: <strong>${escapeEmailHtml(periodLabel)}</strong>`,
    // Ten columns, as in the client sheet, do not fit a letter-width card.
    maxWidth: 1180,
    contentHtml: `
        ${customMessageHtml}
        ${summaryStatsHtml}
        <div style="margin-top: 20px;">
          <h3 style="margin: 0 0 8px; font-size: 15px; font-weight: 700; color: #0f172a;">Team Work Hours & Activity Breakdown</h3>
          ${tableHtml}
        </div>
        <p style="margin-top: 24px; font-size: 12px; color: #64748b; line-height: 18px;">
          This report includes verified regular work hours, tracked overtime sessions with specific dates, and approved leave records. Leave credits available are the paid leave credits for the year, less paid leave taken up to the end of this period.
        </p>
      `,
  });

  // Plaintext fallback
  const plaintext = `Work & Attendance Report - ${companyName} (${periodLabel})
  Sender: ${authenticatedEmail}
  Total Team Members: ${body.summary.totalEmployees}
  Total Regular Hours: ${body.summary.totalHours.toFixed(1)}h
  Total Overtime: ${body.summary.totalOvertime.toFixed(1)}h
  Paid Leave Used: ${formatAmount(body.summary.totalPaidLeave)}d | Unpaid Leave Used: ${formatAmount(
    body.summary.totalUnpaidLeave,
  )}d

  ${body.customMessage ? `Note: ${body.customMessage}\n\n` : ""}
  Breakdown:
  ${body.rows
    .map((r) => {
      const hoursPerDay = r.hoursPerDay && r.hoursPerDay > 0 ? r.hoursPerDay : 8;
      return [
        `- ${r.employeeName} (${r.client?.trim() || body.clientName || "No client"}, ${
          r.status === "inactive" ? "Inactive" : "Active"
        })`,
        `  Covered: ${covered}`,
        `  No. of Hours Worked: ${formatAmount(r.regularHours)}`,
        `  Overtime Hours: ${formatAmount(r.overtimeHours)}`,
        `  Leave Credits Available: ${r.availableLeaveCredit?.trim() || "-"}`,
        `  Paid Leave Used: ${formatDaysAndHours(r.paidLeaveDays, hoursPerDay)}`,
        `  Unpaid Leave Used: ${formatDaysAndHours(r.unpaidLeaveDays, hoursPerDay)}`,
        r.remarks?.trim() ? `  Remarks:\n    ${r.remarks.trim().replace(/\n/g, "\n    ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n")}`;

  // Reports have their own workflow. Falling back to the leave webhook sent
  // every report to a workflow that cannot render one, which looked like
  // reports simply never arriving.
  const webhookUrl =
    process.env.N8N_REPORT_WEBHOOK_URL ||
    "https://vmi3182726.contaboserver.net/webhook/time-station-report-email";

  try {
    const webhookResponse = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "company_report_email",
        senderEmail: authenticatedEmail,
        recipientEmails: validEmails,
        companyName,
        clientName: body.clientName || "",
        periodLabel,
        summary: body.summary,
        rows: body.rows,
        email: {
          to: validEmails.join(", "),
          subject,
          text: plaintext,
          html,
        },
      }),
    });

    if (!webhookResponse.ok) {
      return {
        ok: false,
        error: `Report delivery service returned status ${webhookResponse.status}`,
        status: 502,
      };
    }
  } catch (fetchError) {
    return {
      ok: false,
      error:
        fetchError instanceof Error ? fetchError.message : "Failed to connect to email service",
      status: 500,
    };
  }

  return { ok: true, status: 200, recipientCount: validEmails.length };
}
