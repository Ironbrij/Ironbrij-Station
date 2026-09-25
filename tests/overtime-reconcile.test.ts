import test from "node:test";
import assert from "node:assert/strict";
import { planOvertimeReconciliation } from "../src/lib/overtime-reconcile.ts";
import type { OvertimeRequest } from "../src/lib/types.ts";

const request = (id: string, extra: Partial<OvertimeRequest>) =>
  ({
    id,
    employeeId: "emp",
    employeeName: "Maria",
    companyId: "alpha",
    date: "2026-09-10",
    overtimeMinutes: 120,
    isOffShiftDay: false,
    reason: "",
    status: "pending",
    createdAt: "2026-09-10T10:00:00Z",
    ...extra,
  }) as OvertimeRequest;

const base = {
  punchInId: "in-1",
  punchOutId: "out-1",
  normalWorkMinutes: 480,
  earlyMinutes: 0,
  dateKey: "2026-09-10",
  employeeId: "emp",
  employeeName: "Maria",
  companyId: "alpha",
  isOffShiftDay: false,
  stamp: "2026-09-11T00:00:00Z",
  describe: (minutes: number) => `${minutes}m`,
};

test("correcting a clock-out back to the shift end withdraws the overtime waiting on it", () => {
  const plan = planOvertimeReconciliation({
    ...base,
    requests: [request("ot-a", { punchOutId: "out-1" })],
    overtimeMinutes: 0,
  });
  assert.deepEqual(plan.deletes, ["ot-a"]);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.creates, []);
});

test("a corrected clock-out moves the pending overtime to the new minutes", () => {
  const plan = planOvertimeReconciliation({
    ...base,
    requests: [request("ot-a", { punchOutId: "out-1" })],
    overtimeMinutes: 45,
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "ot-a");
  assert.equal(plan.updates[0].data.overtimeMinutes, 45);
  assert.equal(plan.updates[0].data.date, "2026-09-10");
});

test("a decided request is a decision on record and is never touched", () => {
  const plan = planOvertimeReconciliation({
    ...base,
    requests: [
      request("approved", { punchOutId: "out-1", status: "approved" }),
      request("rejected", { punchOutId: "out-1", status: "rejected" }),
    ],
    overtimeMinutes: 0,
  });
  assert.deepEqual(plan, { creates: [], updates: [], deletes: [] });
});

test("overtime a correction reveals is filed once, named after its clock-out", () => {
  const plan = planOvertimeReconciliation({ ...base, requests: [], overtimeMinutes: 30 });
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.creates[0].id, "ot-out-1");
  assert.equal(plan.creates[0].data.status, "pending");
  assert.equal(plan.creates[0].data.punchInId, "in-1");
});

test("an early start waiting for approval follows a corrected clock-in", () => {
  const early = request("early", { requestType: "early_clock_in", punchInId: "in-1" });
  const later = planOvertimeReconciliation({
    ...base,
    punchOutId: undefined,
    overtimeMinutes: null,
    requests: [early],
    earlyMinutes: 0,
  });
  assert.deepEqual(later.deletes, ["early"], "no longer early: withdrawn");

  const earlier = planOvertimeReconciliation({
    ...base,
    punchOutId: undefined,
    overtimeMinutes: null,
    requests: [early],
    earlyMinutes: 25,
  });
  assert.equal(earlier.updates[0].data.overtimeMinutes, 25);
});

test("a correction never files an early start of its own", () => {
  const plan = planOvertimeReconciliation({
    ...base,
    punchOutId: undefined,
    overtimeMinutes: null,
    requests: [],
    earlyMinutes: 40,
  });
  assert.deepEqual(plan, { creates: [], updates: [], deletes: [] });
});

test("a clock-in-only correction leaves the session's overtime alone", () => {
  const plan = planOvertimeReconciliation({
    ...base,
    punchOutId: undefined,
    overtimeMinutes: null,
    requests: [request("ot-a", { punchOutId: "out-1" })],
  });
  assert.deepEqual(plan, { creates: [], updates: [], deletes: [] });
});
