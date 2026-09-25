import test from "node:test";
import assert from "node:assert/strict";
import { buildAttendanceLog } from "../src/lib/dashboard-attendance.ts";
import { buildReportRows } from "../src/lib/report-rows.ts";
import type { Company, Employee, Punch } from "../src/lib/types.ts";

// Days where the report used to disagree with the dashboard. The dashboard was
// right; both now read the same sessions.

const DATE = "2026-09-10"; // a Thursday
const at = (time: string, date = DATE) => new Date(`${date}T${time}:00Z`);

const employee = {
  id: "emp",
  authUid: "login",
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
  breakAllowanceMinutes: 30,
  createdAt: "2026-01-01T00:00:00Z",
} as Employee;
const companies = [
  {
    id: "alpha",
    name: "Northwind",
    defaultShiftHours: 8,
    holidays: [],
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    lateGraceMinutes: 5,
  },
] as Company[];

const punch = (
  id: string,
  type: Punch["type"],
  time: string,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    employeeId: "emp",
    companyId: "alpha",
    type,
    timestamp: at(time),
    attendanceDate: DATE,
    shiftTimezone: "UTC",
    scheduledShiftStart: at("09:00").toISOString(),
    scheduledShiftEnd: at("17:00").toISOString(),
    ...extra,
  }) as unknown as Punch;

function reportDay(punches: Punch[], who: Employee = employee, now = at("20:00")) {
  const [row] = buildReportRows({
    employees: [who],
    punches,
    leaves: [],
    overtimeRequests: [],
    departments: [],
    companies,
    companyFilter: "alpha",
    fallbackCompany: companies[0],
    from: DATE,
    to: DATE,
    now,
  });
  return row.dailyIntervals.find((day) => day.date === DATE)!;
}

function dashboardDay(punches: Punch[], who: Employee = employee, now = at("20:00")) {
  return buildAttendanceLog({
    employees: [who],
    punches,
    companies,
    leaves: [],
    now,
    date: DATE,
    companyId: "alpha",
  }).filter((row) => row.date === DATE && row.timeIn);
}

test("a punched lunch is taken off the report's hours, as on the dashboard", () => {
  const punches = [
    punch("in", "in", "09:00"),
    punch("l1", "lunch_start", "12:00"),
    punch("l2", "lunch_end", "13:00"),
    punch("out", "out", "17:00", { punchInId: "in" }),
  ];
  const [dash] = dashboardDay(punches);
  const day = reportDay(punches);
  assert.equal(dash.hours, 7);
  // The report counted the hour's lunch as work and showed a full 8.
  assert.equal(day.regularHours, 7);
  assert.equal(day.breakMinutes, 60);
  assert.equal(day.unloggedBreakMinutes, 0);
});

test("time between two sessions of a split day is not counted as work", () => {
  const split = {
    ...employee,
    isMultipleShift: true,
    shifts: [
      { startTime: "09:00", endTime: "11:00", workingDays: [0, 1, 2, 3, 4, 5, 6] },
      { startTime: "14:00", endTime: "17:00", workingDays: [0, 1, 2, 3, 4, 5, 6] },
    ],
  } as Employee;
  const punches = [
    punch("a", "in", "09:00", { scheduledShiftEnd: at("11:00").toISOString() }),
    punch("a-out", "out", "11:00", {
      punchInId: "a",
      scheduledShiftEnd: at("11:00").toISOString(),
    }),
    punch("b", "in", "14:00", { scheduledShiftStart: at("14:00").toISOString() }),
    // Left the second shift two hours early.
    punch("b-out", "out", "15:00", {
      punchInId: "b",
      scheduledShiftStart: at("14:00").toISOString(),
    }),
  ];
  const dashboardHours = dashboardDay(punches, split).reduce(
    (sum, row) => sum + (row.hours ?? 0),
    0,
  );
  const day = reportDay(punches, split);
  assert.equal(dashboardHours, 3);
  // First clock-in to last clock-out made this a full five-hour day.
  assert.equal(day.regularHours, 3);
  assert.equal(day.sessions?.length, 2);
});

test("a day with no clock-out is flagged, not credited up to the moment the report is read", () => {
  const punches = [punch("in", "in", "09:00")];
  const later = at("08:00", "2026-09-15");
  const [dash] = dashboardDay(punches, employee, later);
  const day = reportDay(punches, employee, later);
  assert.equal(dash.status, "review");
  assert.equal(dash.hours, null);
  assert.equal(day.isMissingPunchOut, true);
  assert.equal(day.status, "Missing Punch Out");
  assert.equal(day.regularHours, 0);
});

test("lateness is judged on the schedule saved with the punch, on both screens", () => {
  // The start time moved to 10:00 after this 09:20 clock-in on the 09:00 shift.
  const moved = { ...employee, shiftStartTime: "10:00", shiftEndTime: "18:00" } as Employee;
  const punches = [punch("in", "in", "09:20"), punch("out", "out", "17:00", { punchInId: "in" })];
  const [dash] = dashboardDay(punches, moved);
  const day = reportDay(punches, moved);
  assert.equal(dash.lateMinutes, 20);
  assert.equal(day.minutesLate, 20);
  assert.match(day.status, /Late \(20m\)/);
});

test("an excused late start reads as excused on both screens", () => {
  const punches = [
    punch("in", "in", "09:20", { isExcused: true, excuseReason: "Traffic" }),
    punch("out", "out", "17:00", { punchInId: "in" }),
  ];
  const [dash] = dashboardDay(punches);
  const day = reportDay(punches);
  assert.equal(dash.lateMinutes, 0);
  assert.equal(dash.excused, true);
  assert.equal(day.minutesLate, 0);
  assert.equal(day.status, "Excused (Not Late)");
});

test("a corrected (voided) clock-out never reaches the report", () => {
  const punches = [
    punch("in", "in", "09:00"),
    punch("bad-out", "out", "10:00", { punchInId: "in", voidedAt: "2026-09-10T10:05:00Z" }),
    punch("out", "out", "17:00", { punchInId: "in" }),
  ];
  const [dash] = dashboardDay(punches);
  const day = reportDay(punches);
  assert.equal(dash.timeOut?.toISOString(), at("17:00").toISOString());
  assert.equal(day.punchOutTime, "17:00");
  assert.equal(day.regularHours, dash.hours! - (dash.overtime ?? 0));
});
