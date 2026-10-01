/**
 * For server routes an admin calls with their own login: checks the login is an
 * admin's, and reads Firestore as that admin, so a route can never read or mail
 * more than the admin could see.
 */

import { toFirestoreFields } from "./firestore-rest.ts";

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

export async function readDocument<T>(path: string, idToken: string): Promise<T | null> {
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

export async function listCollection<T>(collection: string, idToken: string): Promise<T[]> {
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

export async function lookupIdentity(idToken: string) {
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

export async function isAdmin(identity: { email: string; uid: string }, idToken: string) {
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

/** The admin behind a request's login, or the response to send instead. */
export async function requireAdmin(
  request: Request,
): Promise<{ idToken: string; email: string } | { response: Response }> {
  const authorization = request.headers.get("authorization");
  const idToken = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!idToken) {
    return { response: Response.json({ ok: false, error: "Unauthorized" }, { status: 401 }) };
  }
  const identity = await lookupIdentity(idToken);
  if (!identity) {
    return {
      response: Response.json({ ok: false, error: "Invalid login token" }, { status: 401 }),
    };
  }
  if (!(await isAdmin(identity, idToken))) {
    return {
      response: Response.json({ ok: false, error: "Admin access required" }, { status: 403 }),
    };
  }
  return { idToken, email: identity.email };
}

/**
 * A login for scheduled jobs that run with no admin present, such as the weekly
 * report: a Firebase account set in AUTOMATION_EMAIL and AUTOMATION_PASSWORD,
 * which must be an admin. Null when none is set or it cannot sign in.
 */
export async function automationIdToken(): Promise<string | null> {
  const email = process.env.AUTOMATION_EMAIL?.trim();
  const password = process.env.AUTOMATION_PASSWORD;
  if (!email || !password) return null;
  const apiKey = process.env.VITE_FIREBASE_API_KEY || "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw";
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { idToken?: string };
    return payload.idToken || null;
  } catch {
    return null;
  }
}

/** Sets some top-level fields of an existing document, as the admin. */
export async function patchDocument(
  path: string,
  data: Record<string, unknown>,
  idToken: string,
): Promise<void> {
  const mask = Object.keys(data)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join("&");
  const response = await fetch(
    `${firestoreBaseUrl()}/${path}?${mask}&currentDocument.exists=true`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: toFirestoreFields(data) }),
    },
  );
  if (!response.ok) throw new Error(`Could not update ${path}: ${response.status}`);
}

/** Creates a document under a chosen id, as the admin. */
export async function createDocument(
  collection: string,
  id: string,
  data: Record<string, unknown>,
  idToken: string,
): Promise<void> {
  const response = await fetch(
    `${firestoreBaseUrl()}/${collection}?documentId=${encodeURIComponent(id)}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fields: toFirestoreFields(data) }),
    },
  );
  if (!response.ok) throw new Error(`Could not save ${collection}/${id}: ${response.status}`);
}
