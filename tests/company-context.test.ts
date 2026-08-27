import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateTotalShiftMinutes,
  getEmployeeBreakSettings,
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "../src/lib/company-context.ts";
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
  assert.deepEqual(getEmployeeBreakSettings(noBreakEmp), { allowanceMinutes: 0, maxDailyBreaks: 0 });

  const membershipNoBreakEmp: Employee = {
    ...employee,
    companyMemberships: {
      alpha: { companyId: "alpha", breakAllowanceMinutes: 0, maxDailyBreaks: 0 },
    },
  };
  assert.deepEqual(getEmployeeBreakSettings(membershipNoBreakEmp, "alpha"), { allowanceMinutes: 0, maxDailyBreaks: 0 });
});

test("getEmployeeBreakSettings handles custom break allowances", () => {
  const customEmp: Employee = {
    ...employee,
    breakAllowanceMinutes: 45,
    maxDailyBreaks: 2,
  };
  assert.deepEqual(getEmployeeBreakSettings(customEmp), { allowanceMinutes: 45, maxDailyBreaks: 2 });
});

