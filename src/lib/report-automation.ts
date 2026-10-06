import { adminMasterKey } from "./admin-key.ts";
import { fromFirestoreFields, type FirestoreValue } from "./firestore-rest.ts";
import { readReportEdits, reportEditsDocId } from "./report-edits.ts";
import type { ReportRow } from "./report-rows.ts";

/**
 * What the report routes that a scheduler calls (weekly and daily) have in
 * common: reading Firestore without a signed-in user, checking the scheduler's
 * key, and totalling rows. The routes themselves only decide what to send.
 */

export function getFirestoreConfig() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID || "ironbrij-timestation";
  const apiKey = process.env.VITE_FIREBASE_API_KEY || "AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw";
  return {
    apiKey,
    baseUrl: `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`,
  };
}

/** Reads a whole collection, following Firestore's paging. */
export async function listCollection<T>(collection: string, pageLimit = 40): Promise<T[]> {
  const { baseUrl, apiKey } = getFirestoreConfig();
  const out: T[] = [];
  let pageToken = "";
  for (let page = 0; page < pageLimit; page += 1) {
    const url = new URL(`${baseUrl}/${collection}`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Could not read ${collection}: ${response.status}`);
    }
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

/**
 * Documents whose date field falls within a period. Punches and overtime grow
 * every day, so the period is pushed down to Firestore rather than reading the
 * whole collection on every run.
 */
export async function listWithinDates<T>(
  collectionId: string,
  field: string,
  from: string,
  to: string,
): Promise<T[]> {
  const { baseUrl, apiKey } = getFirestoreConfig();
  const response = await fetch(`${baseUrl}:runQuery?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: field },
                  op: "GREATER_THAN_OR_EQUAL",
                  value: { stringValue: from },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: field },
                  op: "LESS_THAN_OR_EQUAL",
                  value: { stringValue: to },
                },
              },
            ],
          },
        },
        limit: 5000,
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not read ${collectionId}: ${response.status}`);
  }
  const rows = (await response.json()) as {
    document?: { name: string; fields?: Record<string, FirestoreValue> };
  }[];
  return rows
    .filter((row) => row.document)
    .map(
      (row) =>
        ({
          ...fromFirestoreFields(row.document!.fields),
          id: row.document!.name.split("/").pop(),
        }) as T,
    );
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function parseRecipients(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,;\s]+/)
      : [];
  return [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(validEmail))];
}

/**
 * The master key, or any active key minted on the MCP Connect page. A scheduler
 * is configured with a minted key, and rejecting those made the automation fail
 * at its first call.
 */
export async function isAuthorisedKey(token: string): Promise<boolean> {
  if (!token || token.length < 20) return false;
  const masterKey = adminMasterKey();
  if (token === masterKey) return true;
  const { baseUrl, apiKey } = getFirestoreConfig();
  const response = await fetch(
    `${baseUrl}/adminApiTokens/${encodeURIComponent(token)}?key=${encodeURIComponent(apiKey)}`,
  );
  if (!response.ok) return false;
  const data = (await response.json()) as { fields?: Record<string, FirestoreValue> };
  return fromFirestoreFields(data.fields).active !== false;
}

export function summariseRows(rows: ReportRow[]) {
  return rows.reduce(
    (acc, row) => ({
      totalHours: acc.totalHours + (Number(row.regularHours) || 0),
      totalOvertime: acc.totalOvertime + (Number(row.overtimeHours) || 0),
      totalPaidLeave: acc.totalPaidLeave + (Number(row.paidLeaveDays) || 0),
      totalUnpaidLeave: acc.totalUnpaidLeave + (Number(row.unpaidLeaveDays) || 0),
      totalEmployees: acc.totalEmployees + 1,
    }),
    {
      totalHours: 0,
      totalOvertime: 0,
      totalPaidLeave: 0,
      totalUnpaidLeave: 0,
      totalEmployees: 0,
    },
  );
}

/**
 * The edits an admin saved on the Reports page for this company and period, if
 * any. The emailed report lays them over the calculated rows exactly as the
 * screen does, so a client never receives numbers that differ from it.
 */
export async function readSavedReportEdits(companyFilter: string, from: string, to: string) {
  const { baseUrl, apiKey } = getFirestoreConfig();
  const response = await fetch(
    `${baseUrl}/reportEdits/${encodeURIComponent(reportEditsDocId(companyFilter, from, to))}?key=${encodeURIComponent(apiKey)}`,
  );
  if (response.status === 404) return { edits: null, readable: true };
  if (!response.ok) return { edits: null, readable: false };
  const data = (await response.json()) as { fields?: Record<string, FirestoreValue> };
  return { edits: readReportEdits(fromFirestoreFields(data.fields)), readable: true };
}
