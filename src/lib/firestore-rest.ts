/**
 * Reading and writing Firestore over REST, for the server routes (MCP, the
 * weekly report) that cannot use the web SDK.
 *
 * Each route used to carry its own copy of this encoding, and they disagreed:
 * one wrote punch times as a plain map, so the app's time-range queries never
 * found those punches, and one dropped timestamps when reading, so every punch
 * the app made read back as 1970. There is one codec now.
 */

export type FirestoreValue = Record<string, unknown>;

export function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.filter((item) => item !== undefined).map((item) => toFirestoreValue(item)),
      },
    };
  }
  if (typeof value === "object" && value) {
    return { mapValue: { fields: toFirestoreFields(value as Record<string, unknown>) } };
  }
  return { stringValue: String(value) };
}

/** A plain object as Firestore fields. Dates become real timestamps. */
export function toFirestoreFields(obj: Record<string, unknown>): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    fields[key] = toFirestoreValue(value);
  }
  return fields;
}

/** Timestamps read back as ISO strings, which `new Date()` and `toDate()` accept. */
export function fromFirestoreValue(value: FirestoreValue): unknown {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("referenceValue" in value) return value.referenceValue;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromFirestoreFields(fields: Record<string, FirestoreValue> | undefined): any {
  const out: Record<string, unknown> = {};
  if (!fields) return out;
  for (const [key, value] of Object.entries(fields)) out[key] = fromFirestoreValue(value);
  return out;
}

export type ConditionalPatchResult =
  { ok: true; before: Record<string, unknown> } | { ok: false; status: number; message: string };

/**
 * Updates fields of an existing document, only if `check` accepts what is saved
 * now and nobody changes it before the update lands.
 *
 * A bare PATCH creates the document when the id is wrong, and overwrites a
 * decision someone else just made. This reads the document, lets `check` turn
 * the change away (return a message), and writes with the read's update time as
 * a precondition, so a change in between fails instead of being overwritten.
 */
export async function patchIfUnchanged({
  baseUrl,
  apiKey,
  path,
  update,
  check,
  fetchImpl = fetch,
}: {
  baseUrl: string;
  apiKey: string;
  path: string;
  update: Record<string, unknown>;
  check?: (current: Record<string, unknown>) => string | null;
  fetchImpl?: typeof fetch;
}): Promise<ConditionalPatchResult> {
  // A masked field with no value is deleted by Firestore: a missing decision
  // would erase the request's status rather than set it.
  const missing = Object.keys(update).filter((field) => update[field] === undefined);
  if (missing.length > 0) {
    return { ok: false, status: 400, message: `Missing ${missing.join(", ")}.` };
  }
  const key = `key=${encodeURIComponent(apiKey)}`;
  const current = await fetchImpl(`${baseUrl}/${path}?${key}`);
  if (current.status === 404) return { ok: false, status: 404, message: `${path} does not exist.` };
  if (!current.ok) return { ok: false, status: current.status, message: `Could not read ${path}.` };
  const document = (await current.json()) as {
    fields?: Record<string, FirestoreValue>;
    updateTime?: string;
  };
  const before = fromFirestoreFields(document.fields);
  const refusal = check?.(before);
  if (refusal) return { ok: false, status: 409, message: refusal };

  const mask = Object.keys(update)
    .map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`)
    .join("&");
  const precondition = document.updateTime
    ? `currentDocument.updateTime=${encodeURIComponent(document.updateTime)}`
    : "currentDocument.exists=true";
  const response = await fetchImpl(`${baseUrl}/${path}?${mask}&${precondition}&${key}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(update) }),
  });
  if (response.status === 400 || response.status === 409 || response.status === 412) {
    const body = await response.text().catch(() => "");
    if (/FAILED_PRECONDITION|precondition/i.test(body) || response.status !== 400) {
      return {
        ok: false,
        status: 409,
        message: `${path} changed while it was being updated. Read it again and retry.`,
      };
    }
    return { ok: false, status: 400, message: `Could not update ${path}: ${body.slice(0, 200)}` };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, message: `Could not update ${path}.` };
  }
  return { ok: true, before };
}
