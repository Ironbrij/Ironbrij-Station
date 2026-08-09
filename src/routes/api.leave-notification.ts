import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "@/lib/email-template";

type LeaveNotificationInput = {
  company?: CompanyEmailBranding;
  leaveRequestId: string;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  dateFrom: string;
  dateTo: string;
  leaveType?: "full_day" | "half_day" | "timed_break";
  halfDayPeriod?: "first_half" | "second_half";
  startTime?: string;
  endTime?: string;
  reason: string;
};

function validText(value: unknown, maxLength = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export const Route = createFileRoute("/api/leave-notification")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(process.env.N8N_LEAVE_WEBHOOK_URL),
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
          `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ idToken }),
          },
        );
        if (!identityResponse.ok) {
          return Response.json({ ok: false, error: "Invalid login" }, { status: 401 });
        }

        const identityPayload = (await identityResponse.json()) as {
          users?: Array<{ email?: string }>;
        };
        const authenticatedEmail = identityPayload.users?.[0]?.email?.toLowerCase();

        let body: LeaveNotificationInput;
        try {
          body = (await request.json()) as LeaveNotificationInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        if (
          !validText(body.leaveRequestId, 150) ||
          !validText(body.employeeId, 150) ||
          !validText(body.employeeName, 150) ||
          !validText(body.employeeEmail, 254) ||
          !validText(body.dateFrom, 10) ||
          !validText(body.dateTo, 10) ||
          !validText(body.reason, 2_000) ||
          authenticatedEmail !== body.employeeEmail.toLowerCase()
        ) {
          return Response.json({ ok: false, error: "Invalid leave request" }, { status: 400 });
        }

        const webhookUrl = process.env.N8N_LEAVE_WEBHOOK_URL;
        if (!webhookUrl) {
          return Response.json(
            { ok: false, configured: false, error: "N8N_LEAVE_WEBHOOK_URL is not configured" },
            { status: 503 },
          );
        }

        const company = body.company || { name: "SavyTimes" };
        const companyName = company.name?.trim() || "SavyTimes";
        const managerEmail = process.env.LEAVE_MANAGER_EMAIL ?? "pabibek9@gmail.com";
        const dateRange =
          body.dateFrom === body.dateTo ? body.dateFrom : `${body.dateFrom} to ${body.dateTo}`;
        const requestType =
          body.leaveType === "timed_break"
            ? `a break from ${body.startTime} to ${body.endTime}`
            : body.leaveType === "half_day"
              ? `${body.halfDayPeriod === "second_half" ? "second" : "first"}-half leave`
              : "full-day leave";
        const subject = `New ${requestType} request from ${body.employeeName}`;
        const text = `${body.employeeName} (${body.employeeEmail}) is asking for ${requestType} on ${dateRange} at ${companyName}.\n\nReason: ${body.reason}\n\nOpen SavyTimes to approve or reject this request.`;
        const appUrl = (process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
        const html = renderCompanyEmail({
          company,
          preheader: `${body.employeeName} submitted a new leave request.`,
          label: "Leave request",
          title: "New leave request",
          introHtml: `<strong style="color: #ffffff;">${escapeEmailHtml(body.employeeName)}</strong> submitted a request for review.`,
          contentHtml: `
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${renderEmailDetails(
              [
                { label: "Employee", value: `${body.employeeName} (${body.employeeEmail})` },
                { label: "Request", value: requestType },
                { label: "Date", value: dateRange },
              ],
            )}</table>
            <div style="margin-top: 12px; padding: 16px; border: 1px solid #dbe4ee; border-radius: 10px; background-color: #f8fafc;">
              <div style="margin-bottom: 7px; color: #718096; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Reason</div>
              <div style="color: #243447; font-size: 15px; line-height: 24px; white-space: pre-wrap;">${escapeEmailHtml(body.reason)}</div>
            </div>`,
          cta: { label: "Review leave request", url: `${appUrl}/admin/leaves` },
        });

        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "leave_requested",
            company,
            managerEmail,
            leaveRequestId: body.leaveRequestId,
            employeeId: body.employeeId,
            employeeName: body.employeeName,
            employeeEmail: body.employeeEmail,
            dateFrom: body.dateFrom,
            dateTo: body.dateTo,
            leaveType: body.leaveType || "full_day",
            halfDayPeriod: body.halfDayPeriod,
            startTime: body.startTime,
            endTime: body.endTime,
            reason: body.reason,
            requestedAt: new Date().toISOString(),
            email: { to: managerEmail, subject, text, html },
          }),
        });

        if (!webhookResponse.ok) {
          return Response.json(
            { ok: false, error: `n8n webhook returned ${webhookResponse.status}` },
            { status: 502 },
          );
        }
        return Response.json({ ok: true });
      },
    },
  },
});
