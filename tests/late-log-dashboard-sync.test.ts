import test from "node:test";
import assert from "node:assert/strict";
import { buildAttendanceLog } from "../src/lib/dashboard-attendance.ts";
import { buildLateRecords } from "../src/lib/late-records.ts";
import { planManualClockIn } from "../src/lib/manual-clock-in.ts";
import type { Company, Employee, LeaveRequest, Punch } from "../src/lib/types.ts";

const employee = {
  id: "profile",
  authUid: "login",
  name: "Maria Santos",
  companyId: "alpha",
  companyIds: ["alpha"],
  status: "active",
  inviteStatus: "accepted",
  shiftTimezone: "UTC",
  shiftStartTime: "05:00",
  shiftEndTime: "13:00",
  workingDays: [0, 1, 2, 3, 4, 5, 6],
} as Employee;
const companies = [
  {
    id: "alpha",
    name: "Northwind",
    lateGraceMinutes: 5,
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    defaultShiftHours: 8,
    holidays: [],
  },
] as Company[];

const DATE = "2026-09-10";
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
    companyName: "Northwind",
    type,
    timestamp: at(time),
    date: DATE,
    attendanceDate: DATE,
    shiftTimezone: "UTC",
    scheduledShiftStart: at("05:00").toISOString(),
    scheduledShiftEnd: at("13:00").toISOString(),
    ...extra,
  }) as unknown as Punch;

const dashboard = (punches: Punch[], now = at("14:00")) =>
  buildAttendanceLog({
    employees: [employee],
    punches,
    companies,
    leaves: [] as LeaveRequest[],
    now,
    date: DATE,
  });
const lateLog = (punches: Punch[], now = at("14:00")) =>
  buildLateRecords([employee], punches, [], companies, now, { period: "all" });

test("excusing a late arrival clears the same shift on the dashboard", () => {
  const before = dashboard([punch("in", "in", "05:12"), punch("out", "out", "13:00")]);
  assert.equal(before[0].lateMinutes, 12);
  assert.equal(before[0].excused, false);

  const after = dashboard([
    punch("in", "in", "05:12", { isExcused: true, excuseReason: "Started at 05:00 on site" }),
    punch("out", "out", "13:00"),
  ]);
  assert.equal(after[0].excused, true);
  assert.equal(after[0].lateMinutes, 0);
  assert.equal(after[0].excuseReason, "Started at 05:00 on site");
  assert.equal(lateLog([punch("in", "in", "05:12", { isExcused: true })])[0].isExcused, true);
});

test("correcting the clock-in time drops the shift from both the late log and the dashboard", () => {
  const corrected = [
    punch("in", "in", "05:00", { employeeId: "profile", addedByAdmin: "admin" }),
    punch("out", "out", "13:00"),
  ];
  assert.deepEqual(lateLog(corrected), []);
  assert.equal(dashboard(corrected)[0].lateMinutes, 0);
  assert.equal(dashboard(corrected)[0].timeIn?.toISOString(), at("05:00").toISOString());
});

test("a second clock-in inside an excused shift is not reported late again", () => {
  const punches = [
    punch("in", "in", "05:12", { isExcused: true }),
    punch("auto-out", "out", "09:00", { isAuto: true, autoReason: "shift_timeout" }),
    punch("restart", "in", "09:30"),
    punch("out", "out", "13:00"),
  ];
  // The late log judges one record per shift, so the table must not invent a
  // second late arrival that no admin action could ever clear.
  assert.deepEqual(
    lateLog(punches).map((record) => [record.id, record.minutesLate, record.isExcused]),
    [["in", 12, true]],
  );
  const rows = dashboard(punches);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => [row.id, row.lateMinutes, row.excused]),
    [
      ["in", 0, true],
      ["restart", 0, false],
    ],
  );
});

test("off-shift work is never late on either screen", () => {
  const punches = [
    punch("in", "in", "05:12", { isOffShiftDay: true }),
    punch("out", "out", "13:00", { isOffShiftDay: true }),
  ];
  assert.deepEqual(lateLog(punches), []);
  assert.equal(dashboard(punches)[0].lateMinutes, 0);
});

test("both screens judge a clock-in against the schedule stored on its punch", () => {
  // The employee's shift later moved to 05:00; this punch was taken at 06:00.
  const punches = [
    punch("in", "in", "06:10", {
      scheduledShiftStart: at("06:00").toISOString(),
      scheduledShiftEnd: at("14:00").toISOString(),
    }),
  ];
  const record = lateLog(punches, at("15:00"))[0];
  assert.equal(record.minutesLate, 10);
  assert.equal(dashboard(punches, at("15:00"))[0].lateMinutes, 10);
});

test("a correction lands on the punch even when it stored an older schedule", () => {
  const stale = punch("in", "in", "05:12", {
    scheduledShiftStart: at("04:00").toISOString(),
    scheduledShiftEnd: at("12:00").toISOString(),
  });
  const plan = planManualClockIn(employee, [stale], at("05:00"), at("14:00"), false);
  assert.equal(plan.existing?.id, "in");
});
