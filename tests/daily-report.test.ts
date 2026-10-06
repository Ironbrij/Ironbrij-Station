import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateReportDays,
  dailyReportSubject,
  dayReadiness,
  dayTiming,
  hasAttendanceToReport,
  plannedShifts,
  reportDayLabel,
} from "../src/lib/daily-report.ts";
import { buildReportRows } from "../src/lib/report-rows.ts";
import { clientEmailsFor } from "../src/lib/client-emails.ts";
import { dailyReportHistoryId } from "../src/lib/report-history.ts";
import type { Company, Employee, LeaveRequest, Punch } from "../src/lib/types.ts";

// A client's day is ready when every VA's shift has ended and they have clocked out.

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

const early = {
  ...employee,
  id: "early",
  name: "Ana Reyes",
  email: "ana@example.com",
  shiftStartTime: "05:00",
  shiftEndTime: "13:00",
} as Employee;

const company = {
  id: "alpha",
  name: "Northwind",
  defaultShiftHours: 8,
  holidays: [],
  workingDays: [0, 1, 2, 3, 4, 5, 6],
} as Company;

const punch = (
  id: string,
  type: Punch["type"],
  time: string,
  who: Employee = employee,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    employeeId: who.id,
    companyId: "alpha",
    type,
    timestamp: at(time),
    attendanceDate: DATE,
    shiftTimezone: "UTC",
    ...(type === "in"
      ? {
          scheduledShiftStart: at(who.shiftStartTime!).toISOString(),
          scheduledShiftEnd: at(who.shiftEndTime!).toISOString(),
        }
      : {}),
    ...extra,
  }) as unknown as Punch;

function check(
  now: Date,
  punches: Punch[],
  staff: Employee[] = [employee],
  leaves: LeaveRequest[] = [],
) {
  const planned = plannedShifts({
    employees: staff,
    leaves,
    company,
    companyFilter: "alpha",
    date: DATE,
  });
  const rows = buildReportRows({
    employees: staff,
    punches,
    leaves,
    overtimeRequests: [],
    departments: [],
    companies: [company],
    companyFilter: "alpha",
    fallbackCompany: company,
    from: DATE,
    to: DATE,
    now,
  });
  return {
    planned,
    rows,
    readiness: dayReadiness({ planned, rows, date: DATE, timezone: "UTC", now }),
  };
}

test("the report waits while a shift is still running, even for someone who clocked out early", () => {
  const { readiness } = check(at("15:00"), [
    punch("in", "in", "09:00"),
    punch("out", "out", "14:00"),
  ]);
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.waitingFor, [{ name: "Maria Santos", reason: "shift not finished" }]);
});

test("it waits for a VA who has not started, who has no row in the report yet", () => {
  // Ana finished at 13:00; Maria's 09:00 shift has not been punched or missed yet.
  const { readiness, rows } = check(
    at("14:00"),
    [punch("a-in", "in", "05:00", early), punch("a-out", "out", "13:00", early)],
    [employee, early],
  );
  assert.deepEqual(
    rows.map((row) => row.employeeName),
    ["Ana Reyes"],
  );
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.waitingFor, [{ name: "Maria Santos", reason: "shift not finished" }]);
});

test("it is ready a few minutes after the last shift ends, once everyone has clocked out", () => {
  const punches = [punch("in", "in", "09:00"), punch("out", "out", "17:00")];
  // Inside the clock-out grace: not yet.
  assert.equal(check(at("17:10"), punches).readiness.ready, false);
  const { readiness } = check(at("17:20"), punches);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.forced, false);
  assert.deepEqual(readiness.waitingFor, []);
});

test("someone still clocked in after their shift holds the report", () => {
  const { readiness } = check(at("17:30"), [punch("in", "in", "09:00")]);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.waitingFor.length, 1);
  assert.equal(readiness.waitingFor[0].name, "Maria Santos");
  assert.match(readiness.waitingFor[0].reason, /still clocked in|no clock-out yet/);
});

test("a VA who never clocks out holds the report only for the longest wait", () => {
  const punches = [punch("in", "in", "09:00")];
  const held = check(at("19:59"), punches).readiness;
  assert.equal(held.ready, false);
  // 17:00 plus three hours: it goes, with the missing clock-out left in the report.
  const { readiness, rows } = check(at("20:01"), punches);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.forced, true);
  assert.equal(readiness.waitingFor.length, 1);
  assert.match(rows[0].remarks, /Missing Clock-out|In Progress/);
});

test("a VA who never turned up is reported absent once their shift is over", () => {
  const { readiness, rows } = check(at("17:30"), []);
  assert.equal(readiness.ready, true);
  assert.equal(rows[0].absentDays, 1);
  assert.equal(hasAttendanceToReport(rows), true);
});

