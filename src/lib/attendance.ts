import type { Employee, LeaveRequest, Punch } from "./types";

export const ATTENDANCE_TIMEZONES = [
  { value: "Australia/Sydney", label: "Sydney, Australia", short: "Sydney" },
  { value: "Asia/Kathmandu", label: "Kathmandu, Nepal", short: "Nepal" },
  { value: "Asia/Manila", label: "Manila, Philippines", short: "Philippines" },
] as const;

export const DEFAULT_SHIFT_TIMEZONE = "Australia/Sydney";
export const DEFAULT_LOCAL_TIMEZONE = "Asia/Kathmandu";

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function isValidTimezone(timezone?: string): boolean {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export function getEmployeeTimezone(employee?: Pick<Employee, "timezone" | "country">): string {
  if (isValidTimezone(employee?.timezone)) return employee!.timezone!;
  if (employee?.country === "AU") return "Australia/Sydney";
  if (employee?.country === "PH") return "Asia/Manila";
  return DEFAULT_LOCAL_TIMEZONE;
}

export function getShiftTimezone(
  employee?: Pick<Employee, "shiftTimezone" | "timezone" | "country">,
): string {
  if (isValidTimezone(employee?.shiftTimezone)) return employee!.shiftTimezone!;
  return getEmployeeTimezone(employee);
}

export function isEmployeeOnApprovedLeave(
  employee: Pick<Employee, "id" | "authUid">,
  leaves: LeaveRequest[],
  dateKey: string,
): boolean {
  return leaves.some(
    (leave) =>
      leave.status === "approved" &&
      (leave.employeeId === employee.id || leave.employeeId === employee.authUid) &&
      leave.dateFrom <= dateKey &&
      leave.dateTo >= dateKey,
  );
}
export function getZonedParts(value: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second"),
  };
}

export function zonedDateKey(value: Date, timezone: string): string {
  const parts = getZonedParts(value, timezone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function zonedDateTimeToDate(dateKey: string, time: string, timezone: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour || 0, minute || 0, 0);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = getZonedParts(new Date(guess), timezone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = target - represented;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

export function getShiftWindow(
  dateKey: string,
  startTime = "09:00",
  endTime = "17:00",
  timezone = DEFAULT_SHIFT_TIMEZONE,
) {
  const start = zonedDateTimeToDate(dateKey, startTime, timezone);
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);
  const crossesMidnight =
    (endHour || 0) * 60 + (endMinute || 0) <= (startHour || 0) * 60 + (startMinute || 0);
  const endDateKey = crossesMidnight ? addCalendarDays(dateKey, 1) : dateKey;
  const end = zonedDateTimeToDate(endDateKey, endTime, timezone);
  return { start, end, crossesMidnight, dateKey, timezone };
}

export function getEmployeeShiftWindow(employee: Employee, instant = new Date()) {
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(instant, shiftTimezone);
  return getShiftWindow(
    dateKey,
    employee.shiftStartTime || "09:00",
    employee.shiftEndTime || "17:00",
    shiftTimezone,
  );
}

export function getShiftCompletion(employee: Employee, punchedInAt: Date) {
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(punchedInAt, shiftTimezone);
  const shift = getShiftWindow(
    dateKey,
    employee.shiftStartTime || "09:00",
    employee.shiftEndTime || "17:00",
    shiftTimezone,
  );
  const shiftDurationMs = shift.end.getTime() - shift.start.getTime();
  const punchOutAt = new Date(punchedInAt.getTime() + shiftDurationMs);

  return { shift, shiftDurationMs, punchOutAt };
}

export function getShiftTimeout(employee: Employee, punchedInAt: Date, now = new Date()) {
  const completion = getShiftCompletion(employee, punchedInAt);

  if (now.getTime() < completion.punchOutAt.getTime()) return null;

  return completion;
}

export function computeRegularWorkedMsForDay(
  employee: Employee,
  punches: Punch[],
  day = new Date(),
  now = new Date(),
) {
  const timezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(day, timezone);
  const dayStart = zonedDateTimeToDate(dateKey, "00:00", timezone).getTime();
  const dayEnd = zonedDateTimeToDate(addCalendarDays(dateKey, 1), "00:00", timezone).getTime();
  const sorted = [...punches]
    .filter((punch) => punch.timestamp)
    .sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
  let openIn: number | null = null;
  let workedMs = 0;

  function addInterval(start: number, end: number) {
    workedMs += Math.max(0, Math.min(end, dayEnd) - Math.max(start, dayStart));
  }

  for (const punch of sorted) {
    const timestamp = punch.timestamp.toMillis();
    if (punch.type === "in") {
      openIn = timestamp;
    } else if (punch.type === "out" && openIn !== null) {
      addInterval(openIn, timestamp);
      openIn = null;
    }
  }

  if (openIn !== null) {
    const completion = getShiftCompletion(employee, new Date(openIn));
    addInterval(openIn, Math.min(now.getTime(), completion.punchOutAt.getTime()));
  }

  return workedMs;
}

export function formatInTimezone(
  value: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...options,
  }).format(value);
}

