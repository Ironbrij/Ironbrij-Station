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
              "https://vmi3182726.contaboserver.net/webhook/time-station-sod-mention",
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

        if (!authenticatedEmail) {
          return Response.json({ ok: false, error: "Authenticated user email missing" }, { status: 401 });
        }

        // Always override author email with authenticated token email to prevent auth mismatch
        body.authorEmail = authenticatedEmail;

        if (
          !validText(body.reportId, 150) ||
          !validText(body.authorName, 150) ||
          !Array.isArray(body.answers)
        ) {
          return Response.json({ ok: false, error: "Invalid mention notification request" }, { status: 400 });
        }

        const webhookUrl =
          process.env.N8N_SOD_MENTION_WEBHOOK_URL ||
          "https://vmi3182726.contaboserver.net/webhook/time-station-sod-mention";

        const reportTypeLabel = body.reportType === "eod" ? "End of Day (EOD)" : "Start of Day (SOD)";
        const reportTypeShort = (body.reportType || "sod").toUpperCase();
        const appUrl = (process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
        const reportUrl = `${appUrl}/app/sod-eod`;

        // Extract valid answers to include in email
        const answersToProcess = body.answers.filter((a) => a.answer && a.answer.trim().length > 0);
        const finalAnswers = answersToProcess.length > 0 ? answersToProcess : body.answers;

        if (finalAnswers.length === 0) {
          return Response.json({ ok: true, mentionsCount: 0, message: "No answers found to notify" });
        }

        // Build list of target recipient emails
        const targetRecipients: MentionRecipient[] = [];
        const seenEmails = new Set<string>();

        if (Array.isArray(body.recipients) && body.recipients.length > 0) {
          for (const rec of body.recipients) {
            const cleanEmail = rec.email?.trim().toLowerCase();
            if (cleanEmail && !seenEmails.has(cleanEmail)) {
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
          for (const answerObj of finalAnswers) {
            for (const mention of answerObj.mentions || []) {
              if (mention.type === "person" && mention.email) {
                const cleanEmail = mention.email.trim().toLowerCase();
                if (cleanEmail && !seenEmails.has(cleanEmail)) {
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
            message: "No recipient emails found to notify",
          });
        }

        // Build HTML content for answer notes
        const notesHtml = finalAnswers
          .map((ans) => {
            const qText = escapeHtml(ans.question);
            const formattedAns = formatMentionsInHtml(ans.answer);
            return `
              <div style="margin-bottom: 16px;">
                <div style="font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 6px;">
                  ${qText}
                </div>
                <div style="background-color: #ffffff; border-left: 3px solid #4f46e5; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; border-radius: 0 8px 8px 0; padding: 14px 16px; font-size: 14px; line-height: 1.6; color: #1e293b;">
                  ${formattedAns}
                </div>
              </div>
            `;
          })
          .join("");

        const plainAnswerText = finalAnswers.map((a) => `${a.question}: ${a.answer}`).join("\n\n");

        // Format mentions array so n8n "Split Mentions" node receives an item for each employee
        const n8nMentions = targetRecipients.map((recipient) => {
          const recipientName = escapeHtml(recipient.name);
          const authorName = escapeHtml(body.authorName);
          const reportDate = escapeHtml(body.reportDate);
          const targetTagName = escapeHtml(recipient.targetName);
          const isDept = recipient.targetType === "department";

          const firstQuestion = finalAnswers[0]?.question || "";
          const isSupportRequest = firstQuestion.startsWith("Help Request") || firstQuestion.startsWith("Feedback");

          const subject = isSupportRequest
            ? `${firstQuestion} from ${body.authorName}`
            : `Mentioned in ${reportTypeShort} Report by ${body.authorName} (${body.reportDate})`;

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
                    <span style="display: inline-block; background-color: #4f46e5; color: #ffffff; font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;">
                      ${isSupportRequest ? "Support Notification" : `${reportTypeLabel} Notification`}
                    </span>
                    <h1 style="margin: 10px 0 0 0; color: #ffffff; font-size: 20px; font-weight: 700; line-height: 1.3;">
                      ${subject}
                    </h1>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Main Content -->
          <tr>
            <td style="padding: 28px;">
              <p style="margin: 0 0 20px 0; font-size: 15px; color: #334155; line-height: 1.5;">
                Hello <strong>${recipientName}</strong>,
              </p>
              
              <p style="margin: 0 0 20px 0; font-size: 14px; color: #475569; line-height: 1.5;">
                <strong>${authorName}</strong> ${
                  isSupportRequest
                    ? `has submitted a new <strong>${escapeHtml(firstQuestion)}</strong>.`
                    : `has mentioned ${isDept ? `the <strong>${targetTagName}</strong> department` : `you`} in their ${reportTypeLabel} report for <strong>${reportDate}</strong>.`
                }
              </p>

              <!-- Answer Box -->
              <div style="background-color: #f1f5f9; padding: 18px; border-radius: 8px; margin-bottom: 24px;">
                ${notesHtml}
              </div>

              <!-- CTA Button -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding-top: 8px; padding-bottom: 8px;">
                    <a href="${reportUrl}" target="_blank" style="display: inline-block; background-color: #4f46e5; color: #ffffff; font-size: 14px; font-weight: 600; text-decoration: none; padding: 12px 28px; border-radius: 8px; box-shadow: 0 2px 4px rgba(79, 70, 229, 0.2);">
                      Open Time Station
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; padding: 20px 28px; border-top: 1px solid #e2e8f0; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #64748b; line-height: 1.5;">
                Sent automatically by <strong>Time Station</strong> Notification Service.<br>
                Please do not reply directly to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
          `;

          return {
            email: recipient.email,
            recipientEmail: recipient.email,
            name: recipient.name,
            targetName: recipient.targetName,
            targetType: recipient.targetType,
            answer: plainAnswerText,
            subject,
            html,
            message: html,
          };
        });

        // Forward batch mentions payload to n8n webhook
        let n8nResponse: Response;
        try {
          n8nResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              reportId: body.reportId,
              reportType: body.reportType || "sod",
              reportDate: body.reportDate,
              authorName: body.authorName,
              authorEmail: body.authorEmail,
              authorDeptName: body.authorDeptName || "",
              answer: plainAnswerText,
              mentions: n8nMentions,
            }),
          });
        } catch (fetchErr) {
          console.error("n8n webhook network error:", fetchErr);
          return Response.json(
            { ok: false, error: "Failed to connect to n8n webhook service" },
            { status: 502 },
          );
        }

        if (!n8nResponse.ok) {
          const n8nErrText = await n8nResponse.text().catch(() => "");
          console.error("n8n webhook error response:", n8nResponse.status, n8nErrText);
          return Response.json(
            { ok: false, error: `n8n webhook returned status ${n8nResponse.status}` },
            { status: 502 },
          );
        }

        return Response.json({
          ok: true,
          mentionsCount: n8nMentions.length,
          recipients: targetRecipients.map((r) => r.email),
        });
      },
    },
  },
});
