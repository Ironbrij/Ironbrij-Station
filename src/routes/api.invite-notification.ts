import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "@/lib/email-template";
import { resolveAppUrl } from "@/lib/app-url";

type InviteNotificationInput = {
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  inviteToken: string;
  company?: CompanyEmailBranding;
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

        const company = body.company || { name: body.companyName?.trim() || "SavyTimes" };
        const companyName = company.name?.trim() || "SavyTimes";
        const appUrl = resolveAppUrl(request.url);
        const inviteUrl = `${appUrl}/invite/${body.inviteToken}`;
        const subject = `You're invited to ${companyName}`;
        const shift =
          body.shiftStartTime && body.shiftEndTime
            ? `${body.shiftStartTime}–${body.shiftEndTime}${body.shiftTimezone ? ` (${body.shiftTimezone})` : ""}`
            : "Your manager will confirm your shift";
        const text = `Hi ${body.employeeName},\n\nYou have been invited to join ${companyName} on SavyTimes.\n\nActivate your account: ${inviteUrl}\n\nRole: ${body.jobTitle || "Employee"}\nDepartment: ${body.departmentName || "Not assigned"}\nShift: ${shift}`;
        const html = renderCompanyEmail({
          company,
          preheader: `Your invitation to join ${companyName} is ready.`,
          label: "Employee invitation",
          title: `Welcome to ${companyName}`,
          introHtml: `Hi <strong style="color: #ffffff;">${escapeEmailHtml(body.employeeName)}</strong>. Your employee profile is ready to activate.`,
          contentHtml: `
            <p style="margin: 0 0 22px; color: #526477; font-size: 15px; line-height: 24px;">Use the secure activation link below to finish setting up your SavyTimes account.</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${renderEmailDetails(
              [
                { label: "Role", value: body.jobTitle || "Employee" },
                { label: "Department", value: body.departmentName || "Not assigned" },
                { label: "Shift", value: shift },
              ],
            )}</table>
            <p style="margin: 22px 0 0; color: #718096; font-size: 11px; line-height: 18px;">If the button does not work, copy this link into your browser:<br><span style="word-break: break-all;">${escapeEmailHtml(inviteUrl)}</span></p>`,
          cta: { label: "Activate account", url: inviteUrl },
        });

        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "employee_invited",
            idempotencyKey: `employee_invite:${body.inviteToken}`,
            company,
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
              from: process.env.INVITE_FROM_EMAIL || "SavyTimes <onboarding@example.com>",
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
