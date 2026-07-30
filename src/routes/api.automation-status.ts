import { createFileRoute } from "@tanstack/react-router";

type FirestoreValue = {
  booleanValue?: boolean;
  stringValue?: string;
};

function stringField(fields: Record<string, FirestoreValue>, name: string) {
  return fields[name]?.stringValue || "";
}

function privateResponse(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store, private",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export const Route = createFileRoute("/api/automation-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
        if (!/^[a-f0-9]{64}$/i.test(token)) {
          return privateResponse({ ok: false, error: "Personal API not found" }, 404);
        }

        const firebaseProjectId = process.env.VITE_FIREBASE_PROJECT_ID;
        const firebaseApiKey = process.env.VITE_FIREBASE_API_KEY;
        if (!firebaseProjectId || !firebaseApiKey) {
          return privateResponse({ ok: false, error: "API is not configured" }, 503);
        }

        const profileResponse = await fetch(
          `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/automationProfiles/${encodeURIComponent(token)}?key=${encodeURIComponent(firebaseApiKey)}`,
        );
        if (profileResponse.status === 404 || profileResponse.status === 403) {
          return privateResponse({ ok: false, error: "Personal API not found" }, 404);
        }
        if (!profileResponse.ok) {
          return privateResponse({ ok: false, error: "Could not read attendance status" }, 502);
        }

        const profileDocument = (await profileResponse.json()) as {
          fields?: Record<string, FirestoreValue>;
        };
        const fields = profileDocument.fields ?? {};
        const enabled = fields.enabled?.booleanValue === true;
        if (!enabled) {
          return privateResponse({ ok: false, error: "Personal API is disabled" }, 410);
        }

        const event = stringField(fields, "event");
        const eventId = stringField(fields, "eventId");
        const after = new URL(request.url).searchParams.get("after")?.trim() ?? "";

        return privateResponse({
          ok: true,
          changed: !after || after !== eventId,
          employee: {
            id: stringField(fields, "employeeId"),
            name: stringField(fields, "employeeName"),
          },
          attendance: {
            status: stringField(fields, "status"),
            isPunchedIn: fields.isPunchedIn?.booleanValue === true,
            event: event === "snapshot" ? null : event,
            eventId,
            punchId: stringField(fields, "punchId") || null,
            punchType: stringField(fields, "punchType") || null,
            date: stringField(fields, "date") || null,
            occurredAt: stringField(fields, "occurredAt") || null,
          },
        });
      },
    },
  },
});
