import test from "node:test";
import assert from "node:assert/strict";
import { describeDstSchedules, findDstChange, newDstResponse } from "../src/lib/dst-email.ts";
import type { ClientDstPlan } from "../src/lib/dst-email.ts";
import { chosenClockUpdate, linesToApply } from "../src/lib/shift-clock.ts";
import type { Company, Employee } from "../src/lib/types.ts";

const sydney = { id: "iron", name: "Ironbrij", state: "NSW", clientEmails: ["x@y.com"] } as Company;
const change = findDstChange("Australia/Sydney", new Date("2026-10-01T00:00:00Z"))!;

// A Nepal VA on 8 AM to 2 PM Sydney time, saved on Sydney's clock.
const bibek = {
  id: "bibek",
  name: "Bibek Parajuli",
  email: "bibek@example.com",
  status: "active",
  inviteStatus: "accepted",
  country: "NP",
  timezone: "Asia/Kathmandu",
  companyId: "iron",
  companyIds: ["iron"],
  shiftTimezone: "Australia/Sydney",
  shiftStartTime: "08:00",
  shiftEndTime: "14:00",
  companyMemberships: {
    iron: {
      companyId: "iron",
      shiftTimezone: "Australia/Sydney",
      shiftStartTime: "08:00",
      shiftEndTime: "14:00",
      departmentId: "d1",
    },
  },
} as unknown as Employee;

const responseFor = (employee: Employee) => {
  const plan = {
    company: sydney,
    to: ["x@y.com"],
    timezone: "Australia/Sydney",
    change,
    schedules: describeDstSchedules(employee, "iron", change),
    unscheduled: [],
  } as ClientDstPlan;
  return newDstResponse(plan);
};

test("keeping NPT re-saves the shift on Nepal's clock at the same hours", () => {
  const response = responseFor(bibek);
  const lines = linesToApply(response.lines, "keep").get("bibek")!;
  const update = chosenClockUpdate(bibek, "iron", lines, change.timezone, "keep")!;
  assert.deepEqual(update.companyMemberships!.iron, {
    companyId: "iron",
    departmentId: "d1",
    shiftTimezone: "Asia/Kathmandu",
    shiftStartTime: "03:45",
    shiftEndTime: "09:45",
  });
  // Primary company: the profile's own times mirror it.
  assert.equal(update.shiftTimezone, "Asia/Kathmandu");
  assert.equal(update.shiftStartTime, "03:45");

  // Same hours before the change, and from then on it keeps NPT by itself.
  const after = { ...bibek, ...update } as Employee;
  const [line] = describeDstSchedules(after, "iron", change);
  assert.equal(line.clientBefore, "8:00 AM – 2:00 PM");
  assert.equal(line.automatic, "keep");
  assert.equal(line.clientKeep, "9:00 AM – 3:00 PM");
});

test("following Sydney re-saves a Nepal-time shift on Sydney's clock", () => {
  const onNepal = {
    ...bibek,
    shiftTimezone: "Asia/Kathmandu",
    shiftStartTime: "03:45",
    shiftEndTime: "09:45",
    companyMemberships: {
      iron: {
        companyId: "iron",
        shiftTimezone: "Asia/Kathmandu",
        shiftStartTime: "03:45",
        shiftEndTime: "09:45",
      },
    },
  } as unknown as Employee;
  const response = responseFor(onNepal);
  assert.equal(linesToApply(response.lines, "keep").size, 0);
  const lines = linesToApply(response.lines, "follow").get("bibek")!;
  const update = chosenClockUpdate(onNepal, "iron", lines, change.timezone, "follow")!;
  assert.equal(update.companyMemberships!.iron.shiftTimezone, "Australia/Sydney");
  assert.equal(update.companyMemberships!.iron.shiftStartTime, "08:00");
  assert.equal(update.companyMemberships!.iron.shiftEndTime, "14:00");
  const [line] = describeDstSchedules({ ...onNepal, ...update } as Employee, "iron", change);
  assert.equal(line.automatic, "follow");
  assert.equal(line.vaAfter, "2:45 AM – 8:45 AM");
});

test("a VA with several shifts for the client has every shift moved to the chosen clock", () => {
  const multi = {
    ...bibek,
    companyId: "other",
    companyIds: ["other", "iron"],
    companyMemberships: {
      iron: {
        companyId: "iron",
        isMultipleShift: true,
        shiftTimezone: "Australia/Sydney",
        shifts: [
          { startTime: "08:00", endTime: "10:00", workingDays: [1] },
          { startTime: "13:00", endTime: "15:00", workingDays: [1] },
        ],
      },
    },
  } as unknown as Employee;
  const response = responseFor(multi);
  const lines = linesToApply(response.lines, "keep").get("bibek")!;
  const update = chosenClockUpdate(multi, "iron", lines, change.timezone, "keep")!;
  assert.deepEqual(update.companyMemberships!.iron.shifts, [
    { startTime: "03:45", endTime: "05:45", workingDays: [1] },
    { startTime: "08:45", endTime: "10:45", workingDays: [1] },
  ]);
  assert.equal(update.companyMemberships!.iron.shiftTimezone, "Asia/Kathmandu");
  // Not the primary company: the profile's own times are left alone.
  assert.equal(update.shiftTimezone, undefined);
});

test("nothing is changed when the shift already gives the chosen hours", () => {
  const response = responseFor(bibek);
  const lines = response.lines;
  assert.equal(chosenClockUpdate(bibek, "iron", lines, change.timezone, "follow"), null);
});
