import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateAttendanceSession,
  isPunchOutReminderDue,
} from "../src/lib/attendance-calculation.ts";
import {
  computeEmployeeLateness,
  computeRegularWorkedMsForDay,
  getEffectiveEmployeeWorkingDays,
  getEmployeeShiftWindow,
  getFirstRegularPunchInForShift,
  getLiveAttendanceStatus,
  getActiveWorkingSession,
  getShiftTimeout,
  zonedDateTimeToDate,
} from "../src/lib/attendance.ts";
import { getEmployeeForCompany } from "../src/lib/company-context.ts";
import type { Company, Employee, Punch } from "../src/lib/types.ts";

const timezone = "Australia/Sydney";

test("Saturday remains an off day for an explicit Sun-Fri schedule, and off-day work is overtime", () => {
  const emp = employee({ workingDays: [0, 1, 2, 3, 4, 5] });
  const saturday = new Date("2026-09-05T00:00:00Z");
  const status = getLiveAttendanceStatus(emp, [], saturday, 5, [1, 2, 3, 4, 5, 6]);
  assert.equal(status.isScheduledDay, false);
  assert.equal(status.isMissingLate, false);
  const session = calculateAttendanceSession({ employee: emp, company, punchIn: saturday, punchOut: new Date("2026-09-05T01:00:00Z"), isOffShiftDay: !status.isScheduledDay });
  assert.equal(session.normalWorkMinutes, 0);
  assert.equal(session.overtimeMinutes, 60);
});

test("Saturday-only schedule is respected independently of company defaults", () => {
  const emp = employee({ workingDays: [6] });
  assert.equal(getLiveAttendanceStatus(emp, [], new Date("2026-09-05T00:00:00Z"), 5, [1, 2, 3, 4, 5]).isScheduledDay, true);
  assert.equal(getLiveAttendanceStatus(emp, [], new Date("2026-09-04T00:00:00Z"), 5, [1, 2, 3, 4, 5]).isScheduledDay, false);
});
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

test("getFirstRegularPunchInForShift identifies regular 'in' and 'extra_in' punches", () => {
  const emp = employee({
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
  });

  const extraInPunch: Punch = {
    id: "punch-ot-1",
    employeeId: emp.id,
    companyId: "alpha",
    type: "extra_in",
    timestamp: { seconds: at("09:02").getTime() / 1000, nanoseconds: 0 } as any,
    source: "app",
  };

  const firstPunch = getFirstRegularPunchInForShift(emp, [extraInPunch], at("10:00"));
  assert.ok(firstPunch);
  assert.equal(firstPunch?.type, "extra_in");
  assert.equal(firstPunch?.id, "punch-ot-1");
});

test("getLiveAttendanceStatus ensures an actively punched-in employee is never marked as isMissingLate", () => {
  const emp = employee({
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
  });

  // Employee clocked in with extra_in at 09:02
  const punches: Punch[] = [
    {
      id: "p-ot",
      employeeId: emp.id,
      companyId: "alpha",
      type: "extra_in",
      timestamp: { seconds: at("09:02").getTime() / 1000, nanoseconds: 0 } as any,
      source: "app",
    },
  ];

  // At 10:00 (1 hour after shift start):
  const status = getLiveAttendanceStatus(emp, punches, at("10:00"), 5);
  assert.equal(status.isPunchedIn, true);
  assert.equal(status.isMissingLate, false);
});

test("getEffectiveEmployeeWorkingDays correctly coerces string workingDays from Firestore", () => {
  const emp = employee({
    workingDays: ["1", "5"] as any,
  });
  const days = getEffectiveEmployeeWorkingDays(emp);
  assert.deepEqual(days, [1, 5]);

  const multiEmp = employee({
    isMultipleShift: true,
    shifts: [
      { startTime: "08:00", endTime: "12:00", workingDays: ["1", "5"] as any },
    ],
  });
  const multiDays = getEffectiveEmployeeWorkingDays(multiEmp);
  assert.deepEqual(multiDays, [1, 5]);
});

test("getLiveAttendanceStatus correctly identifies scheduled day for Monday & Friday employee", () => {
  const emp = employee({
    workingDays: ["1", "5"] as any, // Monday & Friday only
    shiftStartTime: "08:00",
    shiftEndTime: "17:00",
    shiftTimezone: "Australia/Sydney",
  });

  // 2026-09-04 is a Friday (day 5)
  const fridayInstant = new Date("2026-09-04T00:00:00.000Z"); // 10:00 AM Sydney on Friday
  const fridayStatus = getLiveAttendanceStatus(emp, [], fridayInstant, 5);
  assert.equal(fridayStatus.isScheduledDay, true);

  // 2026-09-01 is a Tuesday (day 2)
  const tuesdayInstant = new Date("2026-09-01T00:00:00.000Z"); // 10:00 AM Sydney on Tuesday
  const tuesdayStatus = getLiveAttendanceStatus(emp, [], tuesdayInstant, 5);
  assert.equal(tuesdayStatus.isScheduledDay, false);
});

