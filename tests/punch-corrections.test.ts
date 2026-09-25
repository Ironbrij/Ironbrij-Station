import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as attendance from "../src/lib/attendance.ts";
import * as calculation from "../src/lib/attendance-calculation.ts";
import * as manualClockIn from "../src/lib/manual-clock-in.ts";
import * as overtimeReconcile from "../src/lib/overtime-reconcile.ts";
import * as punchSession from "../src/lib/punch-session.ts";
import type { Employee, Punch } from "../src/lib/types.ts";

// Run the real correction writer against an in-memory Firestore. Nothing here
// touches a real project.
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/punch-corrections.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

const DELETE = Symbol("deleteField");
type Data = Record<string, unknown>;

type Clause = { field: string; op: string; value: unknown };

function matches(data: Data, clause: Clause): boolean {
  const value = data[clause.field];
  const time = (item: unknown) => (item instanceof Date ? item.getTime() : item);
  if (clause.op === "in") return (clause.value as unknown[]).includes(value);
  if (clause.op === "==") return value === clause.value;
  if (clause.op === ">=") return (time(value) as number) >= (time(clause.value) as number);
  if (clause.op === "<=") return (time(value) as number) <= (time(clause.value) as number);
  throw new Error(`Unsupported operator ${clause.op}`);
}

function harness(
  initial: Record<string, Data>,
  options: {
    beforeCommit?: (docs: Map<string, Data>) => void;
    /** Behave as a project without the composite index deployed. */
    withoutIndex?: boolean;
  } = {},
) {
  const docs = new Map<string, Data>(
    Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]),
  );
  let autoId = 0;
  const reads: { collection: string; clauses: Clause[] }[] = [];
  const firestore = {
    collection: (_db: unknown, name: string) => ({ collection: name }),
    doc: (first: unknown, name?: string, id?: string) => {
      if (name && id) return { path: `${name}/${id}`, id };
      const collection = (first as { collection: string }).collection;
      const newId = `new-${++autoId}`;
      return { path: `${collection}/${newId}`, id: newId };
    },
    where: (field: string, op: string, value: unknown) => ({ field, op, value }),
    query: (collection: { collection: string }, ...clauses: Clause[]) => ({
      collection: collection.collection,
      clauses,
    }),
    getDocsFromServer: async (q: { collection: string; clauses: Clause[] }) => {
      reads.push(q);
      const ranged = q.clauses.some((clause) => clause.op === ">=" || clause.op === "<=");
      const equality = q.clauses.some((clause) => clause.op === "in" || clause.op === "==");
      if (options.withoutIndex && ranged && equality) {
        throw Object.assign(new Error("The query requires an index."), {
          code: "failed-precondition",
        });
      }
      return {
        docs: [...docs.entries()]
          .filter(
            ([path, data]) =>
              path.startsWith(`${q.collection}/`) && q.clauses.every((c) => matches(data, c)),
          )
          .map(([path, data]) => ({ id: path.split("/")[1], data: () => structuredClone(data) })),
      };
    },
    runTransaction: async (_db: unknown, body: (tx: unknown) => Promise<unknown>) => {
      const writes: (() => void)[] = [];
      const tx = {
        get: async (ref: { path: string }) => {
          const data = docs.get(ref.path);
          return {
            exists: () => Boolean(data),
            data: () => (data ? structuredClone(data) : undefined),
          };
        },
        set: (ref: { path: string }, data: Data, opts?: { merge?: boolean }) =>
          writes.push(() => {
            const next: Data = opts?.merge ? { ...(docs.get(ref.path) ?? {}) } : {};
            for (const [key, value] of Object.entries(data)) {
              if (value === DELETE) delete next[key];
              else next[key] = value;
            }
            docs.set(ref.path, next);
          }),
        update: (ref: { path: string }, data: Data) =>
          writes.push(() => docs.set(ref.path, { ...(docs.get(ref.path) ?? {}), ...data })),
        delete: (ref: { path: string }) => writes.push(() => docs.delete(ref.path)),
      };
      options.beforeCommit?.(docs);
      const result = await body(tx);
      for (const write of writes) write();
      return result;
    },
    Timestamp: { fromDate: (date: Date) => date },
    deleteField: () => DELETE,
  };
  const dependencies: Record<string, unknown> = {
    "firebase/firestore": firestore,
    "./firebase": { db: () => ({}) },
    "./attendance-clock": { attendanceNow: () => new Date("2026-09-10T12:00:00Z") },
    "./attendance": attendance,
    "./attendance-calculation": calculation,
    "./manual-clock-in": manualClockIn,
    "./overtime-reconcile": overtimeReconcile,
    "./punch-session": punchSession,
    "./live-data": {
      employeeRecordIds: (e: { id: string; authUid?: string } | null) =>
        e ? [...new Set([e.id, e.authUid].filter(Boolean))] : [],
    },
  };
  const exports: { applyPunchCorrection?: (input: unknown) => Promise<Record<string, unknown>> } =
    {};
  new Function("require", "exports", compiled)((name: string) => {
    assert.ok(name in dependencies, "Unexpected dependency: " + name);
    return dependencies[name];
  }, exports);
  return { docs, reads, apply: exports.applyPunchCorrection! };
}

