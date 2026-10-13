import test from "node:test";
import assert from "node:assert/strict";
import { buildAttendanceLog } from "../src/lib/dashboard-attendance.ts";
import { buildLateRecords } from "../src/lib/late-records.ts";
import {
  getActiveEmployeeLeave,
  getEmployeeApprovedLeaveForDate,
  getLeaveLabel,
} from "../src/lib/attendance.ts";
import { computeLeaveCreditBalance } from "../src/lib/leave-credits.ts";
import { buildReportRows } from "../src/lib/report-rows.ts";
import {
  buildMarkedLeave,
  leaveMarkProblem,
  MAX_MARKED_LEAVE_DAYS,
  type LeaveMarkInput,
} from "../src/lib/leave-marking.ts";
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
  annualLeaveCredits: 10,
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

const input = (overrides: Partial<LeaveMarkInput> = {}): LeaveMarkInput => ({
  employeeId: "profile",
  companyId: "alpha",
  dateFrom: DATE,
  reason: "Sick, told the client on WhatsApp",
  kind: "paid",
  actor: "ann@example.com",
  decidedAt: "2026-09-11T01:00:00.000Z",
  ...overrides,
});
const marked = (overrides: Partial<LeaveMarkInput> = {}) =>
  ({
    id: "marked",
    createdAt: undefined as never,
    ...buildMarkedLeave(input(overrides)),
  }) as LeaveRequest;

test("a marked day is an approved full-day leave carrying the reason", () => {
  const leave = buildMarkedLeave(input({ reason: "  Sick, told the client  " }));
  assert.equal(leave.status, "approved");
  assert.equal(leave.leaveType, "full_day");
  assert.equal(leave.employeeId, "profile");
  assert.equal(leave.companyId, "alpha");
  assert.equal(leave.dateFrom, DATE);
  assert.equal(leave.dateTo, DATE);
  assert.equal(leave.reason, "Sick, told the client");
  assert.equal(leave.remarks, "Sick, told the client");
  assert.equal(leave.decidedBy, "ann@example.com");
  assert.equal(leave.decisionSource, "admin");
});

test("a last day makes the leave a range, and an earlier or blank one keeps it a single day", () => {
  assert.equal(buildMarkedLeave(input({ dateTo: "2026-09-12" })).dateTo, "2026-09-12");
  assert.equal(buildMarkedLeave(input({ dateTo: "" })).dateTo, DATE);
  assert.equal(buildMarkedLeave(input({ dateTo: DATE })).dateTo, DATE);
});

test("a mark needs an employee, a date and a reason", () => {
  assert.equal(leaveMarkProblem(input()), null);
  assert.equal(leaveMarkProblem(input({ employeeId: "" })), "Choose the employee.");
  assert.equal(leaveMarkProblem(input({ dateFrom: "" })), "Choose the date they are away.");
  assert.equal(leaveMarkProblem(input({ reason: "   " })), "Add the reason for the leave.");
});

test("the last day cannot be before the first, nor run on for months", () => {
  assert.equal(
    leaveMarkProblem(input({ dateTo: "2026-09-09" })),
    "The last day is before the first day.",
  );
  assert.equal(leaveMarkProblem(input({ dateTo: "2026-11-08" })), null); // 60 days
  assert.match(
    leaveMarkProblem(input({ dateTo: "2026-11-09" })) ?? "",
    new RegExp(`at most ${MAX_MARKED_LEAVE_DAYS} days`),
  );
});

test("marking a missed day stops the late log listing it", () => {
  const now = at("23:00");
  const before = buildLateRecords([employee], [], [], companies, now, { period: "all" });
  assert.equal(before.find((item) => item.dateKey === DATE)?.kind, "missing");

  const after = buildLateRecords([employee], [], [marked()], companies, now, { period: "all" });
  assert.equal(
    after.some((item) => item.dateKey === DATE),
    false,
  );
});

test("the dashboard shows the marked day as leave, not as a missed shift", () => {
  const rows = (leaves: LeaveRequest[]) =>
    buildAttendanceLog({
      employees: [employee],
      punches: [],
      companies,
      leaves,
      now: at("23:00"),
      date: DATE,
    });
  assert.equal(rows([])[0].status, "missing");
  assert.equal(rows([marked()])[0].status, "leave");
});

test("every day of a marked range counts as leave, and the day after does not", () => {
  const leave = marked({ dateTo: "2026-09-12" });
  for (const date of ["2026-09-10", "2026-09-11", "2026-09-12"]) {
    assert.ok(getEmployeeApprovedLeaveForDate(employee, [leave], date), date);
  }
  assert.equal(getEmployeeApprovedLeaveForDate(employee, [leave], "2026-09-13"), null);
});

test("marked paid leave draws on the credits and unpaid leave does not", () => {
  const balance = (leave: LeaveRequest) =>
    computeLeaveCreditBalance(employee, [leave], "2026-09-30")?.used;
  assert.equal(balance(marked({ kind: "paid" })), 1);
  assert.equal(balance(marked({ kind: "unpaid" })), 0);
});

