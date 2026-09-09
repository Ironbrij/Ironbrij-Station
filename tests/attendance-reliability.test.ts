import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase/firestore";
import { getActiveWorkingSession, getLiveAttendanceStatus, computeRegularWorkedMsForDay, getEmployeeShiftWindow } from "../src/lib/attendance.ts";
import { calculateAttendanceSession } from "../src/lib/attendance-calculation.ts";
import { planManualClockIn } from "../src/lib/manual-clock-in.ts";
import { buildLateRecords, lateRecordInPeriod } from "../src/lib/late-records.ts";
import { appHealthResponse, noStoreResponse } from "../src/lib/app-response.ts";
import { attendanceNow, calibrateAttendanceClock } from "../src/lib/attendance-clock.ts";
import type { Employee, Punch } from "../src/lib/types.ts";
const emp = { id: "rose", authUid: "rose-login", name: "Rose", companyId: "default", companyIds: ["default"],
  shiftTimezone: "Asia/Manila", shiftStartTime: "05:00", shiftEndTime: "14:00", workingDays: [1,2,3,4,5],
  status: "active", inviteStatus: "accepted" } as Employee;
const at = (time: string, date = "2026-09-09") => new Date(`${date}T${time}:00+08:00`);
function punch(type: Punch["type"], time: string, extra: Partial<Punch> = {}): Punch {
  return { id: `${type}-${time}`, employeeId: emp.id, companyId: "default", type, timestamp: Timestamp.fromDate(at(time)), source: "app", ...extra };
}
test("Rose's same-time automatic out can be corrected without deleting the audit record", () => {
  const entries = [punch("in", "05:32"), punch("out", "05:32", { isAuto: true, autoReason: "switch_company" })];
  assert.equal(getActiveWorkingSession(entries, emp, at("06:00")).activeCompanyId, null);
  const plan = planManualClockIn(emp, entries, at("05:32"), at("06:00"), true);
  assert.equal(plan.existing?.id, entries[0].id);
  assert.deepEqual(plan.voided.map((p) => p.id), [entries[1].id]);
  const corrected = entries.map((p) => plan.voided.includes(p) ? { ...p, voidedAt: at("06:00").toISOString() } : p);
  assert.equal(getLiveAttendanceStatus(emp, corrected, at("06:00")).isPunchedIn, true);
  assert.equal(getActiveWorkingSession(corrected, emp, at("06:00")).activeCompanyId, "default");
});
test("manual corrections cannot void actual manual stops, future punches, or past-day automatic outs", () => {
  assert.throws(() => planManualClockIn(emp, [punch("in", "05:00"), punch("out", "06:00")], at("05:00"), at("07:00"), true), /manual or policy/);
  assert.throws(() => planManualClockIn(emp, [], at("07:00"), at("06:00"), true), /future/);
  const historical = [punch("in", "05:00"), punch("out", "14:00", { isAuto: true, autoReason: "forgot_punch_out" })];
  assert.equal(planManualClockIn(emp, historical, at("05:00"), at("06:00", "2026-09-10"), true).voided.length, 0);
});
test("multiple completed shifts retain all regular working hours", () => {
  const multi = { ...emp, isMultipleShift: true, shifts: [
    {startTime: "06:00", endTime: "10:00", workingDays: [3]},
    {startTime: "12:00", endTime: "16:00", workingDays: [3]},
  ] };
  const entries = [punch("in", "06:00"), punch("out", "10:00"), punch("in", "12:00"), punch("out", "16:00")];
  assert.equal(computeRegularWorkedMsForDay(multi, entries, at("16:00"), at("16:00")) / 3600000, 8);
});
test("break time pauses session totals and makes up regular time without false overtime", () => {
  const worker = { ...emp, shiftStartTime: "06:00", shiftEndTime: "14:00", requiredWorkMinutes: 480 };
  const entries = [punch("in", "06:00"), punch("lunch_start", "10:00"), punch("lunch_end", "10:30"), punch("out", "14:30")];
  const paused = calculateAttendanceSession({ employee: worker, punchIn: at("06:00"), now: at("10:15"), punches: entries });
  assert.equal(paused.actualWorkMinutes, 240);
  assert.equal(paused.normalWorkMinutes, 240);
  const done = calculateAttendanceSession({ employee: worker, punchIn: at("06:00"), punchOut: at("14:30"), punches: entries });
  assert.equal(done.actualWorkMinutes, 480);
  assert.equal(done.normalWorkMinutes, 480);
  assert.equal(done.overtimeMinutes, 0);
  assert.equal(computeRegularWorkedMsForDay(worker, entries, at("14:30"), at("14:30")) / 60000, 480);
});
test("early-work overtime counts only elapsed work, not future minutes", () => {
  const result = calculateAttendanceSession({ employee: { ...emp, shiftStartTime: "06:00" }, punchIn: at("05:00"), now: at("05:30") });
  assert.equal(result.earlyStartMinutes, 60);
  assert.equal(result.actualWorkMinutes, 30);
  assert.equal(result.overtimeMinutes, 30);
});
test("late logs include a late second shift and retain historical records for date filters", () => {
  const multi = { ...emp, isMultipleShift: true, shifts: [
    {startTime: "06:00", endTime: "10:00", workingDays: [3]},
    {startTime: "12:00", endTime: "16:00", workingDays: [3]},
  ] };
  const entries = [punch("in", "06:00"), punch("out", "10:00"), punch("in", "12:15")];
  const records = buildLateRecords([multi], entries, [], [], at("13:00"));
  assert.equal(records.length, 1);
  assert.equal(records[0].minutesLate, 15);
  assert.equal(records[0].punch?.id, "in-12:15");
  assert.equal(lateRecordInPeriod(records[0], "today", at("06:00", "2026-09-10")), false);
  assert.equal(lateRecordInPeriod(records[0], "week", at("06:00", "2026-09-10")), true);
  const beforeSecond = getLiveAttendanceStatus(multi, entries.slice(0, 2), at("12:10"));
  assert.equal(beforeSecond.isMissingLate, true);
});
test("clock-in after midnight attaches to the overnight shift that is already running", () => {
  const worker = { ...emp, shiftStartTime: "22:00", shiftEndTime: "06:00" };
  const shift = getEmployeeShiftWindow(worker, at("01:00", "2026-09-10"));
  assert.equal(shift.dateKey, "2026-09-09");
  assert.equal(shift.start.getTime(), at("22:00").getTime());
});
test("HTML and health responses cannot be cached and preserve response metadata", async () => {
  const response = noStoreResponse(new Response("private", { status: 401, headers: { "Set-Cookie": "session=kept", "Content-Type": "text/html" } }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), "session=kept");
  const health = appHealthResponse("release-1", 123);
  assert.deepEqual(await health.json(), { version: "release-1", serverTime: 123 });
});
test("server clock calibration ignores a wrong or changed device wall clock", () => {
  calibrateAttendanceClock(at("06:00").getTime());
  const original = Date.now;
  try {
    Date.now = () => at("01:00").getTime();
    assert.ok(Math.abs(attendanceNow().getTime() - at("06:00").getTime()) < 1000);
  } finally { Date.now = original; }
});
