import test from "node:test";
import assert from "node:assert/strict";
import { resolveScheduledCompany } from "../src/lib/shift-company.ts";
import type { Company, Employee } from "../src/lib/types.ts";

// A VA working three clients in one day, the case that puts punches on the
// wrong company when nobody switches by hand.
const employee = {
  id: "emp",
  name: "Naomi",
  status: "active",
  inviteStatus: "accepted",
  shiftTimezone: "UTC",
  companyMemberships: {
    acme: {
      companyId: "acme",
      status: "active",
      shiftStartTime: "03:00",
      shiftEndTime: "07:00",
      shiftTimezone: "UTC",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    },
    savykids: {
      companyId: "savykids",
      status: "active",
      shiftStartTime: "09:00",
      shiftEndTime: "13:00",
      shiftTimezone: "UTC",
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    },
  },
} as unknown as Employee;

const companies = [
  { id: "acme", name: "Acme" },
  { id: "savykids", name: "Savykids" },
] as Company[];

const at = (time: string, date = "2026-09-23") => new Date(`${date}T${time}:00Z`);

test("the client whose shift is running is the one to punch against", () => {
  assert.equal(resolveScheduledCompany(employee, companies, at("04:00"))?.companyId, "acme");
  assert.equal(resolveScheduledCompany(employee, companies, at("10:30"))?.companyId, "savykids");
});

test("a shift about to start already claims the employee, so an early punch lands right", () => {
  const upcoming = resolveScheduledCompany(employee, companies, at("08:45"));
  assert.equal(upcoming?.companyId, "savykids");
  assert.equal(upcoming?.running, false);
});

test("outside every shift and its lead-in, no client is claimed", () => {
  assert.equal(resolveScheduledCompany(employee, companies, at("15:00")), null);
  assert.equal(resolveScheduledCompany(employee, companies, at("08:00")), null);
});

test("a day the employee does not work that client is skipped", () => {
  const weekdayOnly = {
    ...employee,
    companyMemberships: {
      ...employee.companyMemberships,
      savykids: {
        ...(employee.companyMemberships as Record<string, Record<string, unknown>>).savykids,
        workingDays: [1, 2, 3, 4, 5],
      },
    },
  } as unknown as Employee;
  // 2026-09-26 is a Saturday.
  assert.equal(resolveScheduledCompany(weekdayOnly, companies, at("10:30", "2026-09-26")), null);
  assert.equal(
    resolveScheduledCompany(weekdayOnly, companies, at("10:30", "2026-09-25"))?.companyId,
    "savykids",
  );
});

test("an overnight shift still belongs to the client after midnight", () => {
  const nightShift = {
    ...employee,
    companyMemberships: {
      acme: {
        companyId: "acme",
        status: "active",
        shiftStartTime: "22:00",
        shiftEndTime: "06:00",
        shiftTimezone: "UTC",
        workingDays: [1, 2, 3, 4, 5],
      },
    },
  } as unknown as Employee;
  // Thursday 01:00 belongs to the shift that started Wednesday night.
  assert.equal(
    resolveScheduledCompany(nightShift, companies, at("01:00", "2026-09-24"))?.companyId,
    "acme",
  );
  // Sunday 01:00 follows a Saturday night the employee does not work.
  assert.equal(resolveScheduledCompany(nightShift, companies, at("01:00", "2026-09-27")), null);
});

test("multiple slots for one client resolve to that client", () => {
  const multi = {
    ...employee,
    companyMemberships: {
      acme: {
        companyId: "acme",
        status: "active",
        isMultipleShift: true,
        shiftTimezone: "UTC",
        workingDays: [0, 1, 2, 3, 4, 5, 6],
        shifts: [
          { startTime: "03:00", endTime: "07:00", workingDays: [0, 1, 2, 3, 4, 5, 6] },
          { startTime: "18:00", endTime: "20:00", workingDays: [0, 1, 2, 3, 4, 5, 6] },
        ],
      },
    },
  } as unknown as Employee;
  assert.equal(resolveScheduledCompany(multi, companies, at("18:30"))?.companyId, "acme");
  assert.equal(resolveScheduledCompany(multi, companies, at("03:30"))?.companyId, "acme");
});