export function getShiftConversions(employee: Employee, instant = new Date()) {
  const window = getEmployeeShiftWindow(employee, instant);
  return ATTENDANCE_TIMEZONES.map((zone) => ({
    ...zone,
    start: formatInTimezone(window.start, zone.value),
    end: formatInTimezone(window.end, zone.value),
  }));
}

export function computeEmployeeLateness(punchValue: Date, employee: Employee, graceMinutes = 1) {
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(punchValue, shiftTimezone);
  const window = getShiftWindow(
    dateKey,
    employee.shiftStartTime || "09:00",
    employee.shiftEndTime || "17:00",
    shiftTimezone,
  );
  const differenceSeconds = Math.floor((punchValue.getTime() - window.start.getTime()) / 1000);
  const graceSeconds = Math.max(0, graceMinutes) * 60;
  return {
    isLate: differenceSeconds > graceSeconds,
    isEarly: differenceSeconds < 0,
    minutes: Math.max(0, Math.floor(differenceSeconds / 60)),
    seconds: Math.max(0, differenceSeconds),
    dateKey,
    scheduledAt: window.start,
    shiftTimezone,
  };
}

export function getFirstRegularPunchInForShift(
  employee: Employee,
  punches: Punch[],
  instant = new Date(),
): Punch | undefined {
  const shiftTimezone = getShiftTimezone(employee);
  const targetDate = zonedDateKey(instant, shiftTimezone);
  return punches
    .filter(
      (punch) =>
        punch.type === "in" &&
        punch.timestamp &&
        zonedDateKey(punch.timestamp.toDate(), shiftTimezone) === targetDate,
    )
    .sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis())[0];
}

export function getLiveAttendanceStatus(
  employee: Employee,
  punches: Punch[],
  now = new Date(),
  graceMinutes = 1,
  workingDays?: number[],
  holidays: string[] = [],
) {
  const sorted = [...punches]
    .filter((punch) => punch.timestamp)
    .sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
  const latest = sorted.at(-1);
  const isPunchedIn = latest?.type === "in" || latest?.type === "extra_in";
  const firstIn = getFirstRegularPunchInForShift(employee, sorted, now);
  const shift = getEmployeeShiftWindow(employee, now);
  const [shiftYear, shiftMonth, shiftDay] = shift.dateKey.split("-").map(Number);
  const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
  const isScheduledDay =
    (!workingDays || workingDays.includes(shiftWeekday)) && !holidays.includes(shift.dateKey);
  const lateness =
    firstIn && isScheduledDay
      ? computeEmployeeLateness(firstIn.timestamp.toDate(), employee, graceMinutes)
      : null;
  const missingMinutes = Math.max(0, Math.floor((now.getTime() - shift.start.getTime()) / 60000));
  const isMissingLate =
    isScheduledDay &&
    !firstIn &&
    now.getTime() > shift.start.getTime() + Math.max(0, graceMinutes) * 60000 &&
    now <= shift.end;
  return {
    latest,
    firstIn,
    isPunchedIn,
    isLate: lateness?.isLate ?? isMissingLate,
    minutesLate: lateness?.minutes ?? (isMissingLate ? missingMinutes : 0),
    isMissingLate,
    isScheduledDay,
    shift,
  };
}
