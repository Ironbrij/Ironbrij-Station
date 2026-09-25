import { createFileRoute } from "@tanstack/react-router";
import type { CompanyEmailBranding } from "@/lib/email-branding";
import { resolveAppUrl } from "@/lib/app-url";
import { sendLeaveTeamNotice } from "@/lib/leave-team-email";
import type { LeaveTeamNoticeEvent } from "@/lib/leave-team-notice";
import type { Department, Employee, LeaveRequest } from "@/lib/types";

/**
 * Tells the teams a department has chosen (for example the Creative Team) that
 * a colleague will be away. Called by the admin screen right after a leave is
 * approved, or after an approved leave is revoked.
 *
 * Recipients and dates are read from Firestore here with the admin's own login,
 * never taken from the request, so the endpoint cannot be used to mail anyone else.
 */

type LeaveTeamNotificationInput = {
  company?: CompanyEmailBranding;
  leaveRequestId: string;
  event: LeaveTeamNoticeEvent;
};

type FirestoreValue = Record<string, unknown>;

function fromFirestoreFields(
  fields: Record<string, FirestoreValue> | undefined,
): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = fromFirestoreValue(value);
  return out;
}

function fromFirestoreValue(value: FirestoreValue): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) {
    const values = (value.arrayValue as { values?: FirestoreValue[] })?.values || [];
    return values.map(fromFirestoreValue);
  }
  if ("mapValue" in value) {
    return fromFirestoreFields(
      (value.mapValue as { fields?: Record<string, FirestoreValue> })?.fields,
    );
  }
  return null;
}

function firestoreBaseUrl() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "ironbrij-timestation";
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

async function readDocument<T>(path: string, idToken: string): Promise<T | null> {
  const response = await fetch(`${firestoreBaseUrl()}/${path}`, {
    headers: { authorization: `Bearer ${idToken}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read ${path}: ${response.status}`);
  const document = (await response.json()) as {
    name: string;
    fields?: Record<string, FirestoreValue>;
  };
  return { ...fromFirestoreFields(document.fields), id: document.name.split("/").pop() } as T;
}

async function listCollection<T>(collection: string, idToken: string): Promise<T[]> {
  const out: T[] = [];
  let pageToken = "";
  for (let page = 0; page < 40; page += 1) {
    const url = new URL(`${firestoreBaseUrl()}/${collection}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) throw new Error(`Could not read ${collection}: ${response.status}`);
    const data = (await response.json()) as {
      documents?: { name: string; fields?: Record<string, FirestoreValue> }[];
      nextPageToken?: string;
    };
    for (const document of data.documents || []) {
      out.push({
        ...fromFirestoreFields(document.fields),
        id: document.name.split("/").pop(),
      } as T);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

async function lookupIdentity(idToken: string) {
  const candidateKeys = [
    process.env.VITE_FIREBASE_API_KEY,
    "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw",
    "AIzaSyB9AGWeDsY3qEzFQaoZvIK9vDAkExpIXpY",
  ].filter(Boolean) as string[];
  for (const apiKey of candidateKeys) {
    try {
      const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ idToken }),
        },
      );
      if (!response.ok) continue;
      const payload = (await response.json()) as {
        users?: Array<{ localId?: string; email?: string }>;
      };
      const user = payload.users?.[0];
      if (user?.email) return { email: user.email.toLowerCase(), uid: user.localId || "" };
    } catch {
      // Try the next key.
    }
  }
  return null;
}

async function isAdmin(identity: { email: string; uid: string }, idToken: string) {
  const configuredAdmins = (
    process.env.LEAVE_ADMIN_EMAILS ??
    "pabibek9@gmail.com,bibekparajuli05@gmail.com,louis@ironbrij.com.au,rose@ironbrij.com.au,ann@ironbrij.com.au,mv@ironbrij.com.au,admin@ironbrij.com.au"
  )
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (configuredAdmins.includes(identity.email)) return true;
  if (!identity.uid) return false;
  return Boolean(await readDocument(`admins/${identity.uid}`, idToken).catch(() => null));
}

export const Route = createFileRoute("/api/leave-team-notification")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authorization = request.headers.get("authorization");
        const idToken = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
        if (!idToken) {
          return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
        }
        const identity = await lookupIdentity(idToken);
        if (!identity) {
          return Response.json({ ok: false, error: "Invalid login token" }, { status: 401 });
        }
        if (!(await isAdmin(identity, idToken))) {
          return Response.json({ ok: false, error: "Admin access required" }, { status: 403 });
        }

        let body: LeaveTeamNotificationInput;
        try {
          body = (await request.json()) as LeaveTeamNotificationInput;
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
        }
        if (
          typeof body.leaveRequestId !== "string" ||
          !/^[A-Za-z0-9_-]{1,150}$/.test(body.leaveRequestId) ||
          (body.event !== "approved" && body.event !== "revoked")
        ) {
          return Response.json({ ok: false, error: "Invalid request" }, { status: 400 });
        }

        let leave: LeaveRequest | null;
        let employees: Employee[];
        let departments: Department[];
        try {
          [leave, employees, departments] = await Promise.all([
            readDocument<LeaveRequest>(`leaveRequests/${body.leaveRequestId}`, idToken),
            listCollection<Employee>("employees", idToken),
            listCollection<Department>("departments", idToken),
          ]);
        } catch (error) {
          return Response.json({ ok: false, error: (error as Error).message }, { status: 502 });
        }
        if (!leave) {
          return Response.json({ ok: false, error: "Leave request not found" }, { status: 404 });
        }

        const result = await sendLeaveTeamNotice({
          event: body.event,
          leaveRequestId: body.leaveRequestId,
          leave,
          employees,
          departments,
          company: body.company || { name: "SavyTimes" },
          appUrl: resolveAppUrl(request.url),
        });
        if (!result.ok) {
          return Response.json({ ok: false, error: result.error }, { status: result.status });
        }
        return Response.json({ ok: true, sent: result.sent });
      },
    },
  },
});
