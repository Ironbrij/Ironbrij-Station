import test from "node:test";
import assert from "node:assert/strict";
import {
  filterEmployeeList,
  GENERAL_DEPARTMENT_FILTER,
  getEmployeeListDepartmentLabel,
} from "../src/lib/employee-list.ts";
import type { Company, Department, Employee } from "../src/lib/types.ts";
const companies = [
  { id: "alpha", name: "Alpha" },
  { id: "beta", name: "Beta" },
] as Company[];
const departments = [
  { id: "sales", name: "Sales", companyId: "alpha" },
  { id: "general-doc", name: "General", companyId: "alpha" },
] as Department[];
const employee = (id: string, overrides: Partial<Employee> = {}): Employee => ({
  id,
  name: id,
  email: id + "@example.com",
  status: "active",
  inviteStatus: "accepted",
  companyId: "alpha",
  ...overrides,
});
const list = (people: Employee[], company = "alpha", department = "", query = "") =>
  filterEmployeeList(people, companies, departments, company, department, query).map(
    (item) => item.id,
  );

test("all departments includes employees with missing, blank, and General departments", () => {
  const people = [
    employee("missing"),
    employee("blank", { deptId: "" }),
    employee("general", { deptId: "general-doc" }),
  ];
  assert.deepEqual(list(people), ["blank", "general", "missing"]);
  assert.deepEqual(list(people, "alpha", GENERAL_DEPARTMENT_FILTER), [
    "blank",
    "general",
    "missing",
  ]);
  for (const person of people)
    assert.equal(getEmployeeListDepartmentLabel(person, "alpha", departments), "General");
});
test("legacy general and whitespace department values are included in General", () => {
  const people = [employee("legacy", { deptId: "general" }), employee("blank", { deptId: "  " })];
  assert.deepEqual(list(people, "alpha", GENERAL_DEPARTMENT_FILTER), ["blank", "legacy"]);
});
test("company-specific empty department overrides an old top-level department", () => {
  const person = employee("member", {
    deptId: "sales",
    companyMemberships: { alpha: { companyId: "alpha", departmentId: "" } },
  });
  assert.deepEqual(list([person], "alpha", GENERAL_DEPARTMENT_FILTER), ["member"]);
  assert.deepEqual(list([person], "alpha", "sales"), []);
  assert.equal(getEmployeeListDepartmentLabel(person, "alpha", departments), "General");
});
test("membership-only employees and company aliases are visible without a department", () => {
  const member = employee("member", {
    companyId: undefined,
    companyMemberships: { beta: { companyId: "beta", departmentId: "" } },
  });
  assert.deepEqual(list([member], "beta"), ["member"]);
  assert.deepEqual(list([member], "alpha"), []);
  assert.deepEqual(list([employee("legacy", { companyId: "ironbrij" })], "default"), ["legacy"]);
});
test("all companies checks each company department and displays both assignments", () => {
  const member = employee("member", {
    companyMemberships: {
      alpha: { companyId: "alpha", departmentId: "sales" },
      beta: { companyId: "beta", departmentId: "" },
    },
  });
  assert.deepEqual(list([member], "all", GENERAL_DEPARTMENT_FILTER), ["member"]);
  assert.deepEqual(list([member], "all", "sales"), ["member"]);
  assert.equal(getEmployeeListDepartmentLabel(member, "all", departments), "Sales, General");
});
test("department and search filters still exclude unrelated employees without mutating records", () => {
  const people = [
    employee("general"),
    employee("sales", { deptId: "sales" }),
    employee("other", { companyId: "beta" }),
  ];
  const before = JSON.stringify(people);
  assert.deepEqual(list(people, "alpha", GENERAL_DEPARTMENT_FILTER, "general"), ["general"]);
  assert.deepEqual(list(people, "alpha", "sales"), ["sales"]);
  assert.equal(JSON.stringify(people), before);
});
