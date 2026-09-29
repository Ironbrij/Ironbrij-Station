import { createFileRoute } from "@tanstack/react-router";
import { patchIfUnchanged } from "@/lib/firestore-rest";
import { isResponseToken } from "@/lib/holiday-response";
import {
  buildDstDecisionNoticeEmail,
  buildVaDstDecisionEmail,
  describeDstDecision,
  type DstDecision,
  type DstResponse,
  type DstResponseLine,
} from "@/lib/dst-response";

/**
 * Saves a client's daylight saving choice from the page their notice links to:
 * follow their new DST schedule, or keep the VA's current hours. The token in
 * the link is the only key. A choice is saved once; after that the client
 * replies to the email to change it. Each VA is then emailed their hours, and
 * the admin who sent the notice is told, with what to change when the VA keeps
 * their hours.
 */

function firestoreConfig() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "ironbrij-timestation";
  return {
    apiKey: process.env.VITE_FIREBASE_API_KEY || "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw",
    baseUrl: `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`,
  };
}

export const Route = createFileRoute("/api/dst-response")({
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
        if (!isResponseToken(token) || (decision !== "follow" && decision !== "keep")) {
          return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
        }

        const saved = await patchIfUnchanged({
          ...firestoreConfig(),
          path: `dstResponses/${token}`,
          update: { decision, decidedAt: new Date().toISOString() },
          check: (current) =>
            current.decision
              ? `You already chose: ${describeDstDecision(current.decision as DstDecision, String(current.keepLabel || "Keep current schedule"))}. To change it, please reply to our email.`
              : null,
        });
        if (!saved.ok) {
          return Response.json(
            { ok: false, error: saved.status === 404 ? "This link is not valid." : saved.message },
            { status: saved.status },
          );
        }

        const response = saved.before as unknown as DstResponse;
        const webhookUrl =
          process.env.N8N_DST_WEBHOOK_URL ||
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

        // One email per VA, covering every shift they work for this client.
        const byVa = new Map<string, DstResponseLine[]>();
        for (const line of response.lines ?? []) {
          byVa.set(line.id, [...(byVa.get(line.id) ?? []), line]);
        }
        let vasTold = 0;
        for (const lines of byVa.values()) {
          const address = lines[0].email;
          if (!address?.includes("@")) continue;
          const email = buildVaDstDecisionEmail(response, lines, decision);
          if (
            await send({
              event: "dst_va_decision",
              company: response.company,
              employeeId: lines[0].id,
              employeeName: lines[0].name,
              email: { to: address, ...email },
            })
          )
            vasTold += 1;
        }

        const office =
          response.notifyEmail || process.env.LEAVE_MANAGER_EMAIL || "pabibek9@gmail.com";
        await send({
          event: "dst_client_answer",
          company: response.company,
          email: { to: office, ...buildDstDecisionNoticeEmail(response, decision, vasTold) },
        });

        return Response.json({ ok: true, decision, vasTold });
      },
    },
  },
});
