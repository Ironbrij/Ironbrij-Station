import { createFileRoute } from "@tanstack/react-router";
import { escapeEmailHtml, renderCompanyEmail, renderEmailDetails } from "@/lib/email-template";
import type { MentionNotificationRequest, MentionRecipient } from "@/lib/mention-notifications";

function validText(value: unknown, maxLength = 1000): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function formatMentionsInHtml(text: string): string {
  return escapeEmailHtml(text).replace(
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

        let body: MentionNotificationRequest;
        try {
          body = (await request.json()) as MentionNotificationRequest;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }

        if (!authenticatedEmail) {
          return Response.json(
            { ok: false, error: "Authenticated user email missing" },
            { status: 401 },
          );
        }
        body.authorEmail = authenticatedEmail;

        if (
          !validText(body.reportId, 150) ||
          !validText(body.authorName, 150) ||
          !Array.isArray(body.answers)
        ) {
          return Response.json(
            { ok: false, error: "Invalid mention notification request" },
            { status: 400 },
          );
        }

        const webhookUrl =
          process.env.N8N_SOD_MENTION_WEBHOOK_URL ||
          "https://vmi3182726.contaboserver.net/webhook/time-station-sod-mention";
        const reportTypeLabel =
          body.reportType === "eod" ? "End of Day (EOD)" : "Start of Day (SOD)";
        const reportTypeShort = (body.reportType || "sod").toUpperCase();
        const appUrl = (process.env.APP_URL || new URL(request.url).origin).replace(/\/+$/, "");
        const answersToProcess = body.answers.filter((answer) => answer.answer?.trim());
        const finalAnswers = answersToProcess.length > 0 ? answersToProcess : body.answers;

        if (finalAnswers.length === 0) {
          return Response.json({
            ok: true,
            mentionsCount: 0,
            message: "No answers found to notify",
          });
        }

        const targetRecipients: MentionRecipient[] = [];
        const seenEmails = new Set<string>();
        if (Array.isArray(body.recipients) && body.recipients.length > 0) {
          for (const recipient of body.recipients) {
            const email = recipient.email?.trim().toLowerCase();
            if (!email || seenEmails.has(email)) continue;
            seenEmails.add(email);
            targetRecipients.push({
              email,
              name: recipient.name || email.split("@")[0],
              targetName: recipient.targetName || recipient.name,
              targetType: recipient.targetType || "person",
            });
          }
        } else {
          for (const answer of finalAnswers) {
            for (const mention of answer.mentions || []) {
              const email = mention.type === "person" ? mention.email?.trim().toLowerCase() : "";
              if (!email || seenEmails.has(email)) continue;
              seenEmails.add(email);
              targetRecipients.push({
                email,
                name: mention.name,
                targetName: mention.name,
                targetType: "person",
              });
            }
          }
        }

        if (targetRecipients.length === 0) {
          return Response.json(
            {
              ok: false,
              mentionsCount: 0,
              error: "No recipient email addresses were found for the selected mentions",
            },
            { status: 422 },
          );
        }

        const notesHtml = finalAnswers
          .map(
            (
              answer,
              index,
            ) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${index > 0 ? "margin-top: 14px;" : ""} border: 1px solid #dbe4ee; border-radius: 10px; border-collapse: separate; overflow: hidden;">
              <tr><td style="padding: 11px 16px; background-color: #f6f8fb; border-bottom: 1px solid #dbe4ee; color: #64748b; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">${escapeEmailHtml(answer.question)}</td></tr>
              <tr><td style="padding: 16px; background-color: #ffffff; color: #243447; font-size: 15px; line-height: 24px; white-space: pre-wrap;">${formatMentionsInHtml(answer.answer)}</td></tr>
            </table>`,
          )
          .join("");
        const plainAnswerText = finalAnswers
          .map((answer) => `${answer.question}: ${answer.answer}`)
          .join("\n\n");

        const firstQuestion = finalAnswers[0]?.question || "";
        const isSupportRequest =
          firstQuestion.startsWith("Help Request") || firstQuestion.startsWith("Feedback");
        const notificationLabel = isSupportRequest
          ? firstQuestion.startsWith("Feedback")
            ? "Feedback"
            : "Help request"
          : `${reportTypeShort} report`;

        const n8nMentions = targetRecipients.map((recipient) => {
          const authorName = escapeEmailHtml(body.authorName);
          const targetTagName = escapeEmailHtml(recipient.targetName);
          const subject = isSupportRequest
            ? `${firstQuestion} from ${body.authorName}`
            : `Mentioned in ${reportTypeShort} Report by ${body.authorName} (${body.reportDate})`;
          const headline = isSupportRequest
            ? firstQuestion
            : `You were mentioned in a ${reportTypeShort} report`;
          const introduction = isSupportRequest
            ? `<strong style="color: #16283f;">${authorName}</strong> submitted this ${notificationLabel.toLowerCase()} for the team to review.`
            : `<strong style="color: #16283f;">${authorName}</strong> mentioned ${recipient.targetType === "department" ? `the <strong style="color: #16283f;">${targetTagName}</strong> department` : "you"} in their ${escapeEmailHtml(reportTypeLabel)} report.`;
          const contentHtml = `
            <p style="margin: 0 0 12px; color: #243447; font-size: 16px; line-height: 25px;">Hello ${escapeEmailHtml(recipient.name)},</p>
            <p style="margin: 0 0 24px; color: #526477; font-size: 15px; line-height: 24px;">${introduction}</p>
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom: 24px;">${renderEmailDetails(
              [
                { label: "From", value: body.authorName },
                { label: "Department", value: body.authorDeptName || "Not specified" },
                { label: "Date", value: body.reportDate },
              ],
            )}</table>
            <p style="margin: 0 0 12px; color: #64748b; font-size: 11px; line-height: 16px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;">Details</p>
            ${notesHtml}`;
          const html = renderCompanyEmail({
            company: body.company,
            preheader: isSupportRequest
              ? `${body.authorName} submitted a new ${notificationLabel.toLowerCase()}.`
              : `${body.authorName} mentioned you in a ${reportTypeShort} report.`,
            label: notificationLabel,
            title: headline,
            introHtml: "A concise update from your workspace.",
            contentHtml,
            cta: {
              label: isSupportRequest ? "View Help & Feedback" : "View SOD & EOD reports",
              url: `${appUrl}${isSupportRequest ? "/app/automation" : "/app/sod-eod"}`,
            },
          });

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

        let n8nResponse: Response;
        try {
          n8nResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              company: body.company,
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
        } catch (error) {
          console.error("n8n webhook network error:", error);
          return Response.json(
            { ok: false, error: "Failed to connect to n8n webhook service" },
            { status: 502 },
          );
        }

        const n8nResponseText = await n8nResponse.text().catch(() => "");
        if (!n8nResponse.ok) {
          console.error("n8n webhook error response:", n8nResponse.status, n8nResponseText);
          return Response.json(
            { ok: false, error: `n8n webhook returned status ${n8nResponse.status}` },
            { status: 502 },
          );
        }

        const n8nResult = (() => {
          try {
            return JSON.parse(n8nResponseText) as { ok?: boolean; error?: string };
          } catch {
            return null;
          }
        })();
        if (n8nResult?.ok !== true) {
          console.error("n8n webhook did not confirm email delivery:", n8nResponseText);
          return Response.json(
            { ok: false, error: n8nResult?.error || "Email workflow did not confirm delivery" },
            { status: 502 },
          );
        }

        return Response.json({
          ok: true,
          mentionsCount: n8nMentions.length,
          recipients: targetRecipients.map((recipient) => recipient.email),
        });
      },
    },
  },
});
