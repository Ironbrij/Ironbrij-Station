import test from "node:test";
import assert from "node:assert/strict";
import { planManualClockIn, resolveManualClockOut } from "../src/lib/manual-clock-in.ts";
import { buildAttendanceLog } from "../src/lib/dashboard-attendance.ts";
import type { Company, Employee, LeaveRequest, Punch } from "../src/lib/types.ts";

const employee = {
  id: "profile",
  authUid: "login",
  name: "Naomi Galliano",
  companyId: "alpha",
  companyIds: ["alpha"],
  status: "active",
  inviteStatus: "accepted",
  shiftTimezone: "UTC",
  shiftStartTime: "12:00",
  shiftEndTime: "16:00",
  workingDays: [0, 1, 2, 3, 4, 5, 6],
} as Employee;
const companies = [
  {
    id: "alpha",
    name: "Northwind",
    lateGraceMinutes: 5,
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    defaultShiftHours: 4,
    holidays: [],
  },
] as Company[];

const DATE = "2026-09-21";
const at = (time: string, date = DATE) => new Date(`${date}T${time}:00Z`);
const punch = (
  id: string,
  type: Punch["type"],
  time: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    employeeId: "login",
    companyId: "alpha",
    type,
    timestamp: at(time),
    date: DATE,
    attendanceDate: DATE,
    shiftTimezone: "UTC",
    scheduledShiftStart: at("12:00").toISOString(),
    scheduledShiftEnd: at("16:00").toISOString(),
    ...extra,
  }) as unknown as Punch;

test("a clock-out earlier on the clock than the clock-in ends on the next day", () => {
  const punchIn = at("22:00");
  assert.equal(
    resolveManualClockOut(DATE, "06:00", "UTC", punchIn).toISOString(),
    at("06:00", "2026-09-22").toISOString(),
  );
  assert.equal(
    resolveManualClockOut(DATE, "23:30", "UTC", punchIn).toISOString(),
    at("23:30").toISOString(),
  );
});

test("an entered clock-out is rejected when it cannot bound a session", () => {
  assert.throws(
    () => planManualClockIn(employee, [], at("12:00"), at("18:00"), false, at("11:00")),
    /after the clock-in/,
  );
  assert.throws(
    () => planManualClockIn(employee, [], at("12:00"), at("18:00"), false, at("23:00")),
    /future/,
  );
});

test("an entered clock-out corrects the session's own out punch instead of reopening", () => {
  const punches = [punch("in", "in", "12:20"), punch("out", "out", "15:00")];
  // Without a clock-out this would refuse to reopen a manually closed shift.
  assert.throws(
    () => planManualClockIn(employee, punches, at("12:00"), at("18:00"), true),
    /manual or policy clock-out/,
  );
  const plan = planManualClockIn(employee, punches, at("12:00"), at("18:00"), true, at("16:00"));
  assert.equal(plan.existing?.id, "in");
  assert.equal(plan.existingOut?.id, "out");
  assert.deepEqual(plan.voided, []);
});

test("an automatic clock-out is corrected rather than voided when a time is entered", () => {
  const punches = [
    punch("in", "in", "12:20"),
    punch("auto", "out", "16:00", { isAuto: true, autoReason: "shift_timeout" }),
  ];
  const plan = planManualClockIn(employee, punches, at("12:00"), at("18:00"), true, at("16:30"));
  assert.equal(plan.existingOut?.id, "auto");
  assert.deepEqual(plan.voided, []);
});

test("correcting both punches updates the dashboard's times, hours, and lateness", () => {
  const corrected = [
    punch("in", "in", "12:00", { addedByAdmin: "admin" }),
    punch("out", "out", "16:00", { addedByAdmin: "admin", isAuto: false }),
  ];
  const [row] = buildAttendanceLog({
    employees: [employee],
    punches: corrected,
    companies,
    leaves: [] as LeaveRequest[],
    now: at("18:00"),
    date: DATE,
  });
  assert.equal(row.status, "completed");
  assert.equal(row.timeIn?.toISOString(), at("12:00").toISOString());
  assert.equal(row.timeOut?.toISOString(), at("16:00").toISOString());
  assert.equal(row.hours, 4);
  assert.equal(row.lateMinutes, 0);
  assert.equal(row.automatic, false);
});
