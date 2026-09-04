import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateTotalShiftMinutes,
  cleanFirestoreData,
  getEmployeeBreakSettings,
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "../src/lib/company-context.ts";
import { getActiveWorkingSession } from "../src/lib/attendance.ts";
import type { Employee, Punch } from "../src/lib/types.ts";

const employee: Employee = {
  id: "employee-1",
  name: "Employee One",
  email: "employee@example.com",
  status: "active",
  inviteStatus: "accepted",
  companyId: "alpha",
  companyIds: ["alpha", "beta", "gamma"],
  shiftStartTime: "09:00",
  shiftEndTime: "17:00",
  requiredWorkMinutes: 480,
  companyMemberships: {
    alpha: { companyId: "alpha", requiredWorkMinutes: 480 },
    beta: {
      companyId: "beta",
      requiredWorkMinutes: 240,
      shiftStartTime: "18:00",
      shiftEndTime: "22:00",
    },
    gamma: { companyId: "gamma", requiredWorkMinutes: 360 },
  },
};

test("one employee can retain more than two company memberships", () => {
  assert.deepEqual(getEmployeeCompanyIds(employee), ["alpha", "beta", "gamma"]);
});

test("active company resolves its own required hours and shift", () => {
  const betaEmployee = getEmployeeForCompany(employee, "beta");
  assert.equal(betaEmployee.companyId, "beta");
  assert.equal(betaEmployee.requiredWorkMinutes, 240);
  assert.equal(betaEmployee.shiftStartTime, "18:00");
  assert.equal(betaEmployee.shiftEndTime, "22:00");
});

test("company-aware punch filtering does not mix companies", () => {
  const alphaPunch = { companyId: "alpha" } as Punch;
  const betaPunch = { companyId: "beta" } as Punch;
  assert.equal(getPunchCompanyId(alphaPunch, employee), "alpha");
  assert.equal(getPunchCompanyId(betaPunch, employee), "beta");
});

test("historical punch without company remains attached to the legacy primary company", () => {
  assert.equal(getPunchCompanyId({} as Punch, employee), "alpha");
});

test("calculateTotalShiftMinutes correctly sums multiple shift intervals", () => {
  const shifts = [
    { startTime: "04:00", endTime: "07:00" }, // 3 hours = 180 min
    { startTime: "12:00", endTime: "15:00" }, // 3 hours = 180 min
    { startTime: "16:00", endTime: "19:00" }, // 3 hours = 180 min
  ];
  const total = calculateTotalShiftMinutes(true, shifts);
  assert.equal(total, 540); // 9 hours total = 540 minutes
});

test("calculateTotalShiftMinutes and getRequiredWorkMinutes respect shift-specific working days", () => {
  const shifts = [
    { startTime: "04:00", endTime: "07:00", workingDays: [0, 1] }, // Shift #1: Sun, Mon (3h)
    { startTime: "12:00", endTime: "15:00", workingDays: [4] }, // Shift #2: Thu only (3h)
  ];
  // Sunday (0): Shift 1 active (180 mins)
  assert.equal(calculateTotalShiftMinutes(true, shifts, undefined, undefined, 0), 180);
  // Monday (1): Shift 1 active (180 mins)
  assert.equal(calculateTotalShiftMinutes(true, shifts, undefined, undefined, 1), 180);
  // Tuesday (2): No shifts active (0 mins)
  assert.equal(calculateTotalShiftMinutes(true, shifts, undefined, undefined, 2), 0);
  // Thursday (4): Shift 2 active (180 mins)
  assert.equal(calculateTotalShiftMinutes(true, shifts, undefined, undefined, 4), 180);

  const multiShiftEmployee: Employee = {
    id: "emp-multi",
    name: "Multi Shift User",
    email: "multi@example.com",
    status: "active",
    inviteStatus: "accepted",
    isMultipleShift: true,
    shifts,
  };

  // getRequiredWorkMinutes with dayOfWeek
  assert.equal(getRequiredWorkMinutes(multiShiftEmployee, null, 0), 180); // Sunday
  assert.equal(getRequiredWorkMinutes(multiShiftEmployee, null, 1), 180); // Monday
  assert.equal(getRequiredWorkMinutes(multiShiftEmployee, null, 2), 0); // Tuesday (off day)
  assert.equal(getRequiredWorkMinutes(multiShiftEmployee, null, 4), 180); // Thursday
});

test("getEmployeeBreakSettings defaults to 30 minutes and 1 break", () => {
  const defaultSettings = getEmployeeBreakSettings({} as Employee);
  assert.deepEqual(defaultSettings, { allowanceMinutes: 30, maxDailyBreaks: 1 });
});

