import { createFileRoute } from "@tanstack/react-router";
import type { MentionItem } from "@/lib/types";

type SodMentionNotificationInput = {
  reportId: string;
  reportDate: string;
  authorName: string;
  authorEmail: string;
  authorDeptName?: string;
  answers: Array<{
    questionId: string;
    question: string;
    answer: string;
    mentions?: MentionItem[];
  }>;
};

function validText(value: unknown, maxLength = 1000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function formatMentionsInHtml(text: string): string {
  const safeText = escapeHtml(text);
  // Highlight @mentions in HTML text as styled inline pills
  return safeText.replace(
    /(@[A-Za-z0-9_.\- ]+?)(?=\s|$|[.,!?;:]|<)/g,
    '<span style="background-color: #dbeafe; color: #1e40af; font-weight: 600; padding: 2px 6px; border-radius: 4px; display: inline-block;">$1</span>',
  );
}

export const Route = createFileRoute("/api/sod-mention-notification")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(
            process.env.N8N_SOD_MENTION_WEBHOOK_URL ||
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
          `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
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
        const authenticatedEmail = identityPayload.users?.[0]?.email?.toLowerCase();

        let body: SodMentionNotificationInput;
        try {
          body = (await request.json()) as SodMentionNotificationInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }

        if (
          !authenticatedEmail ||
          authenticatedEmail !== body.authorEmail.toLowerCase() ||
          !validText(body.reportId, 150) ||
          !validText(body.authorName, 150) ||
          !validText(body.authorEmail, 254) ||
          !Array.isArray(body.answers)
        ) {
          return Response.json({ ok: false, error: "Invalid SOD mention notification request" }, { status: 400 });
        }

        const webhookUrl =
          process.env.N8N_SOD_MENTION_WEBHOOK_URL ||
          process.env.N8N_LEAVE_WEBHOOK_URL ||
          process.env.N8N_INVITE_WEBHOOK_URL;

        if (!webhookUrl) {
          return Response.json(
            { ok: false, configured: false, error: "n8n notification webhook URL is not configured" },
            { status: 531 },
          );
        }

        const appUrl = (process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
        const reportUrl = `${appUrl}/app/sod-eod`;

        // Extract answers containing mentions
        const answersWithMentions = body.answers.filter(
          (a) => Array.isArray(a.mentions) && a.mentions.length > 0,
        );

        if (answersWithMentions.length === 0) {
          return Response.json({ ok: true, mentionsCount: 0, message: "No mentions found to notify" });
        }

        // Collect distinct mentioned items
        const allMentions = answersWithMentions.flatMap((a) => a.mentions || []);
        const dispatchedEmails: string[] = [];

        // Build elegant HTML email for each answer note
        for (const answerObj of answersWithMentions) {
          const questionText = escapeHtml(answerObj.question);
          const formattedAnswerHtml = formatMentionsInHtml(answerObj.answer);

          for (const mention of answerObj.mentions || []) {
            const isDept = mention.type === "department";
            const targetName = escapeHtml(mention.name);
            const authorName = escapeHtml(body.authorName);
            const reportDate = escapeHtml(body.reportDate);

            const subject = `📌 You were mentioned by ${body.authorName} in SOD Report (${body.reportDate})`;

            const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f6f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f6f9; padding: 30px 15px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.06); border: 1px solid #e2e8f0;">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); padding: 32px 28px; text-align: left;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="background: rgba(255,255,255,0.15); color: #93c5fd; font-size: 11px; font-weight: 700; text-transform: uppercase; tracking: 1px; padding: 4px 10px; border-radius: 20px; display: inline-block;">
                      Time Station • SOD Mention
                    </span>
                    <h1 style="color: #ffffff; font-size: 22px; font-weight: 800; margin: 12px 0 4px 0; line-height: 1.3;">
                      You were mentioned in a report! 👋
                    </h1>
                    <p style="color: #cbd5e1; font-size: 13px; margin: 0;">
                      ${authorName} tagged ${isDept ? "department" : "you"} in today's Start of Day update.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 28px;">
              <!-- Author Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; border-radius: 12px; padding: 14px 18px; border: 1px solid #f1f5f9; margin-bottom: 24px;">
                <tr>
                  <td>
                    <span style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; display: block; margin-bottom: 2px;">Report By</span>
                    <strong style="font-size: 15px; color: #0f172a;">${authorName}</strong>
                    ${body.authorDeptName ? `<span style="font-size: 13px; color: #64748b;"> • ${escapeHtml(body.authorDeptName)}</span>` : ""}
                  </td>
                  <td align="right">
                    <span style="font-size: 12px; font-weight: 600; color: #3b82f6; background: #eff6ff; padding: 4px 10px; border-radius: 6px;">
                      📅 ${reportDate}
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Question & Answer Box -->
              <div style="margin-bottom: 24px;">
                <div style="font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; tracking: 0.5px; margin-bottom: 8px;">
                  Question: ${questionText}
                </div>
                <div style="background-color: #ffffff; border-left: 4px solid #3b82f6; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; border-radius: 0 12px 12px 0; padding: 18px; font-size: 14px; line-height: 1.6; color: #334155;">
                  ${formattedAnswerHtml}
                </div>
              </div>

              <!-- Call to Action Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 28px;">
                <tr>
                  <td align="center">
                    <a href="${reportUrl}" target="_blank" style="background-color: #2563eb; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 700; padding: 14px 28px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(37,99,235,0.25);">
                      View SOD & EOD Dashboard →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 28px; text-align: center;">
              <p style="font-size: 12px; color: #94a3b8; margin: 0 0 4px 0;">
                Sent automatically by <strong>Time Station</strong> team notifications.
              </p>
              <p style="font-size: 11px; color: #cbd5e1; margin: 0;">
                If you have questions, log into your Time Station app dashboard.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
            `.trim();

            const n8nPayload = {
              reportId: body.reportId,
              reportDate: body.reportDate,
              authorName: body.authorName,
              authorEmail: body.authorEmail,
              mentionedTarget: mention.name,
              mentionedType: mention.type,
              email: {
                to: mention.email || `${mention.name.toLowerCase().replace(/\s+/g, ".")}@company.com`,
                subject,
                html,
              },
            };

            // Post to n8n webhook
            fetch(webhookUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(n8nPayload),
            }).catch((err) => console.error("n8n SOD mention notification webhook error:", err));

            dispatchedEmails.push(mention.name);
          }
        }

        return Response.json({
          ok: true,
          mentionsCount: allMentions.length,
          dispatchedTo: dispatchedEmails,
          message: "SOD mention notifications sent to n8n webhook",
        });
      },
    },
  },
});
