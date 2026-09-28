import { createFileRoute } from "@tanstack/react-router";
import { patchIfUnchanged } from "@/lib/firestore-rest";
import {
  buildDecisionNoticeEmail,
  buildVaWorkEmail,
  describeDecision,
  isResponseToken,
  type HolidayDecision,
  type HolidayResponse,
} from "@/lib/holiday-response";

/**
 * Saves a client's Work on Holiday / Do Not Work answer from the page their
 * holiday email links to. The token in the link is the only key: it is random
 * and only ever sent to that client. An answer is saved once; after that the
 * client replies to the email to change it.
 *
 * When the client wants their VA to work, the VA is emailed; either way the
 * admin who sent the notice is told, for billing.
 */

function firestoreConfig() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "ironbrij-timestation";
  return {
    apiKey: process.env.VITE_FIREBASE_API_KEY || "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw",
    baseUrl: `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`,
  };
}

export const Route = createFileRoute("/api/holiday-response")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { token?: unknown; decision?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        const { token, decision } = body;
        if (!isResponseToken(token) || (decision !== "work" && decision !== "off")) {
          return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
        }

        const saved = await patchIfUnchanged({
          ...firestoreConfig(),
          path: `holidayResponses/${token}`,
          update: { decision, decidedAt: new Date().toISOString() },
          check: (current) =>
            current.decision
              ? `You already answered: ${describeDecision(current.decision as HolidayDecision)}. To change it, please reply to our email.`
              : null,
        });
        if (!saved.ok) {
          return Response.json(
            { ok: false, error: saved.status === 404 ? "This link is not valid." : saved.message },
            { status: saved.status },
          );
        }

        const response = saved.before as unknown as HolidayResponse;
        const webhookUrl =
          process.env.N8N_HOLIDAY_WEBHOOK_URL ||
          process.env.N8N_REPORT_WEBHOOK_URL ||
          "https://vmi3182726.contaboserver.net/webhook/time-station-report-email";
        const send = async (payload: Record<string, unknown>) => {
          try {
            const result = await fetch(webhookUrl, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            });
            return result.ok;
          } catch {
            return false;
          }
        };

        let vasTold = 0;
        if (decision === "work") {
          for (const va of response.vas ?? []) {
            if (!va.email?.includes("@")) continue;
            const email = buildVaWorkEmail(response, va);
            if (
              await send({
                event: "holiday_work_request",
                company: response.company,
                employeeId: va.id,
                employeeName: va.name,
                email: { to: va.email, ...email },
              })
            )
              vasTold += 1;
          }
        }
        const office =
          response.notifyEmail || process.env.LEAVE_MANAGER_EMAIL || "pabibek9@gmail.com";
        const notice = buildDecisionNoticeEmail(response, decision);
        await send({
          event: "holiday_client_answer",
          company: response.company,
          email: { to: office, ...notice },
        });

        return Response.json({ ok: true, decision, vasTold });
      },
    },
  },
});
