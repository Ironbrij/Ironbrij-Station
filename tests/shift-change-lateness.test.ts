import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEmployeeLateness,
  getLiveAttendanceStatus,
  scopeEmployeeToPunchSchedule,
} from "../src/lib/attendance.ts";
import type { Employee, Punch } from "../src/lib/types.ts";

// Someone clocked in at 09:00 on their 09:00 shift. Their shift was then moved
// to 07:00. That clock-in was on time and must stay on time everywhere.

const DATE = "2026-09-10";
const at = (time: string) => new Date(`${DATE}T${time}:00Z`);

const movedTo7 = {
  id: "emp",
  name: "Maria",
  email: "maria@example.com",
  status: "active",
  inviteStatus: "accepted",
  timezone: "UTC",
  shiftTimezone: "UTC",
  shiftStartTime: "07:00",
  shiftEndTime: "15:00",
  workingDays: [0, 1, 2, 3, 4, 5, 6],
} as Employee;

const clockIn = {
  id: "in",
  employeeId: "emp",
  type: "in",
  timestamp: at("09:00"),
  attendanceDate: DATE,
  shiftTimezone: "UTC",
  scheduledShiftStart: at("09:00").toISOString(),
  scheduledShiftEnd: at("17:00").toISOString(),
} as unknown as Punch;

test("the clock-in is judged on the shift it was made on", () => {
  const late = computeEmployeeLateness(at("09:00"), scopeEmployeeToPunchSchedule(movedTo7, clockIn), 5);
  assert.equal(late.isLate, false);
});

test("today's live status stays on time after the shift is moved", () => {
  const status = getLiveAttendanceStatus(movedTo7, [clockIn], at("10:00"), 5);
  assert.equal(status.isLate, false);
  assert.equal(status.minutesLate, 0);
});

test("a clock-in with no saved shift still uses the profile", () => {
  const unsaved = { ...clockIn, scheduledShiftStart: undefined, scheduledShiftEnd: undefined } as Punch;
  const late = computeEmployeeLateness(at("09:00"), scopeEmployeeToPunchSchedule(movedTo7, unsaved), 5);
  assert.equal(late.isLate, true);
});
