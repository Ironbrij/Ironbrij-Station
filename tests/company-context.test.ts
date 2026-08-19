import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateTotalShiftMinutes,
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getPunchCompanyId,
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
