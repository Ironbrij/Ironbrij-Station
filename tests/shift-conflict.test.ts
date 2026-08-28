import test from "node:test";
import assert from "node:assert/strict";
import {
  checkTwoShiftsConflict,
  findShiftConflicts,
  type ShiftDefinition,
} from "../src/lib/shift-conflict.ts";

test("two non-overlapping shifts on same days produce 0 conflicts", () => {
  const s1: ShiftDefinition = {
    name: "Morning Shift",
    startTime: "06:00",
    endTime: "14:00",
    workingDays: [1, 2, 3, 4, 5],
  };
  const s2: ShiftDefinition = {
    name: "Evening Shift",
    startTime: "14:00",
    endTime: "22:00",
    workingDays: [1, 2, 3, 4, 5],
  };
  const conflicts = checkTwoShiftsConflict(s1, s2);
  assert.equal(conflicts.length, 0);
});

test("overlapping shifts on shared working days produce conflicts with exact duration", () => {
  const s1: ShiftDefinition = {
    name: "Morning Shift",
    startTime: "09:00",
    endTime: "17:00",
    workingDays: [1, 2, 3], // Mon, Tue, Wed
  };
  const s2: ShiftDefinition = {
    name: "Afternoon Shift",
    startTime: "16:00",
    endTime: "20:00",
    workingDays: [3, 4, 5], // Wed, Thu, Fri
  };
  const conflicts = checkTwoShiftsConflict(s1, s2);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].dayName, "Wednesday");
  assert.equal(conflicts[0].overlapMinutes, 60);
});

test("shifts with identical times on different working days produce 0 conflicts", () => {
  const s1: ShiftDefinition = {
    name: "Weekday Shift",
    startTime: "09:00",
    endTime: "17:00",
    workingDays: [1, 2, 3, 4, 5],
  };
  const s2: ShiftDefinition = {
    name: "Weekend Shift",
    startTime: "09:00",
    endTime: "17:00",
    workingDays: [0, 6], // Sun, Sat
  };
  const conflicts = checkTwoShiftsConflict(s1, s2);
  assert.equal(conflicts.length, 0);
});

test("cross-company overlapping shifts are flagged by findShiftConflicts", () => {
  const shifts: ShiftDefinition[] = [
    {
      name: "Ironbrij Shift",
      startTime: "09:00",
      endTime: "17:00",
      workingDays: [1, 2, 3, 4, 5],
      companyName: "Ironbrij",
    },
    {
      name: "Savykids Shift",
      startTime: "14:00",
      endTime: "18:00",
      workingDays: [1, 2, 3, 4, 5],
      companyName: "Savykids",
    },
  ];
  const conflicts = findShiftConflicts(shifts);
  assert.equal(conflicts.length, 5); // Mon-Fri (5 days)
  assert.equal(conflicts[0].overlapMinutes, 180); // 14:00 to 17:00 = 3 hours
  assert.equal(conflicts[0].company1Name, "Ironbrij");
  assert.equal(conflicts[0].company2Name, "Savykids");
});
