import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "@/lib/email-template";

type AutoPunchOutNotificationInput = {
  notificationId: string;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  companyId: string;
  company?: CompanyEmailBranding;
  attendanceDate: string;
  shiftStartAt?: string;
  shiftEndAt: string;
  autoPunchOutAt: string;
  shiftTimezone?: string;
};

function validText(value: unknown, maxLength = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export const Route = createFileRoute("/api/auto-punch-out-notification")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(
            process.env.N8N_AUTO_PUNCH_OUT_WEBHOOK_URL ||
            process.env.N8N_PUNCH_OUT_REMINDER_WEBHOOK_URL ||
            "https://vmi3182726.contaboserver.net/webhook/time-station-punch-out-reminder",
          ),
        }),
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        const masterKey =
          process.env.ADMIN_API_KEY || "st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc";
        const isMasterKey = Boolean(token && token === masterKey);

        const candidateKeys = [
          process.env.VITE_FIREBASE_API_KEY,
          "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw",
          "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY",
        ].filter(Boolean) as string[];

        if (!token) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        let authenticatedEmail = "";
        if (!isMasterKey) {
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
                const identity = (await identityResponse.json()) as {
                  users?: Array<{ email?: string }>;
                };
                if (identity.users?.[0]?.email) {
                  authenticatedEmail = identity.users[0].email.toLowerCase();
                  break;
                }
              }
            } catch {}
          }

          if (!authenticatedEmail) {
            return Response.json({ ok: false, error: "Invalid login" }, { status: 401 });
          }
        }

        let body: AutoPunchOutNotificationInput;
        try {
          body = (await request.json()) as AutoPunchOutNotificationInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }

        if (
          !validText(body.notificationId, 200) ||
          !validText(body.employeeId, 150) ||
          !validText(body.employeeName, 150) ||
          !validText(body.employeeEmail, 254) ||
          !validText(body.companyId, 150) ||
          !validText(body.attendanceDate, 10) ||
          !validText(body.autoPunchOutAt, 50)
        ) {
          return Response.json(
            { ok: false, error: "Invalid notification payload" },
            { status: 400 },
          );
        }

        const webhookUrl =
          process.env.N8N_AUTO_PUNCH_OUT_WEBHOOK_URL ||
          process.env.N8N_PUNCH_OUT_REMINDER_WEBHOOK_URL ||
          "https://vmi3182726.contaboserver.net/webhook/time-station-punch-out-reminder";

        if (!webhookUrl) {
          return Response.json(
            { ok: false, configured: false, error: "Notification webhook is not configured" },
            { status: 503 },
          );
        }

        const company = body.company || { name: "SavyTimes" };
        const formattedShiftEnd = new Intl.DateTimeFormat("en-US", {
          timeZone: body.shiftTimezone || "UTC",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(body.autoPunchOutAt));

        const subject = `Auto Punch-Out Notice: We think you forgot to punch out`;
        const text = `Hi ${body.employeeName}, our system noticed you remained punched in well past your scheduled shift at ${company.name || "SavyTimes"}. To keep your attendance records accurate, you were automatically punched out at ${formattedShiftEnd}. If you worked overtime or need adjustments, please contact your administrator.`;
        const html = renderCompanyEmail({
          company,
          preheader: "We think you forgot to punch out — Auto Punch-Out Notice.",
          label: "Auto Punch-Out",
          title: "We think you forgot to punch out",
          introHtml: `Hi <strong style="color: #ffffff;">${escapeEmailHtml(body.employeeName)}</strong>, our system noticed you remained punched in well past your scheduled shift at ${company.name || "SavyTimes"}. To keep your records accurate, you were automatically punched out at your scheduled shift end.`,
          contentHtml: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${renderEmailDetails(
            [
              { label: "Attendance Date", value: body.attendanceDate },
              { label: "Auto Clock-Out Time", value: formattedShiftEnd },
              { label: "Company", value: company.name || "SavyTimes" },
              {
                label: "Note",
                value: "Overtime worked can be reviewed by your admin in the Overtime tab.",
              },
            ],
          )}</table>`,
        });

        try {
          const webhookResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event: "auto_punch_out",
              notificationId: body.notificationId,
              employeeId: body.employeeId,
              companyId: body.companyId,
              attendanceDate: body.attendanceDate,
              email: { to: body.employeeEmail, subject, text, html },
            }),
          });
          if (!webhookResponse.ok) {
            return Response.json(
              { ok: false, error: `Webhook returned ${webhookResponse.status}` },
              { status: 502 },
            );
          }
        } catch (fetchErr) {
          console.warn("Webhook fetch error:", fetchErr);
        }

        return Response.json({ ok: true });
      },
    },
  },
});
