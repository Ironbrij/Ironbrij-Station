import test from "node:test";
import assert from "node:assert/strict";
import { computeLeaveCreditBalance, leaveDayHours } from "../src/lib/leave-credits.ts";
import {
  formatAmount,
  formatCovered,
  formatDaysAndHours,
  formatShortDate,
  parseLeaveDays,
} from "../src/lib/report-format.ts";
import type { LeaveRequest } from "../src/lib/types.ts";

const employee = { id: "emp-1", authUid: "uid-1", annualLeaveCredits: 10 };
const isWeekday = (date: string) => {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
};

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
    { isWorkingDay: isWeekday },
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

test("a half day costs half a credit and a timed break costs its hours", () => {
  const balance = computeLeaveCreditBalance(
    employee,
    [
      leave({
        dates: [
          { date: "2026-09-14", leaveType: "half_day" },
          { date: "2026-09-15", leaveType: "timed_break", startTime: "10:00", endTime: "12:00" },
          { date: "2026-09-16", paymentStatus: "unpaid" },
          { date: "2026-09-17" },
        ],
      }),
    ],
    "2026-09-25",
    { hoursPerDay: 8 },
  );
  // 0.5 + 2/8 + 1
  assert.equal(balance?.used, 1.75);
  assert.equal(balance?.remaining, 8.25);
});

test("a leave day's hours follow the working day's length", () => {
  assert.equal(leaveDayHours({}, 9), 9);
  assert.equal(leaveDayHours({ leaveType: "half_day" }, 9), 4.5);
  assert.equal(leaveDayHours({ leaveType: "timed_break" }, 9), 0);
  assert.equal(
    leaveDayHours({ leaveType: "timed_break", startTime: "22:00", endTime: "01:00" }, 9),
    3,
  );
});

test("a range spanning a weekend or holiday only charges the working days", () => {
  // Fri 18 Sep to Mon 21 Sep 2026, with Monday a holiday.
  const balance = computeLeaveCreditBalance(
    employee,
    [leave({ dateFrom: "2026-09-18", dateTo: "2026-09-21" })],
    "2026-09-25",
    { isWorkingDay: (date) => isWeekday(date) && date !== "2026-09-21" },
  );
  assert.equal(balance?.used, 1);
});

test("only leave from 1 January up to the period's end is counted", () => {
  const leaves = [
    leave({ dateFrom: "2025-12-30", dateTo: "2026-01-02" }),
    leave({ dateFrom: "2026-10-05", dateTo: "2026-10-06" }),
  ];
  const options = { isWorkingDay: isWeekday };
  // 1 and 2 January 2026 fall on Thursday and Friday.
  assert.equal(computeLeaveCreditBalance(employee, leaves, "2026-09-25", options)?.used, 2);
  assert.equal(computeLeaveCreditBalance(employee, leaves, "2026-10-09", options)?.used, 4);
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

test("leave reads as days and hours, the way the client sheet writes it", () => {
  assert.equal(formatDaysAndHours(1, 8), "1 Day (8 hours)");
  // 84.39 hours is 10.54875 days, which the sheet rounds to 10.55.
  assert.equal(formatDaysAndHours(84.39 / 8, 8), "10.55 Days (84.39 hours)");
  assert.equal(formatDaysAndHours(0.125, 8), "0.13 Days (1 hour)");
  assert.equal(formatDaysAndHours(0, 8), "0");
  assert.equal(formatDaysAndHours(0, 8, "0 Days (0 hours)"), "0 Days (0 hours)");
  assert.equal(formatDaysAndHours(-1, 8), "-1 Day (-8 hours)");
});

test("a typed leave figure gives the days the totals add up", () => {
  assert.equal(parseLeaveDays("2.5 Days (20 hours)", 8), 2.5);
  assert.equal(parseLeaveDays("1 Day (8 hours)", 8), 1);
  assert.equal(parseLeaveDays("0", 8), 0);
  assert.equal(parseLeaveDays("20 hours", 8), 2.5);
  assert.equal(parseLeaveDays("4hrs", 8), 0.5);
  assert.equal(parseLeaveDays("", 8), 0);
  assert.equal(parseLeaveDays("see notes", 8), 0);
});

test("hours read without trailing zeros", () => {
  assert.equal(formatAmount(40), "40");
  assert.equal(formatAmount(17.5), "17.5");
  assert.equal(formatAmount(1.004), "1");
});

test("the covered period reads like the sheet's", () => {
  assert.equal(formatCovered("2026-09-14", "2026-09-20"), "Sep 14 - 20, 2026");
  assert.equal(formatCovered("2026-08-31", "2026-09-04"), "Aug 31 - Sep 4, 2026");
  assert.equal(formatCovered("2025-12-29", "2026-01-02"), "Dec 29, 2025 - Jan 2, 2026");
  assert.equal(formatCovered("2026-09-14", "2026-09-14"), "Sep 14, 2026");
});

test("remark dates use the sheet's day-month-year style", () => {
  assert.equal(formatShortDate("2026-09-14"), "14-Sep-26");
  assert.equal(formatShortDate("2026-01-05"), "05-Jan-26");
});
