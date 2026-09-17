import test from "node:test";
import assert from "node:assert/strict";
import { findDailyReport, reportDocumentId } from "../src/lib/daily-reports.ts";
import type { DailyReport, Employee } from "../src/lib/types.ts";

const employee = {
  id: "employee-record",
  authUid: "login-user",
} as Employee;

function report(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    id: reportDocumentId("login-user", "2026-09-17", "sod", "client-a"),
    userId: "login-user",
    employeeId: "employee-record",
    companyId: "client-a",
    userName: "VA",
    userEmail: "va@example.com",
    reportDate: "2026-09-17",
    reportType: "sod",
    answers: [],
    timezone: "Asia/Manila",
    submittedLate: false,
    status: "submitted",
    ...overrides,
  } as DailyReport;
}

test("finds a company-scoped report without relying on its document ID", () => {
  const submitted = report();
  assert.equal(
    findDailyReport([submitted], {
      employee,
      date: "2026-09-17",
      type: "sod",
      companyId: "client-a",
    })?.id,
    submitted.id,
  );
});

test("matches legacy employee IDs but does not sync another company or report type", () => {
  const submitted = report({ userId: "old-login", employeeId: employee.id });
  assert.equal(
    findDailyReport([submitted], {
      employee,
      date: "2026-09-17",
      type: "sod",
      companyId: "client-a",
    })?.id,
    submitted.id,
  );
  assert.equal(
    findDailyReport([submitted], {
      employee,
      date: "2026-09-17",
      type: "eod",
      companyId: "client-a",
    }),
    undefined,
  );
  assert.equal(
    findDailyReport([submitted], {
      employee,
      date: "2026-09-17",
      type: "sod",
      companyId: "client-b",
    }),
    undefined,
  );
});
