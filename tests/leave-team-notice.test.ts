import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLeaveTeamNoticeText,
  parseNoticeEmails,
  resolveLeaveNoticeRecipients,
} from "../src/lib/leave-team-notice.ts";
import type { Department, Employee, LeaveRequest } from "../src/lib/types.ts";

function employee(id: string, deptId: string, extra: Partial<Employee> = {}): Employee {
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    deptId,
    status: "active",
    inviteStatus: "accepted",
    ...extra,
  };
}

const departments: Department[] = [
  { id: "dev", name: "Development", leaveNotifyDepartmentIds: ["creative"] },
  { id: "creative", name: "Creative Team", leaveNotifyDepartmentIds: ["creative"] },
  { id: "ops", name: "Operations" },
];

const employees = [
  employee("bibek", "dev"),
  employee("ann", "creative"),
  employee("rose", "creative"),
  employee("gone", "creative", { status: "inactive" }),
  employee("invited", "creative", { inviteStatus: "pending" }),
  employee("louis", "ops"),
  employee("mv", "ops"),
];

const leave = (extra: Partial<LeaveRequest> = {}): LeaveRequest =>
  ({
    id: "l1",
    employeeId: "bibek",
    dateFrom: "2026-10-05",
    dateTo: "2026-10-05",
    reason: "private",
    status: "approved",
    ...extra,
  }) as LeaveRequest;

test("a department's chosen team is emailed, only active signed-up members", () => {
  assert.deepEqual(resolveLeaveNoticeRecipients(employees[0], departments, employees), [
    "ann@example.com",
    "rose@example.com",
  ]);
});

test("the person on leave is never emailed about their own leave", () => {
  assert.deepEqual(resolveLeaveNoticeRecipients(employees[1], departments, employees), [
    "rose@example.com",
  ]);
});

test("a department nobody has set up tells its own team", () => {
  assert.deepEqual(resolveLeaveNoticeRecipients(employees[5], departments, employees), [
    "mv@example.com",
  ]);
});

test("a department an admin turned every team off for tells nobody", () => {
  const silenced = departments.map((d) =>
    d.id === "ops" ? { ...d, leaveNotifyDepartmentIds: [] } : d,
  );
  assert.deepEqual(resolveLeaveNoticeRecipients(employees[5], silenced, employees), []);
});

test("extra emails are added, cleaned and de-duplicated", () => {
  const withExtras = departments.map((d) =>
    d.id === "dev"
      ? { ...d, leaveNotifyEmails: ["Lead@Example.com", "ann@example.com", "bad"] }
      : d,
  );
  assert.deepEqual(resolveLeaveNoticeRecipients(employees[0], withExtras, employees), [
    "ann@example.com",
    "lead@example.com",
    "rose@example.com",
  ]);
  assert.deepEqual(parseNoticeEmails("a@x.com; B@x.com, nope  a@x.com"), ["a@x.com", "b@x.com"]);
});

test("the team email says who is away and when, not 'approved' or the reason", () => {
  const notice = buildLeaveTeamNoticeText({
    event: "approved",
    employeeName: "Bibek",
    teamName: "Development",
    companyName: "Ironbrij",
    leave: leave(),
  });
  assert.equal(notice.subject, "Bibek will be on leave on Mon, 5 Oct 2026");
  assert.equal(notice.headline, "Bibek (Development) will be on leave on Mon, 5 Oct 2026.");
  assert.doesNotMatch(notice.text, /approv|private/i);
});

test("ranges, half days and picked dates read naturally", () => {
  const range = buildLeaveTeamNoticeText({
    event: "approved",
    employeeName: "Bibek",
    companyName: "Ironbrij",
    leave: leave({ dateTo: "2026-10-07" }),
  });
  assert.equal(range.subject, "Bibek will be on leave from Mon, 5 Oct 2026 to Wed, 7 Oct 2026");

  const picked = buildLeaveTeamNoticeText({
    event: "approved",
    employeeName: "Bibek",
    companyName: "Ironbrij",
    leave: leave({
      dates: [
        { date: "2026-10-09", leaveType: "half_day", halfDayPeriod: "second_half" },
        { date: "2026-10-05" },
      ],
    }),
  });
  assert.equal(
    picked.subject,
    "Bibek will be on leave on Mon, 5 Oct 2026, Fri, 9 Oct 2026 (second half of the day)",
  );
});

test("a revoked leave tells the team they are working after all", () => {
  const notice = buildLeaveTeamNoticeText({
    event: "revoked",
    employeeName: "Bibek",
    companyName: "Ironbrij",
    leave: leave({ status: "rejected" }),
  });
  assert.equal(notice.subject, "Update: Bibek will no longer be on leave on Mon, 5 Oct 2026");
});