test("computeEmployeeLateness marks on-time arrivals as NOT naturally late", () => {
  const emp = employee({
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
    shiftTimezone: "Australia/Sydney",
  });

  // Punch in at 08:58 Sydney (2 mins early)
  const punchTime = new Date("2026-09-03T22:58:00.000Z");
  const late = computeEmployeeLateness(punchTime, emp, 5);
  assert.equal(late.naturallyLate, false);
  assert.equal(late.isEarly, true);
  assert.equal(late.rawMinutes, 0);
});

test("computeEmployeeLateness marks 20 min late punch as naturally late with 20 minutes", () => {
  const emp = employee({
    shiftStartTime: "09:00",
    shiftEndTime: "17:00",
    shiftTimezone: "Australia/Sydney",
  });

  // Punch in at 09:20 Sydney (20 mins late)
  const punchTime = new Date("2026-09-03T23:20:00.000Z");
  const late = computeEmployeeLateness(punchTime, emp, 5);
  assert.equal(late.naturallyLate, true);
  assert.equal(late.rawMinutes, 20);
});

test("getActiveWorkingSession matches company alias default and ironbrij with normalizeCompanyId", () => {
  const emp = employee({
    id: "andre1",
    companyId: "ironbrij",
    shiftStartTime: "08:00",
    shiftEndTime: "17:00",
    shiftTimezone: "Australia/Sydney",
  });

  const punch: Punch = {
    id: "p-andre",
    employeeId: "andre1",
    companyId: "default",
    type: "in",
    timestamp: { seconds: new Date("2026-09-04T00:00:00.000Z").getTime() / 1000, nanoseconds: 0 } as any,
    date: "2026-09-04",
    attendanceDate: "2026-09-04",
  };

  const companies: Company[] = [
    {
      id: "default",
      name: "ironbrij",
      workingDays: [1, 2, 3, 4, 5],
      lateGraceMinutes: 1,
    } as any,
  ];

  const session = getActiveWorkingSession([punch], emp, new Date("2026-09-04T02:00:00.000Z"), companies);
  assert.equal(session.activeCompanyId, "default");
  assert.equal(session.activeCompanyName, "ironbrij");
  assert.equal(session.sessionType, "in");
  assert.equal(session.status?.isPunchedIn, true);
});

test("getEmployeeForCompany falls back to base employee workingDays if membership.workingDays is empty array", () => {
  const emp = employee({
    id: "jonathan1",
    workingDays: [1, 2, 3, 4, 5],
    companyMemberships: {
      client1: {
        companyId: "client1",
        workingDays: [],
      } as any,
    },
  });

  const resolved = getEmployeeForCompany(emp, "client1");
  assert.deepEqual(resolved.workingDays, [1, 2, 3, 4, 5]);
});






function shiftPunch(
  emp: Employee,
  type: Punch["type"],
  time: Date,
  overrides: Partial<Punch> = {},
): Punch {
  return {
    id: type + "-" + time.toISOString(),
    employeeId: emp.id,
    companyId: emp.companyId,
    type,
    timestamp: { seconds: time.getTime() / 1000, nanoseconds: 0 } as Punch["timestamp"],
    source: "app",
    ...overrides,
  };
}

for (const [breakMinutes, expectedEnd] of [
  [0, "14:00"],
  [30, "14:30"],
  [80, "15:20"],
] as const) {
  test("6am shift extends by " + breakMinutes + " break minutes with eight hours of work", () => {
    const emp = employee({ shiftStartTime: "06:00", shiftEndTime: "14:00" });
    const punches = [shiftPunch(emp, "in", at("06:00"))];
    if (breakMinutes)
      punches.push(
        shiftPunch(emp, "lunch_start", at("10:00")),
        shiftPunch(emp, "lunch_end", new Date(at("10:00").getTime() + breakMinutes * 60_000)),
      );
    const end = at(expectedEnd);
    const beforeEnd = new Date(end.getTime() - 1);
    assert.equal(getShiftTimeout(emp, at("06:00"), beforeEnd, 0, punches), null);
    const timeout = getShiftTimeout(emp, at("06:00"), end, 0, punches);
    assert.ok(timeout);
    assert.equal(timeout.shift.start.getTime(), at("06:00").getTime());
    assert.equal(timeout.punchOutAt.getTime(), end.getTime());
    assert.equal(timeout.shift.end.getTime(), at("14:00").getTime());
    assert.equal(timeout.shift.effectiveEnd.getTime(), end.getTime());
    assert.equal(timeout.shiftDurationMs, 8 * 3_600_000);
    assert.equal(computeRegularWorkedMsForDay(emp, punches, end, end), 8 * 3_600_000);
    const active = getLiveAttendanceStatus(emp, punches, beforeEnd);
    assert.equal(active.isPunchedIn, true);
    assert.equal(active.isShiftCompleted, false);
    assert.equal(active.shift.end.getTime(), at("14:00").getTime());
    assert.equal(active.shift.effectiveEnd.getTime(), end.getTime());
    const done = getLiveAttendanceStatus(
      emp,
      [...punches, shiftPunch(emp, "out", end, { isAuto: true })],
      end,
    );
    assert.equal(done.isShiftCompleted, true);
    assert.equal(done.isPunchedIn, false);
    // Delayed reconciliation must persist the deadline, not the polling time.
    assert.equal(
      getShiftTimeout(emp, at("06:00"), at("16:00"), 0, punches)?.punchOutAt.getTime(),
      end.getTime(),
    );
  });
}