const employee = {
  id: "emp",
  name: "Maria Santos",
  companyId: "alpha",
  companyIds: ["alpha"],
  status: "active",
  inviteStatus: "accepted",
  shiftTimezone: "UTC",
  timezone: "UTC",
  shiftStartTime: "09:00",
  shiftEndTime: "17:00",
  workingDays: [0, 1, 2, 3, 4, 5, 6],
} as Employee;
const DAY = "2026-08-01";
const at = (time: string) => new Date(`${DAY}T${time}:00Z`);

/** A late clock-in and a clock-out three hours past the shift, weeks ago. */
function olderDay(overtimeStatus = "pending") {
  return {
    "punches/in-old": {
      employeeId: "emp",
      companyId: "alpha",
      type: "in",
      timestamp: at("09:30"),
      attendanceDate: DAY,
      closedByPunchId: "out-old",
    },
    "punches/out-old": {
      employeeId: "emp",
      companyId: "alpha",
      type: "out",
      timestamp: at("20:00"),
      attendanceDate: DAY,
      punchInId: "in-old",
    },
    "overtimeRequests/ot-a": {
      employeeId: "emp",
      punchOutId: "out-old",
      punchInId: "in-old",
      date: DAY,
      overtimeMinutes: 180,
      status: overtimeStatus,
      requestType: "overtime",
    },
  };
}

const correction = (extra: Record<string, unknown> = {}) => ({
  employee,
  profile: employee,
  companyId: "alpha",
  // The screen's own window did not reach this day.
  punches: [] as Punch[],
  punchIn: at("09:00"),
  punchOut: at("17:00"),
  actor: "admin@example.com",
  ...extra,
});

test("fixing an older day corrects that day's punches instead of adding a second set", async () => {
  const { docs, apply } = harness(olderDay());
  await apply(correction());
  const punches = [...docs.keys()].filter((path) => path.startsWith("punches/"));
  assert.deepEqual(punches.sort(), ["punches/in-old", "punches/out-old"], "no duplicate clock-in");
  assert.equal(
    (docs.get("punches/in-old")!.timestamp as Date).toISOString(),
    at("09:00").toISOString(),
  );
  assert.equal(
    (docs.get("punches/out-old")!.timestamp as Date).toISOString(),
    at("17:00").toISOString(),
  );
  assert.equal(docs.get("punches/in-old")!.closedByPunchId, "out-old");
});

test("overtime the correction removes is withdrawn from the approval queue", async () => {
  const { docs, apply } = harness(olderDay());
  await apply(correction());
  assert.equal(docs.has("overtimeRequests/ot-a"), false);
});

test("an approved overtime request stays as it was decided", async () => {
  const { docs, apply } = harness(olderDay("approved"));
  await apply(correction());
  assert.equal(docs.get("overtimeRequests/ot-a")?.status, "approved");
  assert.equal(docs.get("overtimeRequests/ot-a")?.overtimeMinutes, 180);
});

test("a punch changed while the fix was being made stops the fix, writing nothing", async () => {
  const { docs, apply } = harness(olderDay(), {
    beforeCommit: (current) => {
      current.set("punches/out-old", {
        ...current.get("punches/out-old"),
        voidedAt: "someone else",
      });
    },
  });
  await assert.rejects(apply(correction()), punchSession.isAttendanceConflict);
  assert.equal(
    (docs.get("punches/in-old")!.timestamp as Date).toISOString(),
    at("09:30").toISOString(),
  );
  assert.equal(docs.has("overtimeRequests/ot-a"), true);
});

test("reopening a shift clears its closed mark so the employee can end it", async () => {
  const now = new Date("2026-09-10T12:00:00Z");
  const today = "2026-09-10";
  const autoId = punchSession.sessionCloseId("in-today");
  const { docs, apply } = harness({
    "punches/in-today": {
      employeeId: "emp",
      companyId: "alpha",
      type: "in",
      timestamp: new Date(`${today}T09:10:00Z`),
      attendanceDate: today,
      closedByPunchId: autoId,
    },
    [`punches/${autoId}`]: {
      employeeId: "emp",
      companyId: "alpha",
      type: "out",
      timestamp: new Date(`${today}T11:00:00Z`),
      attendanceDate: today,
      punchInId: "in-today",
      isAuto: true,
      autoReason: "forgot_punch_out",
    },
  });
  await apply(
    correction({
      punchIn: new Date(`${today}T09:00:00Z`),
      punchOut: null,
      reopen: true,
      now,
    }),
  );
  assert.equal(docs.get(`punches/${autoId}`)?.voidedAt, now.toISOString());
  assert.equal(docs.get("punches/in-today")?.closedByPunchId, null);
});

test("a fix reads only the days around the shift, not the whole history", async () => {
  const { reads, apply } = harness(olderDay());
  await apply(correction());
  const punchRead = reads.find((read) => read.collection === "punches")!;
  assert.ok(punchRead.clauses.some((clause) => clause.field === "timestamp" && clause.op === ">="));
  const overtimeReads = reads.filter((read) => read.collection === "overtimeRequests");
  assert.ok(overtimeReads.length > 0);
  for (const read of overtimeReads) {
    assert.ok(
      read.clauses.every((clause) => clause.field === "punchInId" || clause.field === "punchOutId"),
      "only the shift's own overtime",
    );
  }
});

test("without the index deployed, a fix still finds the shift's punches", async () => {
  const { docs, apply } = harness(olderDay(), { withoutIndex: true });
  await apply(correction());
  assert.deepEqual([...docs.keys()].filter((path) => path.startsWith("punches/")).sort(), [
    "punches/in-old",
    "punches/out-old",
  ]);
  assert.equal(docs.has("overtimeRequests/ot-a"), false);
});
