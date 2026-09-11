import test from "node:test";
import assert from "node:assert/strict";
import { buildAttendanceLog } from "../src/lib/dashboard-attendance.ts";
import type { Employee, Company, Punch } from "../src/lib/types.ts";
const employee = {
  id: "profile",
  authUid: "login",
  name: "Maria Santos",
  companyId: "alpha",
  companyIds: ["alpha"],
  status: "active",
  inviteStatus: "accepted",
  shiftTimezone: "UTC",
  shiftStartTime: "09:00",
  shiftEndTime: "17:00",
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
  { id: "beta", name: "Vector", lateGraceMinutes: 5 },
] as Company[];
const at = (time: string, date = "2026-09-10") => new Date(`${date}T${time}:00Z`);
const punch = (id: string, type: Punch["type"], time: string, extra = {}) =>
  ({
    id,
    employeeId: "login",
    companyId: "alpha",
    type,
    timestamp: at(time),
    ...extra,
  }) as unknown as Punch;
function rows(punches: Punch[], extra = {}) {
  return buildAttendanceLog({
    employees: [employee],
    punches,
    companies,
    leaves: [],
    now: at("18:00"),
    ...extra,
  });
}

test("completed table row pairs both identities and excludes breaks from hours", () => {
  const result = rows([
    punch("in", "in", "09:12"),
    punch("break", "lunch_start", "12:00"),
    punch("return", "lunch_end", "12:30"),
    punch("out", "out", "17:00", { employeeId: "profile" }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "completed");
  assert.equal(result[0].hours, 7.3);
  assert.equal(result[0].lateMinutes, 12);
  assert.equal(result[0].timeOut?.toISOString(), at("17:00").toISOString());
});
test("live and missing employees remain visible and voided outs do not hide work", () => {
  const result = rows(
    [
      punch("in", "in", "09:00"),
      punch("wrong-out", "out", "09:01", { voidedAt: at("10:00").toISOString() }),
    ],
    {
      now: at("10:00"),
      employees: [employee, { ...employee, id: "other", authUid: "other", name: "Daniel" }],
    },
  );
  assert.equal(result.find((row) => row.employeeId === "profile")?.status, "working");
  assert.equal(result.find((row) => row.employeeId === "other")?.status, "missing");
});
test("a second client and a delayed old-company out cannot hide an active shift", () => {
  const result = rows(
    [
      punch("a", "in", "09:00"),
      punch("b", "in", "10:00", { companyId: "beta" }),
      punch("a-out", "out", "10:00", { punchInId: "a", isAuto: true }),
    ],
    { employees: [{ ...employee, companyIds: ["alpha", "beta"] }], now: at("11:00") },
  );
  assert.equal(result.find((row) => row.companyId === "beta")?.status, "working");
  assert.equal(result.find((row) => row.companyId === "alpha")?.status, "completed");
  assert.equal(
    result.find((row) => row.companyId === "alpha")?.timeOut?.toISOString(),
    at("10:00").toISOString(),
  );
});
test("repeated starts do not duplicate hours and a historical open punch has no invented hours", () => {
  const result = rows([punch("a", "in", "09:00"), punch("b", "in", "09:01")], {
    date: "2026-09-10",
    now: at("18:00", "2026-09-12"),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].status, "review");
  assert.equal(result[0].hours, null);
  assert.equal(result[0].timeOut, null);
});
test("overnight shifts stay on their attendance date and remain visible today", () => {
  const result = rows([punch("night", "in", "22:00", { timestamp: at("22:00", "2026-09-09") })], {
    employees: [{ ...employee, shiftStartTime: "22:00", shiftEndTime: "06:00" }],
    now: at("02:00"),
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].date, "2026-09-09");
  assert.equal(result[0].status, "working");
});
test("historical dates and company scope exclude unrelated rows", () => {
  const result = rows(
    [
      punch("yesterday-in", "in", "09:00", { timestamp: at("09:00", "2026-09-09") }),
      punch("yesterday-out", "out", "17:00", { timestamp: at("17:00", "2026-09-09") }),
      punch("today", "in", "09:00"),
    ],
    { date: "2026-09-09" },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].date, "2026-09-09");
  assert.equal(result[0].hours, 8);
  assert.deepEqual(rows([], { companyId: "beta" }), []);
});

test("fresh server punches remain visible between dashboard timer ticks", () => {
  const result = rows([punch("fresh", "in", "09:01")], { now: at("09:00") });
  assert.equal(result[0].status, "working");
  assert.equal(result[0].hours, 0);
});
test("stored shift schedule preserves historical lateness after a schedule change", () => {
  const result = rows(
    [
      punch("in", "in", "09:12", {
        scheduledShiftStart: at("09:00").toISOString(),
        scheduledShiftEnd: at("17:00").toISOString(),
      }),
      punch("out", "out", "17:00"),
    ],
    { employees: [{ ...employee, shiftStartTime: "12:00", shiftEndTime: "20:00" }] },
  );
  assert.equal(result[0].lateMinutes, 12);
  assert.equal(result[0].scheduleStart.toISOString(), at("09:00").toISOString());
});

test("a completed morning shift does not hide an unstarted afternoon shift", () => {
  const result = rows([punch("morning", "in", "08:00"), punch("morning-out", "out", "12:00")], {
    now: at("14:00"),
    employees: [
      {
        ...employee,
        isMultipleShift: true,
        shifts: [
          { startTime: "08:00", endTime: "12:00" },
          { startTime: "13:00", endTime: "17:00" },
        ],
      },
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].status, "completed");
  assert.equal(result[1].status, "missing");
  assert.equal(result[1].scheduleStart.toISOString(), at("13:00").toISOString());
});