test("getEmployeeBreakSettings handles N/A (0 breaks / 0 minutes)", () => {
  const noBreakEmp: Employee = {
    ...employee,
    breakAllowanceMinutes: 0,
    maxDailyBreaks: 0,
  };
  assert.deepEqual(getEmployeeBreakSettings(noBreakEmp), {
    allowanceMinutes: 0,
    maxDailyBreaks: 0,
  });

  const membershipNoBreakEmp: Employee = {
    ...employee,
    companyMemberships: {
      alpha: { companyId: "alpha", breakAllowanceMinutes: 0, maxDailyBreaks: 0 },
    },
  };
  assert.deepEqual(getEmployeeBreakSettings(membershipNoBreakEmp, "alpha"), {
    allowanceMinutes: 0,
    maxDailyBreaks: 0,
  });
});

test("getEmployeeBreakSettings handles custom break allowances", () => {
  const customEmp: Employee = {
    ...employee,
    breakAllowanceMinutes: 45,
    maxDailyBreaks: 2,
  };
  assert.deepEqual(getEmployeeBreakSettings(customEmp), {
    allowanceMinutes: 45,
    maxDailyBreaks: 2,
  });
});

test("getActiveWorkingSession strictly resolves only the single latest active company session", () => {
  const emp: Employee = {
    id: "emp-multi",
    name: "Multi Worker",
    role: "employee",
    companyIds: ["alpha", "beta"],
    shiftStartTime: "00:00",
    shiftEndTime: "23:59",
    workingDays: [0, 1, 2, 3, 4, 5, 6],
    companyMemberships: {
      alpha: {
        companyId: "alpha",
        shiftStartTime: "00:00",
        shiftEndTime: "23:59",
        workingDays: [0, 1, 2, 3, 4, 5, 6],
      },
      beta: {
        companyId: "beta",
        shiftStartTime: "00:00",
        shiftEndTime: "23:59",
        workingDays: [0, 1, 2, 3, 4, 5, 6],
      },
    },
  };

  const punches: Punch[] = [
    {
      id: "p1",
      employeeId: "emp-multi",
      companyId: "alpha",
      type: "in",
      timestamp: "2026-08-28T08:00:00.000Z",
    },
    {
      id: "p2",
      employeeId: "emp-multi",
      companyId: "beta",
      type: "in",
      timestamp: "2026-08-28T08:11:00.000Z",
    },
  ];

  // Beta is latest, so Beta is the ONLY active working company
  const session = getActiveWorkingSession(punches, emp, new Date("2026-08-28T08:15:00.000Z"));
  assert.equal(session.activeCompanyId, "beta");

  // After punching out from beta, active session is null
  punches.push({
    id: "p3",
    employeeId: "emp-multi",
    companyId: "beta",
    type: "out",
    timestamp: "2026-08-28T08:30:00.000Z",
  });
  const sessionAfterOut = getActiveWorkingSession(
    punches,
    emp,
    new Date("2026-08-28T08:35:00.000Z"),
  );
  assert.equal(sessionAfterOut.activeCompanyId, null);
});

test("cleanFirestoreData strips undefined values while preserving Dates and Timestamp-like objects", () => {
  const testDate = new Date("2026-09-04T08:00:00.000Z");
  const fakeTimestamp = {
    toMillis: () => 1788508800000,
    seconds: 1788508800,
    nanoseconds: 0,
  };

  const dirtyPayload = {
    employeeId: "emp-1",
    notes: undefined,
    date: testDate,
    timestamp: fakeTimestamp,
    metadata: {
      tags: ["punch", undefined, "test"],
      extraInfo: undefined,
      nested: {
        validKey: "ok",
        emptyKey: undefined,
      },
    },
  };

  const cleaned = cleanFirestoreData(dirtyPayload as any);
  assert.equal(cleaned.employeeId, "emp-1");
  assert.equal("notes" in cleaned, false);
  assert.equal(cleaned.date, testDate);
  assert.equal(cleaned.timestamp, fakeTimestamp);
  assert.equal(cleaned.metadata.nested.validKey, "ok");
  assert.equal("emptyKey" in cleaned.metadata.nested, false);
  assert.equal("extraInfo" in cleaned.metadata, false);
});

test("getEmployeeForCompany returns base employee when companyId is 'all'", () => {
  const allEmp = getEmployeeForCompany(employee, "all");
  assert.equal(allEmp.id, employee.id);
  assert.equal(allEmp.companyId, "alpha");
  assert.equal(allEmp.requiredWorkMinutes, 480);
});

