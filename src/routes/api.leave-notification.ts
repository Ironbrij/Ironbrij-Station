import { createFileRoute } from "@tanstack/react-router";

type LeaveNotificationInput = {
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

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
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
        const firebaseApiKey = process.env.VITE_FIREBASE_API_KEY;
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
          authenticatedEmail !== body.employeeEmail.toLowerCase() ||
          !validText(body.leaveRequestId, 150) ||
          !validText(body.employeeId, 150) ||
          !validText(body.employeeName, 150) ||
          !validText(body.employeeEmail, 254) ||
          authenticatedEmail !== body.employeeEmail.toLowerCase() ||
          !validText(body.dateFrom, 10) ||
          !validText(body.dateTo, 10) ||
          !validText(body.reason, 2_000)
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
        const text = `${body.employeeName} (${body.employeeEmail}) is asking for ${requestType} on ${dateRange}.\n\nReason: ${body.reason}\n\nOpen Time Station to approve or reject this request.`;
        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "leave_requested",
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
            email: {
              to: managerEmail,
              subject,
              text,
              html: `<div style="font-family:Arial,sans-serif;max-width:600px"><h2>New leave request</h2><p><strong>${escapeHtml(body.employeeName)}</strong> (${escapeHtml(body.employeeEmail)}) is asking for <strong>${escapeHtml(requestType)}</strong> on <strong>${escapeHtml(dateRange)}</strong>.</p><p><strong>Reason:</strong> ${escapeHtml(body.reason)}</p><p>Open Time Station to approve or reject this request.</p></div>`,
            },
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
