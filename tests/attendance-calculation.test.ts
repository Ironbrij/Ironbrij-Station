import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAttendanceSession,
  isPunchOutReminderDue,
} from "../src/lib/attendance-calculation.ts";
import { zonedDateTimeToDate } from "../src/lib/attendance.ts";
import type { Company, Employee } from "../src/lib/types.ts";

const timezone = "Australia/Sydney";
const company: Company = {
  id: "alpha",
  name: "Alpha",
  defaultShiftHours: 8,
  holidays: [],
  workingDays: [1, 2, 3, 4, 5],
  punchOutGraceMinutes: 20,
  punchOutReminderMinutes: 20,
};

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "employee-1",
    name: "Employee One",
    email: "employee@example.com",
    status: "active",
    inviteStatus: "accepted",
    companyId: "alpha",
    companyIds: ["alpha"],
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
    shiftTimezone: timezone,
    requiredWorkMinutes: 480,
    ...overrides,
  };
}

function at(time: string): Date {
  return zonedDateTimeToDate("2026-08-10", time, timezone);
}

test("normal eight-hour session resolves to eight normal hours", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("17:00"),
  });
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.status, "complete");
});

test("custom six-hour requirement is respected", () => {
  const result = calculateAttendanceSession({
    employee: employee({
      requiredWorkMinutes: 360,
      shiftEndTime: "15:00",
    }),
    company,
    punchIn: at("09:00"),
    punchOut: at("15:00"),
  });
  assert.equal(result.requiredWorkMinutes, 360);
  assert.equal(result.normalWorkMinutes, 360);
});

test("custom seven-hour-thirty-minute requirement stays precise", () => {
  const result = calculateAttendanceSession({
    employee: employee({ requiredWorkMinutes: 450, shiftEndTime: "16:30" }),
    company,
    punchIn: at("09:00"),
    punchOut: at("16:30"),
  });
  assert.equal(result.requiredWorkMinutes, 450);
  assert.equal(result.normalWorkMinutes, 450);
});

test("punch-out inside grace normalizes to the shift end", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("17:15"),
  });
  assert.equal(result.actualWorkMinutes, 495);
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.graceApplied, true);
});

test("punch-out shortly before shift end also keeps normal scheduled hours", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("16:50"),
  });
  assert.equal(result.actualWorkMinutes, 470);
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.graceApplied, true);
});

test("only time beyond the grace boundary becomes overtime", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("17:21"),
  });
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 21);
  assert.equal(result.attendanceDate, "2026-08-10");
});

test("working on off-shift day or holiday counts all time as overtime", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("10:00"),
    punchOut: at("14:00"),
    isOffShiftDay: true,
  });
  assert.equal(result.normalWorkMinutes, 0);
  assert.equal(result.overtimeMinutes, 240);
  assert.equal(result.totalEligibleMinutes, 240);
  assert.equal(result.status, "complete");
});

test("an open session after shift end is missing punch-out without a fake end", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: null,
    now: at("18:00"),
  });
  assert.equal(result.status, "missing_punch_out");
  assert.equal(result.missingPunchOut, true);
  assert.equal(result.overtimeMinutes, 60);
});

test("reminder opens exactly twenty minutes before shift end", () => {
  assert.equal(
    isPunchOutReminderDue({ employee: employee(), punchIn: at("09:00"), now: at("16:39") }),
    false,
  );
  assert.equal(
    isPunchOutReminderDue({ employee: employee(), punchIn: at("09:00"), now: at("16:40") }),
    true,
  );
});