test("multiple breaks accumulate, including a break during the extension", () => {
  const emp = employee({ shiftStartTime: "06:00", shiftEndTime: "14:00" });
  const punches = [
    shiftPunch(emp, "in", at("06:00")),
    shiftPunch(emp, "lunch_start", at("10:00")),
    shiftPunch(emp, "lunch_end", at("10:30")),
    shiftPunch(emp, "lunch_start", at("14:10")),
    shiftPunch(emp, "lunch_end", at("15:00")),
  ].reverse();
  assert.equal(getShiftTimeout(emp, at("06:00"), at("15:19"), 0, punches), null);
  assert.equal(
    getShiftTimeout(emp, at("06:00"), at("15:20"), 0, punches)?.punchOutAt.getTime(),
    at("15:20").getTime(),
  );
  assert.equal(computeRegularWorkedMsForDay(emp, punches, at("15:20"), at("15:20")), 8 * 3_600_000);
});

test("ongoing lunch keeps work paused past the original end and ignores future punches", () => {
  const emp = employee({ shiftStartTime: "06:00", shiftEndTime: "14:00" });
  const punches = [
    shiftPunch(emp, "in", at("06:00")),
    shiftPunch(emp, "lunch_start", at("13:30")),
    shiftPunch(emp, "lunch_end", at("15:00")),
  ];
  assert.equal(getShiftTimeout(emp, at("06:00"), at("14:30"), 0, punches), null);
  const status = getLiveAttendanceStatus(emp, punches, at("14:30"));
  assert.equal(status.isOnLunch, true);
  assert.equal(status.isShiftCompleted, false);
  assert.equal(status.shift.end.getTime(), at("14:00").getTime());
  assert.equal(status.shift.effectiveEnd.getTime(), at("15:00").getTime());
  assert.equal(
    computeRegularWorkedMsForDay(emp, punches, at("14:30"), at("14:30")),
    7.5 * 3_600_000,
  );
  assert.equal(getShiftTimeout(emp, at("06:00"), at("15:29"), 0, punches), null);
  assert.equal(
    getShiftTimeout(emp, at("06:00"), at("15:30"), 0, punches)?.punchOutAt.getTime(),
    at("15:30").getTime(),
  );
});

test("breaks do not move shift start for early or late arrivals", () => {
  const emp = employee({ shiftStartTime: "06:00", shiftEndTime: "14:00" });
  for (const start of ["05:30", "06:15"]) {
    const punches = [
      shiftPunch(emp, "in", at(start)),
      shiftPunch(emp, "lunch_start", at("10:00")),
      shiftPunch(emp, "lunch_end", at("10:30")),
    ];
    const timeout = getShiftTimeout(emp, at(start), at("14:30"), 0, punches);
    assert.equal(timeout?.shift.start.getTime(), at("06:00").getTime());
    assert.equal(timeout?.punchOutAt.getTime(), at("14:30").getTime());
  }
});

