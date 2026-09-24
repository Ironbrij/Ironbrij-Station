import test from "node:test";
import assert from "node:assert/strict";
import { computeLeaveCreditBalance, formatLeaveDays } from "../src/lib/leave-credits.ts";
import type { LeaveRequest } from "../src/lib/types.ts";

const employee = { id: "emp-1", authUid: "uid-1", annualLeaveCredits: 10 };
const weekdays = [1, 2, 3, 4, 5];

function leave(overrides: Partial<LeaveRequest>): LeaveRequest {
  return {
    id: Math.random().toString(36).slice(2),
    employeeId: "emp-1",
    dateFrom: "2026-09-14",
    dateTo: "2026-09-14",
    reason: "",
    status: "approved",
    createdAt: undefined as never,
    ...overrides,
  };
}

test("no credits set reads as not tracked, not as zero left", () => {
  assert.equal(computeLeaveCreditBalance({ id: "emp-1" }, [], "2026-09-25"), null);
  assert.equal(
    computeLeaveCreditBalance({ id: "emp-1", annualLeaveCredits: null }, [], "2026-09-25"),
    null,
  );
});

test("approved paid leave this year draws on the credits", () => {
  const balance = computeLeaveCreditBalance(
    employee,
    [leave({ dateFrom: "2026-03-02", dateTo: "2026-03-04" })],
    "2026-09-25",
    weekdays,
  );
  assert.deepEqual(balance, { credits: 10, used: 3, remaining: 7 });
});

test("unpaid, pending and rejected leave leave the credits alone", () => {
  const balance = computeLeaveCreditBalance(
    employee,
    [
      leave({ paymentStatus: "unpaid" }),
      leave({ status: "pending", dateFrom: "2026-09-15", dateTo: "2026-09-15" }),
      leave({ status: "rejected", dateFrom: "2026-09-16", dateTo: "2026-09-16" }),
    ],
    "2026-09-25",
  );
  assert.equal(balance?.remaining, 10);
});

test("a half day costs half a credit and a timed break costs none", () => {
  const balance = computeLeaveCreditBalance(
    employee,
    [
      leave({
        dates: [
          { date: "2026-09-14", leaveType: "half_day" },
          { date: "2026-09-15", leaveType: "timed_break" },
          { date: "2026-09-16", paymentStatus: "unpaid" },
          { date: "2026-09-17" },
        ],
      }),
    ],
    "2026-09-25",
  );
  assert.equal(balance?.used, 1.5);
  assert.equal(balance?.remaining, 8.5);
});

test("a range spanning a weekend only charges the working days", () => {
  // Fri 18 Sep to Mon 21 Sep 2026.
  const balance = computeLeaveCreditBalance(
    employee,
    [leave({ dateFrom: "2026-09-18", dateTo: "2026-09-21" })],
    "2026-09-25",
    weekdays,
  );
  assert.equal(balance?.used, 2);
});

test("only leave from 1 January up to the period's end is counted", () => {
  const leaves = [
    leave({ dateFrom: "2025-12-30", dateTo: "2026-01-02" }),
    leave({ dateFrom: "2026-10-05", dateTo: "2026-10-06" }),
  ];
  // 1 and 2 January 2026 fall on Thursday and Friday.
  assert.equal(computeLeaveCreditBalance(employee, leaves, "2026-09-25", weekdays)?.used, 2);
  assert.equal(computeLeaveCreditBalance(employee, leaves, "2026-10-09", weekdays)?.used, 4);
});

test("leave filed under the sign-in id counts, and overlapping requests charge a day once", () => {
  const balance = computeLeaveCreditBalance(
    employee,
    [
      leave({ employeeId: "uid-1" }),
      leave({ dates: [{ date: "2026-09-14" }] }),
      leave({ employeeId: "someone-else", dateFrom: "2026-09-15", dateTo: "2026-09-15" }),
    ],
    "2026-09-25",
  );
  assert.equal(balance?.used, 1);
});

test("taking more than the credits shows a negative balance", () => {
  const balance = computeLeaveCreditBalance(
    { id: "emp-1", annualLeaveCredits: 1 },
    [leave({ dateFrom: "2026-09-14", dateTo: "2026-09-15" })],
    "2026-09-25",
  );
  assert.equal(balance?.remaining, -1);
});

test("leave days read without a trailing .0", () => {
  assert.equal(formatLeaveDays(10), "10d");
  assert.equal(formatLeaveDays(7.5), "7.5d");
  assert.equal(formatLeaveDays(-1), "-1d");
});
