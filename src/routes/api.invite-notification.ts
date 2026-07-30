import { createFileRoute } from "@tanstack/react-router";

type InviteNotificationInput = {
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  inviteToken: string;
  companyName?: string;
  departmentName?: string;
  jobTitle?: string;
  country?: string;
  state?: string;
  shiftStartTime?: string;
  shiftEndTime?: string;
  shiftTimezone?: string;
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

export const Route = createFileRoute("/api/invite-notification")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(process.env.N8N_INVITE_WEBHOOK_URL),
        }),
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const idToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const firebaseApiKey =
          process.env.VITE_FIREBASE_API_KEY || "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY";
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
          process.env.INVITE_ADMIN_EMAILS ??
          process.env.LEAVE_ADMIN_EMAILS ??
          "pabibek9@gmail.com,bibekparajuli05@gmail.com,louis@ironbrij.com.au"
        )
          .split(",")
          .map((email) => email.trim().toLowerCase())
          .filter(Boolean);
        if (!configuredAdmins.includes(authenticatedEmail)) {
          return Response.json({ ok: false, error: "Admin access required" }, { status: 403 });
        }

        let body: InviteNotificationInput;
        try {
          body = (await request.json()) as InviteNotificationInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }

        if (
          !validText(body.employeeId, 150) ||
          !validText(body.employeeName, 150) ||
          !validText(body.employeeEmail, 254) ||
          !/^[a-f0-9]{32}$/i.test(body.inviteToken)
        ) {
          return Response.json({ ok: false, error: "Invalid employee invite" }, { status: 400 });
        }

        const webhookUrl = process.env.N8N_INVITE_WEBHOOK_URL;
        if (!webhookUrl) {
          return Response.json(
            { ok: false, configured: false, error: "N8N_INVITE_WEBHOOK_URL is not configured" },
            { status: 503 },
          );
        }

        const companyName = body.companyName?.trim() || "Time Station";
        const appUrl = (process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
        const inviteUrl = `${appUrl}/invite/${body.inviteToken}`;
        const subject = `You're invited to ${companyName}`;
        const shift =
          body.shiftStartTime && body.shiftEndTime
            ? `${body.shiftStartTime}–${body.shiftEndTime}${body.shiftTimezone ? ` (${body.shiftTimezone})` : ""}`
            : "Your manager will confirm your shift";
        const text = `Hi ${body.employeeName},\n\nYou have been invited to join ${companyName} on Time Station.\n\nActivate your account: ${inviteUrl}\n\nRole: ${body.jobTitle || "Employee"}\nDepartment: ${body.departmentName || "Not assigned"}\nShift: ${shift}`;
        const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:24px"><h2 style="margin:0 0 16px">Welcome to ${escapeHtml(companyName)}</h2><p>Hi ${escapeHtml(body.employeeName)},</p><p>Your employee profile is ready. Use the button below to activate your Time Station account.</p><p style="margin:28px 0"><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#0b2545;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Activate account</a></p><p><strong>Role:</strong> ${escapeHtml(body.jobTitle || "Employee")}<br><strong>Department:</strong> ${escapeHtml(body.departmentName || "Not assigned")}<br><strong>Shift:</strong> ${escapeHtml(shift)}</p><p style="color:#64748b;font-size:12px">If the button does not work, copy this link:<br>${escapeHtml(inviteUrl)}</p></div>`;

        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "employee_invited",
            idempotencyKey: `employee_invite:${body.inviteToken}`,
            employee: {
              id: body.employeeId,
              name: body.employeeName,
              email: body.employeeEmail,
              jobTitle: body.jobTitle || "",
              departmentName: body.departmentName || "",
              country: body.country || "",
              state: body.state || "",
              shiftStartTime: body.shiftStartTime || "",
              shiftEndTime: body.shiftEndTime || "",
              shiftTimezone: body.shiftTimezone || "",
            },
            invite: {
              token: body.inviteToken,
              url: inviteUrl,
              createdAt: new Date().toISOString(),
            },
            email: {
              from: process.env.INVITE_FROM_EMAIL || "Time Station <onboarding@example.com>",
              to: body.employeeEmail,
              subject,
              text,
              html,
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
