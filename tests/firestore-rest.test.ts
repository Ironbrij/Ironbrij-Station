import test from "node:test";
import assert from "node:assert/strict";
import {
  fromFirestoreFields,
  patchIfUnchanged,
  toFirestoreFields,
} from "../src/lib/firestore-rest.ts";

test("a punch time is written as a real timestamp, not a plain map", () => {
  const fields = toFirestoreFields({ timestamp: new Date("2026-09-10T01:02:03.000Z") });
  assert.deepEqual(fields.timestamp, { timestampValue: "2026-09-10T01:02:03.000Z" });
});

test("timestamps read back instead of being dropped", () => {
  const read = fromFirestoreFields({
    timestamp: { timestampValue: "2026-09-10T01:02:03.000Z" },
    nested: { mapValue: { fields: { at: { timestampValue: "2026-01-01T00:00:00Z" } } } },
  });
  assert.equal(new Date(read.timestamp).toISOString(), "2026-09-10T01:02:03.000Z");
  assert.equal(read.nested.at, "2026-01-01T00:00:00Z");
});

test("values survive a round trip, arrays and maps included", () => {
  const original = {
    name: "Maria",
    workingDays: [1, 2, 3],
    rate: 1.5,
    active: true,
    cleared: null,
    shifts: [{ startTime: "09:00", workingDays: [1, 5] }],
    memberships: { alpha: { status: "active", requiredWorkMinutes: 480 } },
  };
  assert.deepEqual(fromFirestoreFields(toFirestoreFields(original)), original);
});

/** A fake Firestore REST endpoint for one document. */
function fakeServer(initial: Record<string, unknown> | null, changeBeforeWrite = false) {
  let fields = initial ? toFirestoreFields(initial) : null;
  let updateTime = "2026-09-10T00:00:00.000000Z";
  const writes: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (!init || init.method !== "PATCH") {
      if (!fields) return new Response("", { status: 404 });
      return Response.json({ fields, updateTime });
    }
    writes.push(url);
    if (changeBeforeWrite) {
      updateTime = "2026-09-10T00:00:01.000000Z";
    }
    const wanted = new URL(url).searchParams.get("currentDocument.updateTime");
    if (wanted && wanted !== updateTime) {
      return new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), {
        status: 400,
      });
    }
    fields = { ...fields, ...(JSON.parse(String(init.body)).fields as object) };
    return Response.json({ fields, updateTime });
  }) as typeof fetch;
  return { fetchImpl, writes, read: () => (fields ? fromFirestoreFields(fields) : null) };
}

const pendingOnly = (current: Record<string, unknown>) =>
  current.status === "pending" ? null : `already ${current.status}`;

test("a pending request is decided", async () => {
  const server = fakeServer({ status: "pending", employeeId: "e1" });
  const result = await patchIfUnchanged({
    baseUrl: "https://firestore.test/docs",
    apiKey: "k",
    path: "leaveRequests/abc",
    update: { status: "approved" },
    check: pendingOnly,
    fetchImpl: server.fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(server.read()?.status, "approved");
  assert.match(server.writes[0], /currentDocument\.updateTime=/);
});

test("an already decided request is left as it was", async () => {
  const server = fakeServer({ status: "rejected", decidedBy: "ana@example.com" });
  const result = await patchIfUnchanged({
    baseUrl: "https://firestore.test/docs",
    apiKey: "k",
    path: "leaveRequests/abc",
    update: { status: "approved" },
    check: pendingOnly,
    fetchImpl: server.fetchImpl,
  });
  assert.deepEqual(result, { ok: false, status: 409, message: "already rejected" });
  assert.equal(server.writes.length, 0);
});

test("a mistyped id never creates a document", async () => {
  const server = fakeServer(null);
  const result = await patchIfUnchanged({
    baseUrl: "https://firestore.test/docs",
    apiKey: "k",
    path: "leaveRequests/typo",
    update: { status: "approved" },
    fetchImpl: server.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(server.writes.length, 0);
  assert.equal(server.read(), null);
});

test("a change landing between the read and the write is reported, not overwritten", async () => {
  const server = fakeServer({ status: "pending" }, true);
  const result = await patchIfUnchanged({
    baseUrl: "https://firestore.test/docs",
    apiKey: "k",
    path: "overtimeRequests/abc",
    update: { status: "approved" },
    check: pendingOnly,
    fetchImpl: server.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, 409);
  assert.equal(server.read()?.status, "pending");
});

test("a missing value is refused rather than deleting the field", async () => {
  const server = fakeServer({ status: "pending" });
  const result = await patchIfUnchanged({
    baseUrl: "https://firestore.test/docs",
    apiKey: "k",
    path: "leaveRequests/abc",
    update: { status: undefined },
    fetchImpl: server.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(server.read()?.status, "pending");
});
