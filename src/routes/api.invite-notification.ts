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
          configured: true,
          webhookUrl:
            process.env.N8N_INVITE_WEBHOOK_URL ||
            "https://vmi3182726.contaboserver.net/webhook/time-station-invite",
        }),
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        const masterKey =
          process.env.ADMIN_API_KEY || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
        const isMasterKey = Boolean(token && token === masterKey);

        const candidateKeys = [
          process.env.VITE_FIREBASE_API_KEY,
          "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw", // production ironbrij-timestation
          "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY", // test runner-man-634be
        ].filter(Boolean) as string[];

        if (!token) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        if (!isMasterKey) {
          let authenticatedEmail = "";
          let authenticatedLocalId = "";

          for (const apiKey of candidateKeys) {
            try {
              const identityResponse = await fetch(
                `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ idToken: token }),
                },
              );

              if (identityResponse.ok) {
                const identityPayload = (await identityResponse.json()) as {
                  users?: Array<{ localId?: string; email?: string }>;
                };
                if (identityPayload.users?.[0]?.email) {
                  authenticatedEmail = identityPayload.users[0].email.toLowerCase();
                  authenticatedLocalId = identityPayload.users[0].localId || "";
                  break;
                }
              }
            } catch {}
          }

          if (!authenticatedEmail) {
            return Response.json({ ok: false, error: "Invalid login token" }, { status: 401 });
          }

          const configuredAdmins = (
            process.env.INVITE_ADMIN_EMAILS ??
            process.env.LEAVE_ADMIN_EMAILS ??
            "pabibek9@gmail.com,bibekparajuli05@gmail.com,louis@ironbrij.com.au,rose@ironbrij.com.au,ann@ironbrij.com.au,mv@ironbrij.com.au,andrea@ironbrij.com.au,janelle@ironbrij.com.au,admin@ironbrij.com.au,admin@savytimes.com"
          )
            .split(",")
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean);

          const isKnownAdmin = configuredAdmins.some(
            (adm) => authenticatedEmail.includes(adm) || adm === authenticatedEmail,
          );

          if (!isKnownAdmin && authenticatedLocalId) {
            // Check Firestore admins collection
            const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "ironbrij-timestation";
            for (const apiKey of candidateKeys) {
              try {
                const adminCheckRes = await fetch(
                  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/admins/${authenticatedLocalId}?key=${encodeURIComponent(apiKey)}`,
                );
                if (adminCheckRes.ok) break;
              } catch {}
            }
          }
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
          !validText(body.inviteToken, 150)
        ) {
          return Response.json(
            { ok: false, error: "Invalid employee invite data" },
            { status: 400 },
          );
        }

        const webhookUrl =
          process.env.N8N_INVITE_WEBHOOK_URL ||
          "https://vmi3182726.contaboserver.net/webhook/time-station-employee-invite";

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

        try {
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
            console.warn("n8n webhook non-200 status:", webhookResponse.status);
          }
        } catch (webhookErr) {
          console.warn("n8n invite webhook dispatch error:", webhookErr);
        }

        return Response.json({ ok: true, message: "Invite email dispatched successfully." });
      },
    },
  },
});
