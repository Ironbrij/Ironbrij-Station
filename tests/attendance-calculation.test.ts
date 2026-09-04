import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAttendanceSession,
  isPunchOutReminderDue,
} from "../src/lib/attendance-calculation.ts";
import {
  computeRegularWorkedMsForDay,
  getEffectiveEmployeeWorkingDays,
  getEmployeeShiftWindow,
  getLiveAttendanceStatus,
  getShiftTimeout,
  zonedDateTimeToDate,
} from "../src/lib/attendance.ts";
import type { Company, Employee } from "../src/lib/types.ts";

const timezone = "Australia/Sydney";
const company: Company = {
  id: "alpha",
  name: "Alpha",
  defaultShiftHours: 8,
  holidays: [],
  workingDays: [1, 2, 3, 4, 5],
  punchOutGraceMinutes: 20,
  punchOutReminderMinutes: 20,
};

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: "employee-1",
    name: "Employee One",
    email: "employee@example.com",
    status: "active",
    inviteStatus: "accepted",
    companyId: "alpha",
    companyIds: ["alpha"],
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
    shiftTimezone: timezone,
    requiredWorkMinutes: 480,
    ...overrides,
  };
}

function at(time: string): Date {
  return zonedDateTimeToDate("2026-08-10", time, timezone);
}

test("normal eight-hour session resolves to eight normal hours", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("17:00"),
  });
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.status, "complete");
});

test("custom six-hour requirement is respected", () => {
  const result = calculateAttendanceSession({
    employee: employee({
      requiredWorkMinutes: 360,
      shiftEndTime: "15:00",
    }),
    company,
    punchIn: at("09:00"),
    punchOut: at("15:00"),
  });
  assert.equal(result.requiredWorkMinutes, 360);
  assert.equal(result.normalWorkMinutes, 360);
});

test("custom seven-hour-thirty-minute requirement stays precise", () => {
  const result = calculateAttendanceSession({
    employee: employee({ requiredWorkMinutes: 450, shiftEndTime: "16:30" }),
    company,
    punchIn: at("09:00"),
    punchOut: at("16:30"),
  });
  assert.equal(result.requiredWorkMinutes, 450);
  assert.equal(result.normalWorkMinutes, 450);
});

test("punch-out inside grace normalizes to the shift end", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("17:15"),
  });
  assert.equal(result.actualWorkMinutes, 495);
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.graceApplied, true);
});

test("punch-out shortly before shift end also keeps normal scheduled hours", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("16:50"),
  });
  assert.equal(result.actualWorkMinutes, 470);
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 0);
  assert.equal(result.graceApplied, true);
});

test("only time beyond the grace boundary becomes overtime", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: at("17:21"),
  });
  assert.equal(result.normalWorkMinutes, 480);
  assert.equal(result.overtimeMinutes, 21);
  assert.equal(result.attendanceDate, "2026-08-10");
});

test("working on off-shift day or holiday counts all time as overtime", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("10:00"),
    punchOut: at("14:00"),
    isOffShiftDay: true,
  });
  assert.equal(result.normalWorkMinutes, 0);
  assert.equal(result.overtimeMinutes, 240);
  assert.equal(result.totalEligibleMinutes, 240);
  assert.equal(result.status, "complete");
});

test("an open session after shift end is missing punch-out without a fake end", () => {
  const result = calculateAttendanceSession({
    employee: employee(),
    company,
    punchIn: at("09:00"),
    punchOut: null,
    now: at("18:00"),
  });
  assert.equal(result.status, "missing_punch_out");
  assert.equal(result.missingPunchOut, true);
  assert.equal(result.overtimeMinutes, 60);
});

test("reminder opens exactly twenty minutes before shift end", () => {
  assert.equal(
    isPunchOutReminderDue({ employee: employee(), punchIn: at("09:00"), now: at("16:39") }),
    false,
  );
  assert.equal(
    isPunchOutReminderDue({ employee: employee(), punchIn: at("09:00"), now: at("16:40") }),
    true,
  );
});