test("the last shift to end sets when the report is ready", () => {
  const planned = plannedShifts({
    employees: [employee, early],
    leaves: [],
    company,
    companyFilter: "alpha",
    date: DATE,
  });
  const timing = dayTiming({ planned, date: DATE, timezone: "UTC" });
  assert.equal(timing.lastShiftEnd?.toISOString(), "2026-09-10T17:00:00.000Z");
  assert.equal(timing.settledAt.toISOString(), "2026-09-10T17:15:00.000Z");
  assert.equal(timing.sendAnywayAt.toISOString(), "2026-09-10T20:00:00.000Z");
  assert.equal(timing.expiresAt.toISOString(), "2026-09-11T08:00:00.000Z");
});

test("leave, holidays, days off, and people who have left are not waited for", () => {
  const leave = {
    id: "l",
    employeeId: "emp",
    status: "approved",
    dateFrom: DATE,
    dateTo: DATE,
    leaveType: "full_day",
    paymentStatus: "paid",
  } as LeaveRequest;
  const plan = (staff: Employee[], leaves: LeaveRequest[] = [], co = company, date = DATE) =>
    plannedShifts({ employees: staff, leaves, company: co, companyFilter: "alpha", date });

  assert.deepEqual(
    plan([employee, early], [leave]).map((shift) => shift.id),
    ["early"],
  );
  assert.equal(plan([{ ...employee, status: "inactive" }]).length, 0);
  assert.equal(plan([{ ...employee, inviteStatus: "pending" }]).length, 0);
  assert.equal(plan([{ ...employee, workingDays: [1, 2] }]).length, 0);
  const holiday = {
    ...company,
    holidayAssignments: [
      { id: "h", date: DATE, name: "Show Day", targetType: "all" as const, companyIds: ["alpha"] },
    ],
  } as Company;
  assert.equal(plan([employee], [], holiday).length, 0);
});

test("a night shift is reported for the day it started, and ends the next morning", () => {
  const night = { ...employee, shiftStartTime: "22:00", shiftEndTime: "06:00" } as Employee;
  const [shift] = plannedShifts({
    employees: [night],
    leaves: [],
    company,
    companyFilter: "alpha",
    date: DATE,
  });
  assert.equal(shift.endsAt.toISOString(), "2026-09-11T06:00:00.000Z");
  // Yesterday as well as today, so Thursday's night shift is still reported on Friday morning.
  assert.deepEqual(candidateReportDays(at("07:00", "2026-09-11"), "UTC"), [DATE, "2026-09-11"]);
});

test("the day is read in the client's own clock", () => {
  // 2026-09-10T20:00Z is already the 11th in Sydney.
  assert.deepEqual(candidateReportDays(at("20:00"), "Australia/Sydney"), [DATE, "2026-09-11"]);
  assert.deepEqual(candidateReportDays(at("20:00"), "UTC"), ["2026-09-09", DATE]);
});

test("nothing is worth sending when no one worked and no one was due", () => {
  assert.equal(hasAttendanceToReport([]), false);
});

test("every daily report to a client has one subject, and the day is in the label", () => {
  assert.equal(dailyReportSubject(" Northwind "), "Northwind VAs Daily Attendance Report");
  assert.equal(reportDayLabel(DATE), "Thu 10 Sep 2026");
});

test("a day has one record id per client, which is how it is not sent twice", () => {
  assert.equal(dailyReportHistoryId("alpha", DATE), "daily-alpha-2026-09-10");
  assert.equal(dailyReportHistoryId("a/b", DATE), "daily-a-b-2026-09-10");
});

test("the complete-attendance remark says Day for a one-day report", () => {
  const { rows } = check(at("17:30"), [punch("in", "in", "09:00"), punch("out", "out", "17:00")]);
  assert.match(rows[0].remarks, /Complete Attendance for the Day: Sep 10, 2026/);
});

test("the daily report is off for a client until they switch it on", () => {
  const base = { clientEmails: ["c@x.com"] };
  assert.deepEqual(clientEmailsFor(base, "dailyReport"), []);
  assert.deepEqual(clientEmailsFor({ ...base, clientEmailTopics: {} }, "dailyReport"), []);
  assert.deepEqual(
    clientEmailsFor({ ...base, clientEmailTopics: { dailyReport: true } }, "dailyReport"),
    ["c@x.com"],
  );
  // The others are still on until switched off.
  assert.deepEqual(clientEmailsFor(base, "weeklyReport"), ["c@x.com"]);
});
