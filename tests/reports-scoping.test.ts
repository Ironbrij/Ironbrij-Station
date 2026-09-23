import test from "node:test";
import assert from "node:assert/strict";
import { filterEmployeeList } from "../src/lib/employee-list.ts";
import {
  getEmployeeCompanyIds,
  getEmployeeLeavesForCompany,
  getEmployeePunchesForCompany,
} from "../src/lib/company-context.ts";
import {
  COMPANY_ID,
  type Company,
  type Department,
  type Employee,
  type LeaveRequest,
  type Punch,
} from "../src/lib/types.ts";

// The shape the app writes today: assignments live in companyMemberships, and
// the reports page used to read only the legacy companyId / companyIds fields.
const membershipEmployee = {
  id: "emp-1",
  authUid: "uid-1",
  name: "Naomi Galliano",
  status: "active",
  inviteStatus: "accepted",
  companyMemberships: {
    acme: {
      companyId: "acme",
      role: "employee",
      status: "active",
      departmentId: "dept-a",
      shiftStartTime: "12:00",
      shiftEndTime: "16:00",
      shiftTimezone: "UTC",
    },
  },
} as unknown as Employee;

// A profile still carrying the "ironbrij" alias of the main company.
const legacyEmployee = {
  id: "emp-2",
  name: "Older Profile",
  status: "active",
  inviteStatus: "accepted",
  companyId: "ironbrij",
  deptId: "dept-a",
} as unknown as Employee;

const companies = [
  { id: "acme", name: "Acme" },
  { id: COMPANY_ID, name: "Main", isMain: true },
] as Company[];
const departments = [{ id: "dept-a", name: "Support" }] as Department[];
const employees = [membershipEmployee, legacyEmployee];

const select = (companyFilter: string, departmentId = "", search = "") =>
  filterEmployeeList(employees, companies, departments, companyFilter, departmentId, search).map(
    (employee) => employee.name,
  );

test("a report scoped to a client lists its membership-only employees", () => {
  assert.deepEqual(select("acme"), ["Naomi Galliano"]);
});

test("a company alias resolves to the same client as its canonical id", () => {
  assert.deepEqual(select(COMPANY_ID), ["Older Profile"]);
  assert.deepEqual(select("ironbrij"), ["Older Profile"]);
});

test("an employee is not claimed by the main company just for lacking companyId", () => {
  assert.equal(select(COMPANY_ID).includes("Naomi Galliano"), false);
});

test("the department filter reads the assignment on the company membership", () => {
  assert.deepEqual(select("acme", "dept-a"), ["Naomi Galliano"]);
  assert.deepEqual(select("acme", "dept-z"), []);
});

test("report punches follow the company name and exclude voided corrections", () => {
  const punches = [
    { id: "in", employeeId: "uid-1", companyId: "acme", type: "in", timestamp: new Date() },
    { id: "named", employeeId: "uid-1", companyName: "Acme", type: "out", timestamp: new Date() },
    {
      id: "voided",
      employeeId: "uid-1",
      companyId: "acme",
      type: "out",
      timestamp: new Date(),
      voidedAt: "2026-09-01T00:00:00Z",
    },
    { id: "other", employeeId: "uid-1", companyId: "beta", type: "in", timestamp: new Date() },
  ] as unknown as Punch[];
  assert.deepEqual(
    getEmployeePunchesForCompany(punches, membershipEmployee, "acme", "Acme").map((p) => p.id),
    ["in", "named"],
  );
});

test("report leaves reach membership-only employees", () => {
  const leaves = [
    { id: "lv", employeeId: "uid-1", companyId: "acme", status: "approved" },
    { id: "other", employeeId: "uid-9", companyId: "acme", status: "approved" },
  ] as unknown as LeaveRequest[];
  assert.deepEqual(
    getEmployeeLeavesForCompany(leaves, membershipEmployee, "acme").map((l) => l.id),
    ["lv"],
  );
});

test("a punch written from reports lands on the employee's own client", () => {
  // Mirrors resolveWriteCompanyId in admin.reports.tsx for the "all companies" view.
  const resolved = getEmployeeCompanyIds(membershipEmployee)[0] || COMPANY_ID;
  assert.equal(resolved, "acme");
});