test("getEffectiveEmployeeWorkingDays correctly aggregates working days across multiple shifts", () => {
  const multiEmp = employee({
    isMultipleShift: true,
    shifts: [
      { startTime: "04:00", endTime: "07:00", workingDays: [0, 1] }, // Sun, Mon
      { startTime: "12:00", endTime: "15:00", workingDays: [4] }, // Thu
    ],
  });

  const effectiveDays = getEffectiveEmployeeWorkingDays(multiEmp, [1, 2, 3, 4, 5]);
  assert.deepEqual(effectiveDays, [0, 1, 4]); // Sunday (0), Monday (1), Thursday (4)
});

test("getEmployeeShiftWindow selects the active shift for that day and slot", () => {
  const multiEmp = employee({
    isMultipleShift: true,
    shifts: [
      { startTime: "04:00", endTime: "07:00", workingDays: [0, 1] }, // Sun, Mon: 04:00 - 07:00
      { startTime: "12:00", endTime: "15:00", workingDays: [1, 4] }, // Mon, Thu: 12:00 - 15:00
    ],
  });

  // Monday morning (03:50 AM early arrival for 04:00 AM shift)
  const mondayEarly = zonedDateTimeToDate("2026-08-10", "03:50", timezone);
  const mondayWindow1 = getEmployeeShiftWindow(multiEmp, mondayEarly);
  assert.equal(
    mondayWindow1.start.toISOString(),
    zonedDateTimeToDate("2026-08-10", "04:00", timezone).toISOString(),
  );
  assert.equal(
    mondayWindow1.end.toISOString(),
    zonedDateTimeToDate("2026-08-10", "07:00", timezone).toISOString(),
  );

  // Monday midday (11:55 AM early arrival for 12:00 PM shift)
  const mondayMidday = zonedDateTimeToDate("2026-08-10", "11:55", timezone);
  const mondayWindow2 = getEmployeeShiftWindow(multiEmp, mondayMidday);
  assert.equal(
    mondayWindow2.start.toISOString(),
    zonedDateTimeToDate("2026-08-10", "12:00", timezone).toISOString(),
  );
  assert.equal(
    mondayWindow2.end.toISOString(),
    zonedDateTimeToDate("2026-08-10", "15:00", timezone).toISOString(),
  );

  // Thursday (12:00 - 15:00)
  const thursdayDate = zonedDateTimeToDate("2026-08-13", "09:00", timezone);
  const thursdayWindow = getEmployeeShiftWindow(multiEmp, thursdayDate);
  assert.equal(
    thursdayWindow.start.toISOString(),
    zonedDateTimeToDate("2026-08-13", "12:00", timezone).toISOString(),
  );
  assert.equal(
    thursdayWindow.end.toISOString(),
    zonedDateTimeToDate("2026-08-13", "15:00", timezone).toISOString(),
  );
});

test("getShiftTimeout triggers auto punch out promptly when now reaches shift end", () => {
  const emp = employee();
  const punchInAt = at("09:00");

  // Before shift end (e.g. 16:55) -> null
  assert.equal(getShiftTimeout(emp, punchInAt, at("16:55")), null);

  // At shift end or after (e.g. 17:00 or 17:05) -> returns timeout completion
  const timeout = getShiftTimeout(emp, punchInAt, at("17:05"));
  assert.ok(timeout);
  assert.equal(timeout?.shift.end.toISOString(), at("17:00").toISOString());
  assert.equal(timeout?.punchOutAt.toISOString(), at("17:00").toISOString());
});

