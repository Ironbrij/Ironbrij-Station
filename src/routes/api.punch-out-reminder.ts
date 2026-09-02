import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "@/lib/email-template";

type PunchOutReminderInput = {
  reminderId: string;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  companyId: string;
  company?: CompanyEmailBranding;
  attendanceDate: string;
  shiftEndAt: string;
  shiftTimezone?: string;
};

function validText(value: unknown, maxLength = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

export const Route = createFileRoute("/api/punch-out-reminder")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(
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

        let body: PunchOutReminderInput;
        try {
          body = (await request.json()) as PunchOutReminderInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        if (
          !validText(body.reminderId, 200) ||
          !validText(body.employeeId, 150) ||
          !validText(body.employeeName, 150) ||
          !validText(body.employeeEmail, 254) ||
          !validText(body.companyId, 150) ||
          !validText(body.attendanceDate, 10) ||
          !validText(body.shiftEndAt, 50) ||
          (!isMasterKey && authenticatedEmail !== body.employeeEmail.toLowerCase())
        ) {
          return Response.json({ ok: false, error: "Invalid reminder" }, { status: 400 });
        }

        const webhookUrl =
          process.env.N8N_PUNCH_OUT_REMINDER_WEBHOOK_URL ||
          "https://vmi3182726.contaboserver.net/webhook/time-station-punch-out-reminder";
        if (!webhookUrl) {
          return Response.json(
            { ok: false, configured: false, error: "Reminder webhook is not configured" },
            { status: 503 },
          );
        }

        const company = body.company || { name: "SavyTimes" };
        const formattedShiftEnd = new Intl.DateTimeFormat("en-US", {
          timeZone: body.shiftTimezone || "UTC",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(body.shiftEndAt));
        const subject = `Reminder: your shift at ${company.name || "SavyTimes"} is ending soon`;
        const text = `Hi ${body.employeeName}, your shift ends at ${formattedShiftEnd}. Please punch out when you finish work.`;
        const html = renderCompanyEmail({
          company,
          preheader: "Your shift is approaching completion.",
          label: "Punch-out reminder",
          title: "Your shift is ending soon",
          introHtml: `Hi <strong style="color: #ffffff;">${escapeEmailHtml(body.employeeName)}</strong>, remember to punch out when you finish work.`,
          contentHtml: `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${renderEmailDetails(
            [
              { label: "Attendance date", value: body.attendanceDate },
              { label: "Shift ends", value: formattedShiftEnd },
              { label: "Company", value: company.name || "SavyTimes" },
            ],
          )}</table>`,
        });

        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "punch_out_reminder",
            reminderId: body.reminderId,
            employeeId: body.employeeId,
            companyId: body.companyId,
            attendanceDate: body.attendanceDate,
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
