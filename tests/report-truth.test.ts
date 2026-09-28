import test from "node:test";
import assert from "node:assert/strict";
import { buildReportRows, describeScheduledShift } from "../src/lib/report-rows.ts";
import type { Company, Employee, Punch } from "../src/lib/types.ts";

// The report says only what happened: no made-up shifts, no absence before a
// shift is over, and no absence for people who have left or never started.

const DATE = "2026-09-10"; // a Thursday
const at = (time: string, date = DATE) => new Date(`${date}T${time}:00Z`);

const employee = {
  id: "emp",
  name: "Maria Santos",
  email: "maria@example.com",
  companyId: "alpha",
  companyIds: ["alpha"],
  status: "active",
  inviteStatus: "accepted",
  timezone: "UTC",
  shiftTimezone: "UTC",
  shiftStartTime: "09:00",
  shiftEndTime: "17:00",
  workingDays: [0, 1, 2, 3, 4, 5, 6],
  createdAt: "2026-01-01T00:00:00Z",
} as Employee;

const companies = [
  { id: "alpha", name: "Northwind", defaultShiftHours: 8, holidays: [], workingDays: [0, 1, 2, 3, 4, 5, 6] },
] as Company[];

const punch = (id: string, type: Punch["type"], time: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    employeeId: "emp",
    companyId: "alpha",
    type,
    timestamp: at(time),
    attendanceDate: DATE,
    shiftTimezone: "UTC",
    ...(type === "in"
      ? { scheduledShiftStart: at("09:00").toISOString(), scheduledShiftEnd: at("17:00").toISOString() }
      : {}),
    ...extra,
  }) as unknown as Punch;

function report(punches: Punch[], who: Employee = employee, now = at("20:00"), list = companies) {
  return buildReportRows({
    employees: [who],
    punches,
    leaves: [],
    overtimeRequests: [],
    departments: [],
    companies: list,
    companyFilter: "alpha",
    fallbackCompany: list[0],
    from: DATE,
    to: DATE,
    now,
  });
}

test("a profile without shift times says so instead of showing nine to five", () => {
  const noTimes = { ...employee, shiftStartTime: undefined, shiftEndTime: undefined } as Employee;
  assert.equal(describeScheduledShift(noTimes, DATE), "Not set");
});

test("split shifts show every slot for that weekday", () => {
  const split = {
    ...employee,
    isMultipleShift: true,
    shifts: [
      { startTime: "04:00", endTime: "07:00" },
      { startTime: "13:00", endTime: "17:00", workingDays: [4] },
      { startTime: "20:00", endTime: "22:00", workingDays: [1] },
    ],
  } as Employee;
  assert.equal(describeScheduledShift(split, DATE), "04:00–07:00, 13:00–17:00");
});

test("nobody is absent before today's shift is over", () => {
  const rows = report([], employee, at("11:00"));
  assert.equal(rows.reduce((sum, row) => sum + row.absentDays, 0), 0);
});

test("a shift that has ended with no punch is absent", () => {
  const [row] = report([], employee, at("20:00"));
  assert.equal(row.absentDays, 1);
  assert.equal(row.dailyIntervals[0].status, "Absent (no punch)");
  assert.equal(row.dailyIntervals[0].scheduledShift, "09:00–17:00");
});

test("people who have left, or never accepted their invite, are never absent", () => {
  assert.equal(report([], { ...employee, status: "inactive" }).length, 0);
  assert.equal(report([], { ...employee, inviteStatus: "pending" }).length, 0);
});

test("a day worked only as extra time is worked, not absent", () => {
  const [row] = report([
    punch("x1", "extra_in", "18:00"),
    punch("x2", "extra_out", "19:00"),
  ]);
  assert.equal(row.workedDays, 1);
  assert.equal(row.absentDays, 0);
});

test("a missing clock-out is in the remarks and the week is not called complete", () => {
  // Clocked in on the 10th, never out, then started the 11th's shift.
  const nextDay = "2026-09-11";
  const [row] = report(
    [
      punch("in", "in", "09:00"),
      punch("in2", "in", "09:00", {
        timestamp: at("09:00", nextDay),
        attendanceDate: nextDay,
        scheduledShiftStart: at("09:00", nextDay).toISOString(),
        scheduledShiftEnd: at("17:00", nextDay).toISOString(),
      }),
      punch("out2", "out", "17:00", { timestamp: at("17:00", nextDay), attendanceDate: nextDay }),
    ],
    employee,
    at("20:00", nextDay),
  );
  assert.match(row.remarks, /Missing Clock-out/);
  assert.doesNotMatch(row.remarks, /Complete Attendance/);
  assert.equal(row.dailyIntervals[0].status, "Missing Punch Out");
});

test("someone still clocked in is in progress, not complete", () => {
  const [row] = report([punch("in", "in", "09:00")], employee, at("15:00"));
  assert.equal(row.dailyIntervals[0].status, "In progress");
  assert.match(row.remarks, /In Progress/);
  assert.doesNotMatch(row.remarks, /Complete Attendance/);
});

test("a full day with its clock-out is complete", () => {
  const [row] = report([punch("in", "in", "09:00"), punch("out", "out", "17:00")]);
  assert.match(row.remarks, /Complete Attendance/);
  assert.equal(row.dailyIntervals[0].status, "Complete");
});

test("work on a holiday says so", () => {
  const withHoliday = [
    {
      ...companies[0],
      holidayAssignments: [
        { id: "h", date: DATE, name: "Show Day", targetType: "all" as const, companyIds: ["alpha"] },
      ],
    },
  ] as Company[];
  const [row] = report(
    [punch("in", "in", "09:00"), punch("out", "out", "12:00")],
    employee,
    at("20:00"),
    withHoliday,
  );
  assert.equal(row.dailyIntervals[0].status, "Worked on holiday");
  assert.equal(row.dailyIntervals[0].scheduledShift, "Holiday");
  assert.equal(row.regularHours, 0);
});

test("no made-up department or role", () => {
  const [row] = report([punch("in", "in", "09:00"), punch("out", "out", "17:00")]);
  assert.equal(row.department, "—");
  assert.equal(row.role, "—");
});
