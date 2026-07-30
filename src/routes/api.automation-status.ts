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

async function handleAutomationStatusRequest(request: Request) {
  const url = new URL(request.url);
  let token = url.searchParams.get("token")?.trim() ?? "";
  let after = url.searchParams.get("after")?.trim() ?? "";

  if (!token && request.method === "POST") {
    try {
      const body = (await request.json()) as { token?: string; after?: string };
      if (body?.token) token = body.token.trim();
      if (body?.after) after = body.after.trim();
    } catch {
      // Ignore body parsing errors
    }
  }

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return privateResponse({ ok: false, error: "Personal API not found" }, 404);
  }

  const firebaseProjectId = process.env.VITE_FIREBASE_PROJECT_ID || "ironbrij-timestation";
  const firebaseApiKey =
    process.env.VITE_FIREBASE_API_KEY || "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw";

  const profileResponse = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/automationProfiles/${encodeURIComponent(token)}?key=${encodeURIComponent(firebaseApiKey)}`,
  );
  if (profileResponse.status === 404) {
    return privateResponse({ ok: false, error: "Personal API not found" }, 404);
  }
  if (!profileResponse.ok) {
    const errorJson = (await profileResponse.json().catch(() => null)) as {
      error?: { message?: string; status?: string; code?: number };
    } | null;
    return privateResponse(
      {
        ok: false,
        error: errorJson?.error?.message || "Could not read attendance status",
        firestoreStatus: profileResponse.status,
      },
      profileResponse.status >= 400 && profileResponse.status < 600 ? profileResponse.status : 502,
    );
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
}

export const Route = createFileRoute("/api/automation-status")({
  server: {
    handlers: {
      GET: async ({ request }) => handleAutomationStatusRequest(request),
      POST: async ({ request }) => handleAutomationStatusRequest(request),
    },
  },
});
