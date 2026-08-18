import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "@/lib/email-template";
import { resolveAppUrl } from "@/lib/app-url";

type LeaveDecisionInput = {
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
  status: "approved" | "rejected";
};

function validText(value: unknown, maxLength = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export const Route = createFileRoute("/api/leave-decision-notification")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(process.env.N8N_LEAVE_DECISION_WEBHOOK_URL),
        }),
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const masterKey =
          process.env.ADMIN_API_KEY || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
        const isMasterKey = Boolean(token && token === masterKey);

        const firebaseApiKey =
          process.env.VITE_FIREBASE_API_KEY || "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY";

        if (!token) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        if (!isMasterKey) {
          const identityResponse = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ idToken: token }),
            },
          );
          if (!identityResponse.ok) {
            return Response.json({ ok: false, error: "Invalid login token" }, { status: 401 });
          }
          const identityPayload = (await identityResponse.json()) as {
            users?: Array<{ localId?: string; email?: string }>;
          };
          const authenticatedEmail = identityPayload.users?.[0]?.email?.toLowerCase() ?? "";
          const configuredAdmins = (
            process.env.LEAVE_ADMIN_EMAILS ??
            "pabibek9@gmail.com,bibekparajuli05@gmail.com,louis@ironbrij.com.au,rose@ironbrij.com.au,ann@ironbrij.com.au,mv@ironbrij.com.au,admin@ironbrij.com.au"
          )
            .split(",")
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean);

          const isKnownAdmin = configuredAdmins.some(
            (adm) => authenticatedEmail.includes(adm) || adm === authenticatedEmail,
          );

          if (!isKnownAdmin && identityPayload.users?.[0]?.localId) {
            // Also check Firestore admins collection
            const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "runner-man-634be";
            const adminCheckRes = await fetch(
              `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admins/${identityPayload.users[0].localId}?key=${encodeURIComponent(firebaseApiKey)}`,
            );
            if (!adminCheckRes.ok) {
              return Response.json({ ok: false, error: "Admin access required" }, { status: 403 });
            }
          }
        }

        let body: LeaveDecisionInput;
        try {
          body = (await request.json()) as LeaveDecisionInput;
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
          (body.status !== "approved" && body.status !== "rejected")
        ) {
          return Response.json(
            { ok: false, error: "Invalid leave decision data" },
            { status: 400 },
          );
        }

        const webhookUrl =
          process.env.N8N_LEAVE_DECISION_WEBHOOK_URL ||
          "https://vmi3182726.contaboserver.net/webhook/time-station-leave-decision";

        const company = body.company || { name: "SavyTimes" };
        const companyName = company.name?.trim() || "SavyTimes";
        const approved = body.status === "approved";
        const dateRange =
          body.dateFrom === body.dateTo ? body.dateFrom : `${body.dateFrom} to ${body.dateTo}`;
        const requestType =
          body.leaveType === "timed_break"
            ? `break from ${body.startTime} to ${body.endTime}`
            : body.leaveType === "half_day"
              ? `${body.halfDayPeriod === "second_half" ? "second" : "first"}-half leave`
              : "full-day leave";
        const subject = approved
          ? "Your leave request was approved"
          : "Your leave request was rejected";
        const decisionText = approved
          ? `Your ${requestType} request for ${dateRange} has been approved.`
          : `Your ${requestType} request for ${dateRange} has been rejected.`;
        const text = `Hi ${body.employeeName},\n\n${decisionText}\n\nYour submitted reason: ${body.reason}\n\nPlease open SavyTimes to view the updated status for ${companyName}.`;
        const accentColor = approved ? "#047857" : "#be123c";
        const appUrl = resolveAppUrl(request.url);
        const html = renderCompanyEmail({
          company,
          preheader: decisionText,
          label: approved ? "Leave approved" : "Leave rejected",
          title: approved ? "Leave request approved" : "Leave request rejected",
          introHtml: `Hi <strong style="color: #ffffff;">${escapeEmailHtml(body.employeeName)}</strong>. ${escapeEmailHtml(decisionText)}`,
          contentHtml: `
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${renderEmailDetails(
              [
                { label: "Request", value: requestType },
                { label: "Date", value: dateRange },
                { label: "Status", value: approved ? "Approved" : "Rejected" },
              ],
              accentColor,
            )}</table>
            <div style="margin-top: 12px; padding: 16px; border: 1px solid #dbe4ee; border-radius: 10px; background-color: #f8fafc;">
              <div style="margin-bottom: 7px; color: #718096; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Submitted reason</div>
              <div style="color: #243447; font-size: 15px; line-height: 24px; white-space: pre-wrap;">${escapeEmailHtml(body.reason)}</div>
            </div>`,
          cta: { label: "View leave status", url: `${appUrl}/app/leave` },
          accentColor,
        });

        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: approved ? "leave_approved" : "leave_rejected",
            company,
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
            status: body.status,
            decidedAt: new Date().toISOString(),
            email: { to: body.employeeEmail, subject, text, html },
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
