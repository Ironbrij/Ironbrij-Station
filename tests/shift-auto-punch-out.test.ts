import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as attendance from "../src/lib/attendance.ts";
import * as companyContext from "../src/lib/company-context.ts";
import * as time from "../src/lib/time.ts";
import type { Employee, Punch } from "../src/lib/types.ts";

// Execute the real reconciler with an in-memory Firestore transaction and a
// fixed clock. No production Firebase services are initialized or written.
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/use-shift-auto-punch-out.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness(now: Date) {
  const records = new Map<string, Record<string, unknown>>();
  const sourceRecords = new Map<string, Record<string, unknown>>();
  const firestore = {
    doc: (_db: unknown, collection: string, id: string) => collection + "/" + id,
    Timestamp: { fromDate: (date: Date) => date },
    runTransaction: async (_db: unknown, callback: (transaction: unknown) => unknown) =>
      callback({
        get: async (ref: string) => ({ exists: () => records.has(ref) || sourceRecords.has(ref), data: () => records.get(ref) || sourceRecords.get(ref) }),
        set: (ref: string, value: Record<string, unknown>) => records.set(ref, value),
      }),
    setDoc: async (ref: string, value: Record<string, unknown>) => {
      records.set(ref, value);
    },
  };
  const dependencies: Record<string, unknown> = {
    react: {},
    "firebase/firestore": firestore,
    sonner: { toast: { info() {} } },
    "./firebase": { db: () => ({}) },
    "./attendance": attendance,
    "./company-context": companyContext,
    "./time": time,
    "./attendance-clock": { attendanceNow: () => new Date(now.getTime()) },
    "./app-runtime": {},
    "./email-branding": {},
  };
  const exports: { reconcileEmployeeShift?: (...args: unknown[]) => Promise<boolean> } = {};
  class Clock extends Date {
    constructor() {
      super(now.getTime());
    }
  }
  new Function("require", "exports", "Date", compiled)(
    (name: string) => {
      assert.ok(name in dependencies, "Unexpected dependency: " + name);
      return dependencies[name];
    },
    exports,
    Clock,
  );
  return { records, reconcile: async (...args: unknown[]) => {
    for (const punch of args[1] as Punch[]) sourceRecords.set(`punches/${punch.id}`, punch as unknown as Record<string, unknown>);
    return exports.reconcileEmployeeShift!(...args);
  } };
}

const emp = {
  id: "employee",
  name: "Employee",
  companyId: "alpha",
  companyIds: ["alpha"],
  shiftStartTime: "06:00",
  shiftEndTime: "14:00",
  shiftTimezone: "Australia/Sydney",
} as Employee;
const at = (value: string) =>
  attendance.zonedDateTimeToDate("2026-08-10", value, "Australia/Sydney");
function punch(type: Punch["type"], value: string): Punch {
  return {
    id: type + value,
    employeeId: emp.id,
    companyId: "alpha",
    type,
    timestamp: { seconds: at(value).getTime() / 1000, nanoseconds: 0 } as Punch["timestamp"],
  };
}

for (const [breakEnd, deadline] of [
  [null, "14:00"],
  ["10:30", "14:30"],
  ["11:20", "15:20"],
] as const) {
  test(
    "reconciler persists the break-adjusted deadline " + deadline + " exactly once",
    async () => {
      const punches = [punch("in", "06:00")];
      if (breakEnd) punches.push(punch("lunch_start", "10:00"), punch("lunch_end", breakEnd));
      const early = harness(new Date(at(deadline).getTime() - 1));
      assert.equal(await early.reconcile(emp, punches, null, "alpha", false), false);
      assert.equal(early.records.size, 0);
      const due = harness(at("16:00"));
      assert.equal(await due.reconcile(emp, [...punches].reverse(), null, "alpha", false), true);
      const out = due.records.get("punches/shift-timeout-in06%3A00");
      assert.ok(out);
      assert.equal((out.timestamp as Date).getTime(), at(deadline).getTime());
      assert.equal(out.scheduledShiftStart, at("06:00").toISOString());
      assert.equal(out.scheduledShiftEnd, at("14:00").toISOString());
      assert.ok(
        [...due.records.keys()].every(
          (key) => key.startsWith("punches/") || key.startsWith("notices/"),
        ),
      );
      assert.equal(emp.shiftStartTime, "06:00");
      assert.equal(emp.shiftEndTime, "14:00");
      assert.equal(out.type, "out");
      assert.equal(out.isAuto, true);
      assert.equal(await due.reconcile(emp, punches, null, "alpha", false), false);
    },
  );
}

test("reconciler does not write an auto out during an unfinished break", async () => {
  const run = harness(at("16:00"));
  assert.equal(
    await run.reconcile(
      emp,
      [punch("in", "06:00"), punch("lunch_start", "13:00")],
      null,
      "alpha",
      false,
    ),
    false,
  );
  assert.equal(run.records.size, 0);
});

test("reconciler anchors lunch return to the original shift when the next slot has begun", async () => {
  const multi = {
    ...emp,
    isMultipleShift: true,
    shifts: [
      { startTime: "06:00", endTime: "10:00", workingDays: [1] },
      { startTime: "10:30", endTime: "14:30", workingDays: [1] },
    ],
  };
  const punches = [
    punch("in", "06:00"),
    punch("lunch_start", "09:30"),
    punch("lunch_end", "10:45"),
  ];
  const run = harness(at("11:15"));
  assert.equal(await run.reconcile(multi, punches, null, "alpha", false), true);
  const out = run.records.get("punches/shift-timeout-in06%3A00");
  assert.equal((out?.timestamp as Date).getTime(), at("11:15").getTime());
  assert.equal(out?.scheduledShiftStart, at("06:00").toISOString());
  assert.equal(out?.scheduledShiftEnd, at("10:00").toISOString());
});


test("starting after scheduled end never creates a backdated automatic clock-out", async () => {
  const run = harness(at("15:01"));
  assert.equal(await run.reconcile(emp, [punch("in", "15:00")], null, "alpha", false), false);
  assert.equal(run.records.size, 0);
});

test("only a new start in another company closes a session, using the earliest start", async () => {
  const multi = { ...emp, companyIds: ["alpha", "beta"] };
  const run = harness(at("09:00"));
  const oldStart = punch("in", "06:00");
  const delayedOut = { ...punch("out", "08:05"), companyId: "beta" };
  const delayedBreak = { ...punch("lunch_end", "08:10"), companyId: "beta" };
  assert.equal(await run.reconcile(multi, [oldStart, delayedOut, delayedBreak], null, "alpha", false), false);
  const firstStart = { ...punch("in", "08:00"), companyId: "beta" };
  const laterStart = { ...punch("in", "08:30"), companyId: "beta" };
  await run.reconcile(multi, [laterStart, delayedOut, oldStart, firstStart], null, "alpha", false);
  const out = run.records.get("punches/shift-timeout-in06%3A00");
  assert.equal((out?.timestamp as Date).getTime(), at("08:00").getTime());
  assert.equal(out?.autoReason, "switch_company");
});

test("an old company's delayed closing punch does not auto-close the new company", async () => {
  const multi = { ...emp, companyIds: ["alpha", "beta"] };
  const run = harness(at("09:00"));
  await run.reconcile(multi, [
    punch("in", "06:00"),
    { ...punch("in", "08:00"), companyId: "beta" },
    punch("out", "08:01"),
  ], null, "beta", false);
  assert.equal(run.records.size, 0);
});