test("early clock-in tracks early start minutes and regular shift duration", () => {
  const earlyEmp = employee({
    shiftStartTime: "06:00",
    shiftEndTime: "14:00",
  });

  // Clocked in at 05:00 (1 hour early)
  // At 05:30 (before official shift starts)
  const preShiftSession = calculateAttendanceSession({
    employee: earlyEmp,
    company,
    punchIn: at("05:00"),
    punchOut: null,
    now: at("05:30"),
  });
  assert.equal(preShiftSession.earlyStartMinutes, 60);
  assert.equal(preShiftSession.normalWorkMinutes, 0);
  assert.equal(preShiftSession.missingPunchOut, false);
  assert.equal(preShiftSession.status, "in_progress");

  // Clocked out at 14:00 (official shift completion)
  const completedSession = calculateAttendanceSession({
    employee: earlyEmp,
    company,
    punchIn: at("05:00"),
    punchOut: at("14:00"),
  });
  assert.equal(completedSession.earlyStartMinutes, 60);
  assert.equal(completedSession.normalWorkMinutes, 480);
  assert.equal(completedSession.overtimeMinutes, 60);
  assert.equal(completedSession.status, "complete");
});

test("post-shift overtime sessions count 100% of duration as overtime", () => {
  const emp = employee({
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
  });

  // Session 1: Started overtime at 18:00 and finished at 18:07 (7 minutes)
  const sevenMinSession = calculateAttendanceSession({
    employee: emp,
    company,
    punchIn: at("18:00"),
    punchOut: at("18:07"),
  });
  assert.equal(sevenMinSession.normalWorkMinutes, 0);
  assert.equal(sevenMinSession.overtimeMinutes, 7);
  assert.equal(sevenMinSession.status, "complete");

  // Session 2: Started overtime at 18:15 and finished at 18:16 (1 minute)
  const oneMinSession = calculateAttendanceSession({
    employee: emp,
    company,
    punchIn: at("18:15"),
    punchOut: at("18:16"),
  });
  assert.equal(oneMinSession.normalWorkMinutes, 0);
  assert.equal(oneMinSession.overtimeMinutes, 1);
  assert.equal(oneMinSession.status, "complete");
});