test("a marked day is flagged so revoking it emails nobody", () => {
  assert.equal(buildMarkedLeave(input()).markedFromLateLog, true);
});

const punch = (id: string, type: Punch["type"], time: string) =>
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
  }) as unknown as Punch;

test("a marked day blocks clocking in until it is revoked", () => {
  const revoked = { ...marked(), status: "rejected" } as LeaveRequest;
  assert.ok(getActiveEmployeeLeave(employee, [marked()], at("10:00")));
  assert.equal(getActiveEmployeeLeave(employee, [revoked], at("10:00")), null);
});

test("revoking on the day gives the credit back and counts only the hours then worked", () => {
  const revoked = { ...marked(), status: "rejected" } as LeaveRequest;
  assert.equal(computeLeaveCreditBalance(employee, [marked()], "2026-09-30")?.used, 1);
  assert.equal(computeLeaveCreditBalance(employee, [revoked], "2026-09-30")?.used, 0);

  // She arrives at 10:00 for a 05:00-13:00 shift and works what is left of it.
  const punches = [punch("in", "in", "10:00"), punch("out", "out", "13:00")];
  const [row] = buildAttendanceLog({
    employees: [employee],
    punches,
    companies,
    leaves: [revoked],
    now: at("14:00"),
    date: DATE,
  });
  assert.equal(row.timeIn?.toISOString(), at("10:00").toISOString());
  assert.equal(row.hours, 3);
  assert.equal(row.lateMinutes, 300);

  // Back in the late log as a late arrival, which an admin can still excuse.
  const late = buildLateRecords([employee], punches, [revoked], companies, at("14:00"), {
    period: "all",
  }).find((item) => item.dateKey === DATE);
  assert.equal(late?.kind, "arrival");
  assert.equal(late?.minutesLate, 300);
});

test("a holiday is a day off filed as category holiday, and needs the holiday named", () => {
  const holiday = buildMarkedLeave(input({ kind: "holiday", reason: "Independence Day" }));
  assert.equal(holiday.leaveCategory, "holiday");
  assert.equal(holiday.status, "approved");
  assert.equal(holiday.reason, "Independence Day");
  assert.equal(holiday.markedFromLateLog, true);
  assert.equal(buildMarkedLeave(input({ kind: "paid" })).leaveCategory, "other");
  assert.equal(buildMarkedLeave(input({ kind: "unpaid" })).paymentStatus, "unpaid");
  assert.equal(
    leaveMarkProblem(input({ kind: "holiday", reason: " " })),
    "Add which holiday it is.",
  );
});

test("a marked holiday is a day off everywhere, not leave taken", () => {
  const holiday = marked({ kind: "holiday", reason: "Independence Day" });
  const now = at("23:00");

  // Never charged to the leave credits, where paid leave would be.
  assert.equal(computeLeaveCreditBalance(employee, [holiday], "2026-09-30")?.used, 0);
  assert.equal(
    getLeaveLabel(getEmployeeApprovedLeaveForDate(employee, [holiday], DATE)),
    "Holiday",
  );

  // The late log stops listing it, and the dashboard reads a day off, not leave.
  const late = buildLateRecords([employee], [], [holiday], companies, now, { period: "all" });
  assert.equal(
    late.some((item) => item.dateKey === DATE),
    false,
  );
  const [row] = buildAttendanceLog({
    employees: [employee],
    punches: [],
    companies,
    leaves: [holiday],
    now,
    date: DATE,
  });
  assert.equal(row.status, "off");

  // The report: the holiday is not an absence and carries no leave hours or days.
  // The next day is a real absence, which also keeps the row in the report.
  const reportOf = (leaves: LeaveRequest[]) =>
    buildReportRows({
      employees: [employee],
      punches: [],
      leaves,
      overtimeRequests: [],
      departments: [],
      companies,
      companyFilter: "alpha",
      fallbackCompany: companies[0],
      from: DATE,
      to: "2026-09-11",
      now: at("23:00", "2026-09-11"),
    })[0];
  const asHoliday = reportOf([holiday]);
  const day = asHoliday.dailyIntervals.find((item) => item.date === DATE)!;
  assert.equal(day.status, "Holiday");
  assert.match(day.note ?? "", /Independence Day/);
  assert.equal(asHoliday.absentDays, 1);
  assert.equal(asHoliday.leaveDays, 0);
  assert.equal(asHoliday.paidLeaveDays, 0);
  assert.equal(asHoliday.unpaidLeaveDays, 0);

  // The same day marked as paid leave is leave taken; unmarked, it is an absence.
  const asLeave = reportOf([marked({ kind: "paid" })]);
  assert.equal(asLeave.leaveDays, 1);
  assert.equal(asLeave.paidLeaveDays, 1);
  assert.equal(asLeave.absentDays, 1);
  assert.equal(reportOf([]).absentDays, 2);
});
