import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { zonedDateTimeToDate } from "../src/lib/attendance.ts";
import { clockBallState } from "../src/lib/clock-ball.ts";
import type { Employee, Punch } from "../src/lib/types.ts";

const emp = {
  id: "va",
  name: "VA",
  companyId: "alpha",
  companyIds: ["alpha"],
  shiftStartTime: "06:00",
  shiftEndTime: "14:00",
  shiftTimezone: "Australia/Sydney",
} as Employee;
const at = (time: string) => zonedDateTimeToDate("2026-08-10", time, "Australia/Sydney");
const ms = (time: string) => at(time).getTime();
const punch = (type: Punch["type"], time: string): Punch => ({
  id: type + time,
  employeeId: emp.id,
  companyId: "alpha",
  type,
  timestamp: { seconds: ms(time) / 1000, nanoseconds: 0 } as Punch["timestamp"],
});

// The extension's own file, loaded the way Chrome loads it.
const ball = vm.createContext({});
vm.runInContext(
  readFileSync(new URL("../extension/savytime-clock-ball/shared.js", import.meta.url), "utf8"),
  ball,
);
const view = (shift: object, time: string) => ball.clockBallView(shift, ms(time));

test("a running shift counts from clock-in and ends at the shift end", () => {
  const state = clockBallState([punch("in", "06:00")], emp, at("08:00"));
  assert.equal(state.active, true);
  assert.equal(state.countFrom, ms("06:00"));
  assert.equal(state.endsAt, ms("14:00"));
  assert.equal(state.pausedAt, 0);
  assert.equal(view(state, "08:14").time, "2:14:00");
  assert.equal(view(state, "14:00"), null);
});

test("a finished break is not counted and pushes the end out", () => {
  const punches = [
    punch("in", "06:00"),
    punch("lunch_start", "09:00"),
    punch("lunch_end", "09:30"),
  ];
  const state = clockBallState(punches, emp, at("10:00"));
  assert.equal(state.countFrom, ms("06:30"));
  assert.equal(state.endsAt, ms("14:30"));
  assert.equal(view(state, "10:00").time, "3:30:00");
  assert.ok(view(state, "14:20"));
});

test("a break holds the count still", () => {
  const punches = [punch("in", "06:00"), punch("lunch_start", "09:00")];
  const state = clockBallState(punches, emp, at("09:20"));
  assert.equal(state.pausedAt, ms("09:00"));
  assert.equal(view(state, "09:20").time, "3:00:00");
  assert.equal(view(state, "09:20").paused, true);
  // Twenty minutes of break so far: the shift runs twenty minutes later.
  assert.ok(view(state, "14:10"));
});

test("stopping work hides the ball", () => {
  const state = clockBallState([punch("in", "06:00"), punch("out", "11:00")], emp, at("11:05"));
  assert.equal(state.active, false);
  assert.equal(view(state, "11:05"), null);
});
