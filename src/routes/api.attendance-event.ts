import { createFileRoute } from "@tanstack/react-router";

type AttendanceEventName = "punch_in" | "punch_out";
type AttendancePunchType = "in" | "out" | "extra_in" | "extra_out";

type AttendanceEventInput = {
  event: AttendanceEventName;
  punchId: string;
  punchType: AttendancePunchType;
  employeeId: string;
  employeeName: string;
  employeeEmail: string;
  departmentId?: string;
  departmentName?: string;
  jobTitle?: string;
  country?: string;
  state?: string;
  timezone?: string;
  shiftStartTime?: string;
  shiftEndTime?: string;
  shiftTimezone?: string;
  date: string;
  occurredAt: string;
};

type FirestoreValue = {
  stringValue?: string;
  timestampValue?: string;
};

function validText(value: unknown, maxLength = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function optionalText(value: unknown, maxLength = 500) {
  return typeof value === "undefined" || (typeof value === "string" && value.length <= maxLength);
}

function validEventType(event: unknown, punchType: unknown) {
  if (event !== "punch_in" && event !== "punch_out") return false;
  if (!["in", "out", "extra_in", "extra_out"].includes(String(punchType))) return false;
  return event === "punch_in"
    ? punchType === "in" || punchType === "extra_in"
    : punchType === "out" || punchType === "extra_out";
}

export const Route = createFileRoute("/api/attendance-event")({
  server: {
    handlers: {
      GET: async () =>
        Response.json({
          ok: true,
          configured: Boolean(process.env.N8N_ATTENDANCE_WEBHOOK_URL),
          events: ["punch_in", "punch_out"],
        }),
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const idToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
        const firebaseApiKey = process.env.VITE_FIREBASE_API_KEY;
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
          return Response.json({ ok: false, error: "Invalid login" }, { status: 401 });
        }

        const identityPayload = (await identityResponse.json()) as {
          users?: Array<{ localId?: string; email?: string }>;
        };
        const authenticatedUser = identityPayload.users?.[0];
        const authenticatedEmail = authenticatedUser?.email?.trim().toLowerCase() ?? "";

        let body: AttendanceEventInput;
        try {
          body = (await request.json()) as AttendanceEventInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }

        if (!body || typeof body !== "object") {
          return Response.json({ ok: false, error: "Invalid attendance event" }, { status: 400 });
        }

        const occurredAt = new Date(body.occurredAt);
        if (
          !authenticatedUser?.localId ||
          authenticatedEmail !== body.employeeEmail?.trim().toLowerCase() ||
          authenticatedUser.localId !== body.employeeId ||
          !validEventType(body.event, body.punchType) ||
          !validText(body.punchId, 150) ||
          !validText(body.employeeId, 150) ||
          !validText(body.employeeName, 150) ||
          !validText(body.employeeEmail, 254) ||
          !validText(body.date, 10) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(body.date) ||
          Number.isNaN(occurredAt.getTime()) ||
          !optionalText(body.departmentId, 150) ||
          !optionalText(body.departmentName, 150) ||
          !optionalText(body.jobTitle, 150) ||
          !optionalText(body.country, 10) ||
          !optionalText(body.state, 150) ||
          !optionalText(body.timezone, 100) ||
          !optionalText(body.shiftStartTime, 10) ||
          !optionalText(body.shiftEndTime, 10) ||
          !optionalText(body.shiftTimezone, 100)
        ) {
          return Response.json({ ok: false, error: "Invalid attendance event" }, { status: 400 });
        }

        const webhookUrl = process.env.N8N_ATTENDANCE_WEBHOOK_URL;
        if (!webhookUrl) {
          return Response.json(
            {
              ok: false,
              configured: false,
              error: "N8N_ATTENDANCE_WEBHOOK_URL is not configured",
            },
            { status: 503 },
          );
        }

        const firebaseProjectId = process.env.VITE_FIREBASE_PROJECT_ID;
        if (!firebaseProjectId) {
          return Response.json({ ok: false, error: "Firebase is not configured" }, { status: 503 });
        }

        const punchResponse = await fetch(
          `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/punches/${encodeURIComponent(body.punchId)}`,
          { headers: { authorization: `Bearer ${idToken}` } },
        );
        if (!punchResponse.ok) {
          return Response.json(
            { ok: false, error: "Recorded punch was not found" },
            { status: 409 },
          );
        }

        const punchDocument = (await punchResponse.json()) as {
          fields?: Record<string, FirestoreValue>;
        };
        const punchFields = punchDocument.fields ?? {};
        const recordedEmployeeId = punchFields.employeeId?.stringValue;
        const recordedType = punchFields.type?.stringValue;
        const recordedDate = punchFields.date?.stringValue;
        const recordedSource = punchFields.source?.stringValue;
        const recordedAt = punchFields.timestamp?.timestampValue;
        if (
          recordedEmployeeId !== body.employeeId ||
          recordedType !== body.punchType ||
          recordedDate !== body.date ||
          recordedSource !== "app"
        ) {
          return Response.json(
            { ok: false, error: "Attendance event does not match the recorded punch" },
            { status: 409 },
          );
        }

        const webhookResponse = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: body.event,
            idempotencyKey: `attendance:${body.punchId}:${body.event}`,
            employee: {
              id: body.employeeId,
              authUid: authenticatedUser?.localId || "",
              name: body.employeeName,
              email: body.employeeEmail,
              departmentId: body.departmentId || "",
              departmentName: body.departmentName || "",
              jobTitle: body.jobTitle || "",
              country: body.country || "",
              state: body.state || "",
              timezone: body.timezone || body.shiftTimezone || "",
              shiftStartTime: body.shiftStartTime || "",
              shiftEndTime: body.shiftEndTime || "",
              shiftTimezone: body.shiftTimezone || body.timezone || "",
            },
            attendance: {
              punchId: body.punchId,
              type: body.punchType,
              status: body.event === "punch_in" ? "punched_in" : "punched_out",
              date: body.date,
              occurredAt: recordedAt || occurredAt.toISOString(),
              source: "time_station",
            },
          }),
        });

        if (!webhookResponse.ok) {
          return Response.json(
            { ok: false, error: `Automation webhook returned ${webhookResponse.status}` },
            { status: 502 },
          );
        }

        return Response.json({
          ok: true,
          delivered: true,
          event: body.event,
          employeeId: body.employeeId,
        });
      },
    },
  },
});