test("break calculation ignores other employees, companies, days, and orphan or duplicate break punches", () => {
  const emp = employee({ shiftStartTime: "06:00", shiftEndTime: "14:00" });
  const previousDay = (time: string) => zonedDateTimeToDate("2026-08-09", time, timezone);
  const punches = [
    shiftPunch(emp, "in", previousDay("06:00")),
    shiftPunch(emp, "lunch_start", previousDay("10:00")),
    shiftPunch(emp, "lunch_end", previousDay("11:00")),
    shiftPunch(emp, "out", previousDay("15:00")),
    shiftPunch(emp, "in", at("06:00")),
    shiftPunch(emp, "lunch_end", at("08:00")),
    shiftPunch(emp, "lunch_start", at("09:00"), { employeeId: "other" }),
    shiftPunch(emp, "lunch_end", at("09:45"), { employeeId: "other" }),
    shiftPunch(emp, "lunch_start", at("09:00"), { companyId: "beta" }),
    shiftPunch(emp, "lunch_end", at("09:45"), { companyId: "beta" }),
    shiftPunch(emp, "lunch_start", at("10:00")),
    shiftPunch(emp, "lunch_start", at("10:05")),
    shiftPunch(emp, "lunch_end", at("10:30")),
    shiftPunch(emp, "lunch_end", at("10:35")),
  ];
  assert.equal(
    getShiftTimeout(emp, at("06:00"), at("14:30"), 0, punches)?.punchOutAt.getTime(),
    at("14:30").getTime(),
  );
});

test("an extended first shift keeps its original slot and does not extend the second shift", () => {
  const emp = employee({
    isMultipleShift: true,
    shifts: [
      { startTime: "06:00", endTime: "10:00", workingDays: [1] },
      { startTime: "10:30", endTime: "14:30", workingDays: [1] },
    ],
  });
  const punches = [
    shiftPunch(emp, "in", at("06:00")),
    shiftPunch(emp, "lunch_start", at("08:00")),
    shiftPunch(emp, "lunch_end", at("09:00")),
  ];
  const first = getLiveAttendanceStatus(emp, punches, at("10:45"));
  assert.equal(first.shift.start.getTime(), at("06:00").getTime());
  assert.equal(first.shift.end.getTime(), at("10:00").getTime());
  assert.equal(first.shift.effectiveEnd.getTime(), at("11:00").getTime());
  assert.equal(getShiftTimeout(emp, at("06:00"), at("10:45"), 0, punches), null);
  punches.push(
    shiftPunch(emp, "out", at("11:00"), { isAuto: true }),
    shiftPunch(emp, "in", at("11:01")),
  );
  const second = getLiveAttendanceStatus(emp, punches, at("11:05"));
  assert.equal(second.shift.start.getTime(), at("10:30").getTime());
  assert.equal(second.shift.end.getTime(), at("14:30").getTime());
  assert.equal(second.completedRegularShiftsCount, 1);
});

test("breaks spanning midnight extend the original overnight session", () => {
  const emp = employee({ shiftStartTime: "18:00", shiftEndTime: "02:00" });
  const nextDay = (time: string) => zonedDateTimeToDate("2026-08-11", time, timezone);
  const punches = [
    shiftPunch(emp, "in", at("18:00")),
    shiftPunch(emp, "lunch_start", at("23:30")),
    shiftPunch(emp, "lunch_end", nextDay("00:30")),
  ];
  assert.equal(getShiftTimeout(emp, at("18:00"), nextDay("02:30"), 0, punches), null);
  const status = getLiveAttendanceStatus(emp, punches, nextDay("02:30"));
  assert.equal(status.isPunchedIn, true);
  assert.equal(status.shift.end.getTime(), nextDay("02:00").getTime());
  assert.equal(status.shift.effectiveEnd.getTime(), nextDay("03:00").getTime());
  assert.equal(
    getShiftTimeout(emp, at("18:00"), nextDay("03:00"), 0, punches)?.punchOutAt.getTime(),
    nextDay("03:00").getTime(),
  );
});

test("break-adjusted calculations preserve configured schedule and original punch metadata", () => {
  const emp = Object.freeze(employee({ shiftStartTime: "06:00", shiftEndTime: "14:00" }));
  const punches = [
    shiftPunch(emp, "in", at("06:00"), {
      scheduledShiftStart: at("06:00").toISOString(),
      scheduledShiftEnd: at("14:00").toISOString(),
    }),
    shiftPunch(emp, "lunch_start", at("10:00")),
    shiftPunch(emp, "lunch_end", at("10:30")),
  ];
  const original = JSON.stringify({ emp, punches });
  const scheduled = getEmployeeShiftWindow(emp, at("14:30"), punches);
  const live = getLiveAttendanceStatus(emp, punches, at("14:30"));
  const timeout = getShiftTimeout(emp, at("06:00"), at("14:30"), 0, punches);
  for (const shift of [scheduled, live.shift, timeout!.shift]) {
    assert.equal(shift.start.getTime(), at("06:00").getTime());
    assert.equal(shift.end.getTime(), at("14:00").getTime());
    assert.equal(shift.effectiveEnd.getTime(), at("14:30").getTime());
  }
  assert.equal(JSON.stringify({ emp, punches }), original);
  assert.equal(getEmployeeShiftWindow(emp, at("06:00")).end.getTime(), at("14:00").getTime());
});
