import { createFileRoute } from "@tanstack/react-router";
import type { MentionItem } from "@/lib/types";

type MentionRecipient = {
  email: string;
  name: string;
  targetName: string;
  targetType: "person" | "department";
};

type SodMentionNotificationInput = {
  reportId: string;
  reportType?: "sod" | "eod";
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
  recipients?: MentionRecipient[];
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
  return safeText.replace(
    /(@[A-Za-z0-9_.\- ]+?)(?=\s|$|[.,!?;:]|<)/g,
    '<span style="background-color: #e0e7ff; color: #3730a3; font-weight: 600; padding: 2px 6px; border-radius: 4px; display: inline-block;">$1</span>',
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
          return Response.json({ ok: false, error: "Invalid mention notification request" }, { status: 400 });
        }

        const webhookUrl =
          process.env.N8N_SOD_MENTION_WEBHOOK_URL ||
          process.env.N8N_LEAVE_WEBHOOK_URL ||
          process.env.N8N_INVITE_WEBHOOK_URL;

        if (!webhookUrl) {
          return Response.json(
            { ok: false, configured: false, error: "Notification webhook URL is not configured" },
            { status: 531 },
          );
        }

        const reportTypeLabel = body.reportType === "eod" ? "End of Day (EOD)" : "Start of Day (SOD)";
        const reportTypeShort = (body.reportType || "sod").toUpperCase();
        const appUrl = (process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
        const reportUrl = `${appUrl}/app/sod-eod`;

        // Extract answers containing mentions
        const answersWithMentions = body.answers.filter(
          (a) => Array.isArray(a.mentions) && a.mentions.length > 0,
        );

        if (answersWithMentions.length === 0) {
          return Response.json({ ok: true, mentionsCount: 0, message: "No mentions found to notify" });
        }

        // Build list of target recipient emails
        const targetRecipients: MentionRecipient[] = [];
        const seenEmails = new Set<string>();

        if (Array.isArray(body.recipients) && body.recipients.length > 0) {
          for (const rec of body.recipients) {
            const cleanEmail = rec.email?.trim().toLowerCase();
            if (cleanEmail && cleanEmail !== body.authorEmail.toLowerCase() && !seenEmails.has(cleanEmail)) {
              seenEmails.add(cleanEmail);
              targetRecipients.push({
                email: cleanEmail,
                name: rec.name || cleanEmail.split("@")[0],
                targetName: rec.targetName || rec.name,
                targetType: rec.targetType || "person",
              });
            }
          }
        } else {
          // Fallback if recipients array wasn't passed directly
          for (const answerObj of answersWithMentions) {
            for (const mention of answerObj.mentions || []) {
              if (mention.type === "person" && mention.email) {
                const cleanEmail = mention.email.trim().toLowerCase();
                if (cleanEmail !== body.authorEmail.toLowerCase() && !seenEmails.has(cleanEmail)) {
                  seenEmails.add(cleanEmail);
                  targetRecipients.push({
                    email: cleanEmail,
                    name: mention.name,
                    targetName: mention.name,
                    targetType: "person",
                  });
                }
              }
            }
          }
        }

        if (targetRecipients.length === 0) {
          return Response.json({
            ok: true,
            mentionsCount: 0,
            message: "No external recipient emails found to notify",
          });
        }

        const dispatchedEmails: string[] = [];

        // Build HTML email for each recipient
        for (const recipient of targetRecipients) {
          const recipientName = escapeHtml(recipient.name);
          const authorName = escapeHtml(body.authorName);
          const reportDate = escapeHtml(body.reportDate);
          const targetTagName = escapeHtml(recipient.targetName);
          const isDept = recipient.targetType === "department";

          const subject = `Mentioned in ${reportTypeShort} Report by ${body.authorName} (${body.reportDate})`;

          // Combine answers with mentions into formatted HTML list
          const notesHtml = answersWithMentions
            .map((ans) => {
              const qText = escapeHtml(ans.question);
              const formattedAns = formatMentionsInHtml(ans.answer);
              return `
                <div style="margin-bottom: 16px;">
                  <div style="font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">
                    Question: ${qText}
                  </div>
                  <div style="background-color: #ffffff; border-left: 3px solid #4f46e5; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; border-radius: 0 8px 8px 0; padding: 14px 16px; font-size: 14px; line-height: 1.6; color: #1e293b;">
                    ${formattedAns}
                  </div>
                </div>
              `;
            })
            .join("");

          const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f8fafc; padding: 30px 15px;">
    <tr>
      <td align="center">
        <table width="100%" max-width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,0.05); border: 1px solid #e2e8f0;">
          
          <!-- Header -->
          <tr>
            <td style="background-color: #1e293b; padding: 24px 28px; text-align: left;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <span style="color: #94a3b8; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">
                      Time Station • Daily Report Notification
                    </span>
                    <h1 style="color: #ffffff; font-size: 20px; font-weight: 700; margin: 8px 0 0 0; line-height: 1.3;">
                      Mention in ${escapeHtml(reportTypeLabel)}
                    </h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Content Body -->
          <tr>
            <td style="padding: 28px;">
              <p style="font-size: 14px; margin: 0 0 20px 0; color: #334155;">
                Hello <strong>${recipientName}</strong>,
              </p>
              <p style="font-size: 14px; margin: 0 0 20px 0; color: #334155; line-height: 1.5;">
                <strong>${authorName}</strong> mentioned ${isDept ? `the <strong>${targetTagName}</strong> department` : "you"} in their ${escapeHtml(reportTypeLabel)} report on <strong>${reportDate}</strong>.
              </p>

              <!-- Author Info Card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f1f5f9; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px;">
                <tr>
                  <td style="font-size: 13px; color: #334155;">
                    Submitted by <strong>${authorName}</strong> ${body.authorDeptName ? `(${escapeHtml(body.authorDeptName)})` : ""} on <strong>${reportDate}</strong>
                  </td>
                </tr>
              </table>

              <!-- Notes Box -->
              ${notesHtml}

              <!-- Action Button -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 24px;">
                <tr>
                  <td align="center">
                    <a href="${reportUrl}" target="_blank" style="background-color: #4f46e5; color: #ffffff; text-decoration: none; font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 8px; display: inline-block;">
                      Open Report in Time Station →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 28px; text-align: center;">
              <p style="font-size: 12px; color: #64748b; margin: 0;">
                Time Station Reporting System
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
            reportType: body.reportType || "sod",
            reportDate: body.reportDate,
            authorName: body.authorName,
            authorEmail: body.authorEmail,
            email: {
              to: recipient.email,
              subject,
              html,
            },
          };

          // Post to n8n webhook
          fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(n8nPayload),
          }).catch((err) => console.error("n8n mention notification webhook error:", err));

          dispatchedEmails.push(recipient.email);
        }

        return Response.json({
          ok: true,
          mentionsCount: answersWithMentions.length,
          dispatchedToCount: dispatchedEmails.length,
          dispatchedTo: dispatchedEmails,
          message: "Mention notifications dispatched successfully to n8n webhook",
        });
      },
    },
  },
});
