import test from "node:test";
import assert from "node:assert/strict";
import {
  describeShiftInterval,
  findShiftIntervalForPunch,
  getPunchShiftClient,
  getShiftIntervals,
} from "../src/lib/shift-clients.ts";
import type { Employee, Punch } from "../src/lib/types.ts";

// Three slots in one day, each worked for a different client.
const employee = {
  id: "emp",
  name: "Naomi",
  status: "active",
  inviteStatus: "accepted",
  shiftTimezone: "UTC",
  isMultipleShift: true,
  workingDays: [0, 1, 2, 3, 4, 5, 6],
  shifts: [
    { startTime: "03:00", endTime: "07:00", clientName: "Ironbrij" },
    { startTime: "09:00", endTime: "13:00", clientName: "Savykids" },
    { startTime: "18:00", endTime: "20:00", clientName: "Northwind" },
  ],
} as unknown as Employee;

const DATE = "2026-09-23";
const at = (time: string, date = DATE) => new Date(`${date}T${time}:00Z`);
const punch = (time: string, extra: Record<string, unknown> = {}) =>
  ({
    id: `p-${time}`,
    employeeId: "emp",
    type: "in",
    timestamp: at(time),
    shiftTimezone: "UTC",
    ...extra,
  }) as unknown as Punch;

test("a punch is labelled with the client of the slot it was worked in", () => {
  assert.equal(getPunchShiftClient(employee, punch("02:56")), "Ironbrij");
  assert.equal(getPunchShiftClient(employee, punch("08:56")), "Savykids");
  assert.equal(getPunchShiftClient(employee, punch("18:30")), "Northwind");
});

test("the schedule stored on a punch names its slot exactly", () => {
  // Clocked in early for the 09:00 slot: the clock time alone would say Ironbrij.
  const early = punch("08:00", { scheduledShiftStart: at("09:00").toISOString() });
  assert.equal(getPunchShiftClient(employee, early), "Savykids");
});

test("a slot without a client name reports none rather than guessing", () => {
  const unnamed = {
    ...employee,
    shifts: [{ startTime: "03:00", endTime: "07:00" }],
  } as unknown as Employee;
  assert.equal(getPunchShiftClient(unnamed, punch("03:30")), "");
});

test("a single-shift employee uses the client named on their schedule", () => {
  const single = {
    ...employee,
    isMultipleShift: false,
    shifts: undefined,
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
    shiftClientName: "Ironbrij",
  } as unknown as Employee;
  assert.equal(getShiftIntervals(single).length, 1);
  assert.equal(getPunchShiftClient(single, punch("09:05")), "Ironbrij");
});

test("an overnight slot keeps its client after midnight", () => {
  const nightShift = {
    ...employee,
    shifts: [
      { startTime: "22:00", endTime: "06:00", clientName: "Ironbrij" },
      { startTime: "09:00", endTime: "13:00", clientName: "Savykids" },
    ],
  } as unknown as Employee;
  assert.equal(getPunchShiftClient(nightShift, punch("01:30")), "Ironbrij");
  assert.equal(getPunchShiftClient(nightShift, punch("22:10")), "Ironbrij");
});

test("a punch outside every configured slot matches none", () => {
  assert.equal(findShiftIntervalForPunch(employee, punch("15:00")), undefined);
  assert.equal(getPunchShiftClient(employee, punch("15:00")), "");
});

test("a slot reads as its range plus its client, or just the range", () => {
  assert.equal(
    describeShiftInterval({ startTime: "09:00", endTime: "13:00", clientName: "Ironbrij" }),
    "09:00 – 13:00 · Ironbrij",
  );
  assert.equal(describeShiftInterval({ startTime: "09:00", endTime: "13:00" }), "09:00 – 13:00");
});
