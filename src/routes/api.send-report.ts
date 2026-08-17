import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { escapeEmailHtml, renderCompanyEmail } from "@/lib/email-template";

export interface ReportEmployeeRowPayload {
  employeeName: string;
  employeeEmail?: string;
  role?: string;
  department?: string;
  regularHours: number;
  overtimeHours: number;
  overtimeDates?: string[];
  paidLeaveDays: number;
  unpaidLeaveDays: number;
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
  summary: {
    totalHours: number;
    totalOvertime: number;
    totalPaidLeave: number;
    totalUnpaidLeave: number;
    totalEmployees: number;
  };
  rows: ReportEmployeeRowPayload[];
}

function validText(value: unknown, maxLength = 5000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function renderReportHtmlTable(rows: ReportEmployeeRowPayload[], accentColor = "#2459a9") {
  const rowHtml = rows
    .map((row, index) => {
      const bg = index % 2 === 0 ? "#ffffff" : "#f8fafc";
      const overtimeDatesStr =
        row.overtimeDates && row.overtimeDates.length > 0
          ? `<div style="font-size: 11px; color: #d97706; margin-top: 2px;">Dates: ${escapeEmailHtml(
              row.overtimeDates.join(", "),
            )}</div>`
          : "";

      const remarksHtml = row.remarks?.trim()
        ? `<div style="font-size: 11px; color: #475569; font-style: italic;">${escapeEmailHtml(
            row.remarks,
          )}</div>`
        : '<span style="color: #94a3b8;">—</span>';

      return `<tr style="background-color: ${bg}; border-bottom: 1px solid #e2e8f0;">
        <td style="padding: 10px 12px; font-weight: 600; color: #1e293b; font-size: 13px;">
          ${escapeEmailHtml(row.employeeName)}
          ${
            row.department
              ? `<div style="font-size: 11px; color: #64748b; font-weight: normal;">${escapeEmailHtml(
                  row.department,
                )}</div>`
              : ""
          }
        </td>
        <td style="padding: 10px 12px; text-align: right; font-weight: 600; color: #0f172a; font-size: 13px;">
          ${row.regularHours.toFixed(1)}h
        </td>
        <td style="padding: 10px 12px; text-align: right; font-size: 13px;">
          <span style="font-weight: 600; color: ${
            row.overtimeHours > 0 ? "#b45309" : "#64748b"
          };">
            ${row.overtimeHours > 0 ? `+${row.overtimeHours.toFixed(1)}h` : "0h"}
          </span>
          ${overtimeDatesStr}
        </td>
        <td style="padding: 10px 12px; text-align: center; font-size: 12px; color: #334155;">
          ${row.paidLeaveDays > 0 ? `${row.paidLeaveDays}d` : "0d"}
        </td>
        <td style="padding: 10px 12px; text-align: center; font-size: 12px; color: #334155;">
          ${row.unpaidLeaveDays > 0 ? `${row.unpaidLeaveDays}d` : "0d"}
        </td>
        <td style="padding: 10px 12px; font-size: 12px;">
          ${remarksHtml}
        </td>
      </tr>`;
    })
    .join("");

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; border-collapse: collapse; margin-top: 16px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
    <thead>
      <tr style="background-color: #0f172a; color: #ffffff; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;">
        <th style="padding: 10px 12px; font-weight: 700;">Employee / V.A.</th>
        <th style="padding: 10px 12px; text-align: right; font-weight: 700;">Reg Hours</th>
        <th style="padding: 10px 12px; text-align: right; font-weight: 700;">Overtime & Dates</th>
        <th style="padding: 10px 12px; text-align: center; font-weight: 700;">Paid Leave</th>
        <th style="padding: 10px 12px; text-align: center; font-weight: 700;">Unpaid Leave</th>
        <th style="padding: 10px 12px; font-weight: 700;">Remarks</th>
      </tr>
    </thead>
    <tbody>
      ${rowHtml}
    </tbody>
  </table>`;
}

export const Route = createFileRoute("/api/send-report")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(
            process.env.N8N_REPORT_WEBHOOK_URL ||
              process.env.N8N_LEAVE_WEBHOOK_URL ||
              process.env.N8N_INVITE_WEBHOOK_URL,
          ),
        }),
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const idToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const firebaseApiKey =
          process.env.VITE_FIREBASE_API_KEY || "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw";
        if (!idToken || !firebaseApiKey) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        const identityResponse = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(
            firebaseApiKey,
          )}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idToken }),
          },
        );
        if (!identityResponse.ok) {
          return Response.json({ ok: false, error: "Invalid authentication" }, { status: 401 });
        }

        const identityPayload = (await identityResponse.json()) as {
          users?: Array<{ email?: string }>;
        };
        const authenticatedEmail = identityPayload.users?.[0]?.email?.toLowerCase() ?? "";

        let body: SendReportInput;
        try {
          body = (await request.json()) as SendReportInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }

        if (!Array.isArray(body.recipientEmails) || body.recipientEmails.length === 0) {
          return Response.json(
            { ok: false, error: "At least one recipient email is required" },
            { status: 400 },
          );
        }

        const validEmails = body.recipientEmails
          .map((e) => e.trim().toLowerCase())
          .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

        if (validEmails.length === 0) {
          return Response.json({ ok: false, error: "No valid recipient email addresses provided" }, { status: 400 });
        }

        const companyName = body.companyName || body.company?.name || "SavyTimes";
        const periodLabel = body.periodLabel || "Recent Period";
        const subject =
          body.subject?.trim() || `${companyName} Attendance & Hours Report (${periodLabel})`;

        // Build Email HTML
        const tableHtml = renderReportHtmlTable(body.rows || []);
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
                <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Paid Leaves</div>
                <div style="font-size: 18px; font-weight: 800; color: #16a34a;">${body.summary.totalPaidLeave}d</div>
              </div>
              <div style="display: table-cell; padding: 6px; text-align: center;">
                <div style="font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase;">Unpaid Leaves</div>
                <div style="font-size: 18px; font-weight: 800; color: #dc2626;">${body.summary.totalUnpaidLeave}d</div>
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
          contentHtml: `
            ${customMessageHtml}
            ${summaryStatsHtml}
            <div style="margin-top: 20px;">
              <h3 style="margin: 0 0 8px; font-size: 15px; font-weight: 700; color: #0f172a;">Team Work Hours & Activity Breakdown</h3>
              ${tableHtml}
            </div>
            <p style="margin-top: 24px; font-size: 12px; color: #64748b; line-height: 18px;">
              This report includes verified regular work hours, tracked overtime sessions with specific dates, and approved leave records.
            </p>
          `,
        });

        // Plaintext fallback
        const plaintext = `Work & Attendance Report - ${companyName} (${periodLabel})
Sender: ${authenticatedEmail}
Total Team Members: ${body.summary.totalEmployees}
Total Regular Hours: ${body.summary.totalHours.toFixed(1)}h
Total Overtime: ${body.summary.totalOvertime.toFixed(1)}h
Paid Leaves: ${body.summary.totalPaidLeave}d | Unpaid Leaves: ${body.summary.totalUnpaidLeave}d

${body.customMessage ? `Note: ${body.customMessage}\n\n` : ""}
Breakdown:
${body.rows
  .map(
    (r) =>
      `- ${r.employeeName}: ${r.regularHours.toFixed(1)}h regular, ${r.overtimeHours.toFixed(
        1,
      )}h overtime ${
        r.overtimeDates?.length ? `[Dates: ${r.overtimeDates.join(", ")}]` : ""
      }, Paid: ${r.paidLeaveDays}d, Unpaid: ${r.unpaidLeaveDays}d ${
        r.remarks ? `(Remarks: ${r.remarks})` : ""
      }`,
  )
  .join("\n")}`;

        const webhookUrl =
          process.env.N8N_REPORT_WEBHOOK_URL ||
          process.env.N8N_LEAVE_WEBHOOK_URL ||
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
            return Response.json(
              {
                ok: false,
                error: `Report delivery service returned status ${webhookResponse.status}`,
              },
              { status: 502 },
            );
          }
        } catch (fetchError) {
          return Response.json(
            {
              ok: false,
              error:
                fetchError instanceof Error
                  ? fetchError.message
                  : "Failed to connect to email service",
            },
            { status: 500 },
          );
        }

        return Response.json({ ok: true, recipientCount: validEmails.length });
      },
    },
  },
});
