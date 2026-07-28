import { createFileRoute } from "@tanstack/react-router";

type LeaveDecisionInput = {
  leaveRequestId: string;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  dateFrom: string;
  dateTo: string;
  reason: string;
  status: "approved" | "rejected";
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
        const authenticatedEmail = identityPayload.users?.[0]?.email?.toLowerCase() ?? "";
        const configuredAdmins = (
          process.env.LEAVE_ADMIN_EMAILS ??
          "pabibek9@gmail.com,bibekparajuli05@gmail.com,louis@ironbrij.com.au"
        )
          .split(",")
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean);
        if (!configuredAdmins.includes(authenticatedEmail)) {
          return Response.json({ ok: false, error: "Admin access required" }, { status: 403 });
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
          return Response.json({ ok: false, error: "Invalid leave decision" }, { status: 400 });
        }

        const webhookUrl = process.env.N8N_LEAVE_DECISION_WEBHOOK_URL;
        if (!webhookUrl) {
          return Response.json(
            {
              ok: false,
              configured: false,
              error: "N8N_LEAVE_DECISION_WEBHOOK_URL is not configured",
            },
            { status: 503 },
          );
        }

        const approved = body.status === "approved";
        const dateRange =
          body.dateFrom === body.dateTo ? body.dateFrom : `${body.dateFrom} to ${body.dateTo}`;
        const subject = approved
          ? "Your leave request was approved"
          : "Your leave request was rejected";
        const decisionText = approved
          ? `Your leave request for ${dateRange} has been approved.`
          : `Your leave request for ${dateRange} has been rejected.`;
        const text = `Hi ${body.employeeName},\n\n${decisionText}\n\nYour submitted reason: ${body.reason}\n\nPlease open Time Station to view the updated status.`;
        const statusColor = approved ? "#047857" : "#be123c";
        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: approved ? "leave_approved" : "leave_rejected",
            leaveRequestId: body.leaveRequestId,
            employeeId: body.employeeId,
            employeeName: body.employeeName,
            employeeEmail: body.employeeEmail,
            dateFrom: body.dateFrom,
            dateTo: body.dateTo,
            reason: body.reason,
            status: body.status,
            decidedAt: new Date().toISOString(),
            email: {
              to: body.employeeEmail,
              subject,
              text,
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto"><h2 style="color:${statusColor}">Leave request ${escapeHtml(body.status)}</h2><p>Hi ${escapeHtml(body.employeeName)},</p><p>${escapeHtml(decisionText)}</p><p><strong>Your submitted reason:</strong> ${escapeHtml(body.reason)}</p><p>Please open Time Station to view the updated status.</p></div>`,
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