test("lunch break punches pause shift timer and exclude lunch duration from regular worked hours", () => {
  const emp = employee({
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
  });

  const punches: Punch[] = [
    {
      id: "p1",
      employeeId: emp.id,
      type: "in",
      timestamp: { seconds: at("09:00").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
    },
    {
      id: "p2",
      employeeId: emp.id,
      type: "lunch_start",
      timestamp: { seconds: at("12:00").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
    },
    {
      id: "p3",
      employeeId: emp.id,
      type: "lunch_end",
      timestamp: { seconds: at("12:30").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
    },
  ];

  // At 12:15 (while currently on lunch break): 3 hours (180 mins) worked from 09:00 to 12:00
  const duringLunchMs = computeRegularWorkedMsForDay(emp, punches, at("12:15"), at("12:15"));
  assert.equal(duringLunchMs, 3 * 60 * 60 * 1000);

  // At 13:30 (after returning from lunch): 3 hours (09:00-12:00) + 1 hour (12:30-13:30) = 4 hours (240 mins)
  const afterLunchMs = computeRegularWorkedMsForDay(emp, punches, at("13:30"), at("13:30"));
  assert.equal(afterLunchMs, 4 * 60 * 60 * 1000);
});

test("multi-shift employee progresses to Shift 2 after Shift 1 without being forced into overtime", () => {
  const multiEmp = employee({
    isMultipleShift: true,
    shifts: [
      { startTime: "08:00", endTime: "12:00", workingDays: [1, 2, 3, 4, 5] },
      { startTime: "14:00", endTime: "18:00", workingDays: [1, 2, 3, 4, 5] },
    ],
  });

  const punchesShift1Completed: Punch[] = [
    {
      id: "p1",
      employeeId: multiEmp.id,
      companyId: "alpha",
      type: "in",
      timestamp: { seconds: at("08:00").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
      scheduledShiftStart: at("08:00").toISOString(),
      scheduledShiftEnd: at("12:00").toISOString(),
    },
    {
      id: "p2",
      employeeId: multiEmp.id,
      companyId: "alpha",
      type: "out",
      timestamp: { seconds: at("12:00").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
      scheduledShiftStart: at("08:00").toISOString(),
      scheduledShiftEnd: at("12:00").toISOString(),
    },
  ];

  // At 13:00 (after Shift 1 ended at 12:00, but before Shift 2 starts at 14:00):
  const shiftWindow = getEmployeeShiftWindow(multiEmp, at("13:00"), punchesShift1Completed);
  // Shift window must be Shift 2 (14:00 - 18:00)
  assert.equal(shiftWindow.start.getTime(), at("14:00").getTime());
  assert.equal(shiftWindow.end.getTime(), at("18:00").getTime());

  const status = getLiveAttendanceStatus(multiEmp, punchesShift1Completed, at("13:00"), 5);
  assert.equal(status.completedRegularShiftsCount, 1);
  assert.equal(status.totalShiftsToday, 2);
  assert.equal(status.remainingShiftsCount, 1);
  assert.equal(status.hasCompletedAllShiftsToday, false);
  assert.equal(status.isPastShiftEnd, false);
  assert.equal(status.isPunchedIn, false);

  // When Shift 2 completes as well:
  const allShiftsCompletedPunches: Punch[] = [
    ...punchesShift1Completed,
    {
      id: "p3",
      employeeId: multiEmp.id,
      companyId: "alpha",
      type: "in",
      timestamp: { seconds: at("14:00").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
      scheduledShiftStart: at("14:00").toISOString(),
      scheduledShiftEnd: at("18:00").toISOString(),
    },
    {
      id: "p4",
      employeeId: multiEmp.id,
      companyId: "alpha",
      type: "out",
      timestamp: { seconds: at("18:00").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
      scheduledShiftStart: at("14:00").toISOString(),
      scheduledShiftEnd: at("18:00").toISOString(),
    },
  ];

  // At 18:30 (after Shift 2 has finished):
  const endOfDayStatus = getLiveAttendanceStatus(multiEmp, allShiftsCompletedPunches, at("18:30"), 5);
  assert.equal(endOfDayStatus.completedRegularShiftsCount, 2);
  assert.equal(endOfDayStatus.totalShiftsToday, 2);
  assert.equal(endOfDayStatus.remainingShiftsCount, 0);
  assert.equal(endOfDayStatus.hasCompletedAllShiftsToday, true);
  assert.equal(endOfDayStatus.isPastShiftEnd, true);
});

test("switching to second client company with zero punches today does not trigger overtime even if nominal shift end passed", () => {
  // Client 2 with morning shift hours 08:00 - 12:00
  const client2Emp = employee({
    companyId: "beta",
    shiftStartTime: "08:00",
    shiftEndTime: "12:00",
  });

  // At 13:00, VA switches to Client 2. 0 punches have occurred today for Client 2.
  const status = getLiveAttendanceStatus(client2Emp, [], at("13:00"), 5);
  assert.equal(status.completedRegularShiftsCount, 0);
  assert.equal(status.hasCompletedAllShiftsToday, false);
  assert.equal(status.isPastShiftEnd, false);
  assert.equal(status.isPunchedIn, false);
});

test("active regular work session past scheduled shift end stays clocked in (does not kick user to overtime)", () => {
  const emp = employee({
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
  });

  const punches: Punch[] = [
    {
      id: "p1",
      employeeId: emp.id,
      companyId: "alpha",
      type: "in",
      timestamp: { seconds: at("09:00").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
    },
  ];

  // At 17:30 (30 mins past shift end), employee is still working
  const status = getLiveAttendanceStatus(emp, punches, at("17:30"), 5);
  assert.equal(status.isPunchedIn, true);
  assert.equal(status.isPastShiftEnd, false);
});

