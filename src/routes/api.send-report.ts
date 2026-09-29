import { createFileRoute } from "@tanstack/react-router";
import { adminMasterKey } from "@/lib/admin-key";

import { deliverReportEmail, type SendReportInput } from "@/lib/report-email";
import { createDocument } from "@/lib/admin-request";
import { newReportHistoryEntry, reportHistoryId } from "@/lib/report-history";

export const Route = createFileRoute("/api/send-report")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(process.env.N8N_REPORT_WEBHOOK_URL),
        }),
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        const masterKey = adminMasterKey();
        const isMasterKey = Boolean(token && token === masterKey);

        const candidateKeys = [
          process.env.VITE_FIREBASE_API_KEY,
          "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw",
          "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY",
        ].filter(Boolean) as string[];

        if (!token) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }

        let authenticatedEmail = isMasterKey ? "system@ironbrij.com.au" : "";

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
                const identityPayload = (await identityResponse.json()) as {
                  users?: Array<{ email?: string }>;
                };
                if (identityPayload.users?.[0]?.email) {
                  authenticatedEmail = identityPayload.users[0].email.toLowerCase();
                  break;
                }
              }
            } catch {}
          }

          if (!authenticatedEmail) {
            return Response.json(
              { ok: false, error: "Invalid authentication token" },
              { status: 401 },
            );
          }
        }

        let body: SendReportInput;
        try {
          body = (await request.json()) as SendReportInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }

        if (!Array.isArray(body.recipientEmails) || body.recipientEmails.length === 0) {
          return Response.json(
            { ok: false, error: "At least one recipient email is required" },
            { status: 400 },
          );
        }

        const delivery = await deliverReportEmail(body, authenticatedEmail);
        if (!delivery.ok) {
          return Response.json({ ok: false, error: delivery.error }, { status: delivery.status });
        }
        // Kept in the report history, saved as the admin who sent it. The master
        // key has no login to save with; the weekly automation saves its own.
        let historySaved = false;
        if (!isMasterKey) {
          const now = new Date();
          const entry = newReportHistoryEntry({
            report: body,
            recipients: delivery.recipients ?? [],
            sentBy: authenticatedEmail,
            source: "screen",
            now,
          });
          historySaved = await createDocument(
            "reportHistory",
            reportHistoryId(entry.companyId, entry.from, now),
            { ...entry },
            token,
          )
            .then(() => true)
            .catch(() => false);
        }
        return Response.json({ ok: true, recipientCount: delivery.recipientCount, historySaved });
      },
    },
  },
});
