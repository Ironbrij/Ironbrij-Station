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
/** Records for the shift under test; other days in the window are missed days. */
const lateLogFor = (punches: Punch[], now = at("14:00")) =>
  lateLog(punches, now).filter((record) => record.dateKey === DATE);

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
  assert.deepEqual(lateLogFor(corrected), []);
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
    lateLogFor(punches).map((record) => [record.id, record.minutesLate, record.isExcused]),
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
  assert.deepEqual(lateLogFor(punches), []);
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
  const record = lateLogFor(punches, at("15:00"))[0];
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

test("a day the employee never clocked in is listed by both screens", () => {
  // The shift is over and nothing was punched: the dashboard flags the date,
  // so the late log has to offer it too or the admin cannot fix it.
  const now = at("23:00");
  assert.equal(dashboard([], now)[0].status, "missing");
  const record = lateLog([], now).find((item) => item.dateKey === DATE);
  assert.equal(record?.kind, "missing");
  assert.equal(record?.minutesLate, 480);
});

test("a missed shift stays listed after its end, not only while it is running", () => {
  const duringShift = lateLog([], at("06:00")).find((item) => item.dateKey === DATE);
  const afterShift = lateLog([], at("23:00")).find((item) => item.dateKey === DATE);
  assert.equal(duringShift?.minutesLate, 60);
  assert.equal(afterShift?.minutesLate, 480);
});

test("both screens wait out the grace period before calling a shift missed", () => {
  const insideGrace = at("05:03");
  assert.equal(dashboard([], insideGrace)[0].status, "upcoming");
  assert.equal(
    lateLog([], insideGrace).some((item) => item.dateKey === DATE),
    false,
  );
  const pastGrace = at("05:20");
  assert.equal(dashboard([], pastGrace)[0].status, "missing");
  assert.equal(
    lateLog([], pastGrace).some((item) => item.dateKey === DATE),
    true,
  );
});

test("an approved leave or a day off is never reported as a missed shift", () => {
  const onLeave = buildLateRecords(
    [employee],
    [],
    [
      {
        id: "lv",
        employeeId: "login",
        companyId: "alpha",
        status: "approved",
        dateFrom: DATE,
        dateTo: DATE,
      },
    ] as unknown as LeaveRequest[],
    companies,
    at("23:00"),
    { period: "all" },
  );
  assert.equal(
    onLeave.some((item) => item.dateKey === DATE),
    false,
  );
});
