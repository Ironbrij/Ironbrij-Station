import {
  COMPANY_ID,
  type Company,
  type CompanyHoliday,
  type Employee,
  type LeaveRequest,
  type Punch,
} from "./types.ts";
import { toDate, toMillis } from "./time.ts";
import { getEmployeeForCompany, getPunchCompanyId } from "./company-context.ts";

export const ATTENDANCE_TIMEZONES = [
  { value: "Australia/Sydney", label: "Sydney, Australia", short: "Sydney" },
  { value: "Asia/Kathmandu", label: "Kathmandu, Nepal", short: "Nepal" },
  { value: "Asia/Manila", label: "Manila, Philippines", short: "Philippines" },
] as const;

export const DEFAULT_SHIFT_TIMEZONE = "Australia/Sydney";
export const DEFAULT_LOCAL_TIMEZONE = "Asia/Manila";
export const MINIMUM_LATE_GRACE_MINUTES = 5;

export function getEffectiveLateGraceMinutes(configuredMinutes?: number): number {
  return Math.max(MINIMUM_LATE_GRACE_MINUTES, configuredMinutes ?? MINIMUM_LATE_GRACE_MINUTES);
}

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
  if (employee?.country === "NP") return "Asia/Kathmandu";
  return DEFAULT_LOCAL_TIMEZONE;
}

export function getShiftTimezone(
  employee?: Pick<Employee, "shiftTimezone" | "timezone" | "country">,
): string {
  if (isValidTimezone(employee?.shiftTimezone)) return employee!.shiftTimezone!;
  return getEmployeeTimezone(employee);
}

export function isEmployeeOnLeaveForDate(
  employee: Pick<Employee, "id" | "authUid">,
  leaves: LeaveRequest[],
  dateKey: string,
): boolean {
  return leaves.some((leave) => {
    if (leave.status !== "approved" || !leaveMatchesEmployee(leave, employee)) return false;
    if (Array.isArray(leave.dates) && leave.dates.length > 0) {
      const match = leave.dates.find((d) => d.date === dateKey);
      return Boolean(match && (!match.leaveType || match.leaveType === "full_day"));
    }
    return (
      (!leave.leaveType || leave.leaveType === "full_day") &&
      leave.dateFrom <= dateKey &&
      leave.dateTo >= dateKey
    );
  });
}

export const isEmployeeOnApprovedLeave = isEmployeeOnLeaveForDate;

function leaveMatchesEmployee(
  leave: LeaveRequest,
  employee: Pick<Employee, "id" | "authUid">,
): boolean {
  return leave.employeeId === employee.id || leave.employeeId === employee.authUid;
}

export function getEmployeeApprovedLeaveForDate(
  employee: Pick<Employee, "id" | "authUid">,
  leaves: LeaveRequest[],
  dateKey: string,
): LeaveRequest | null {
  for (const leave of leaves) {
    if (leave.status !== "approved" || !leaveMatchesEmployee(leave, employee)) continue;
    if (Array.isArray(leave.dates) && leave.dates.length > 0) {
      const match = leave.dates.find((d) => d.date === dateKey);
      if (match) {
        return {
          ...leave,
          dateFrom: match.date,
          dateTo: match.date,
          leaveType: match.leaveType || leave.leaveType || "full_day",
          paymentStatus: match.paymentStatus || leave.paymentStatus || "paid",
          leaveCategory: match.leaveCategory || leave.leaveCategory || "annual",
          halfDayPeriod: match.halfDayPeriod || leave.halfDayPeriod,
          startTime: match.startTime || leave.startTime,
          endTime: match.endTime || leave.endTime,
        };
      }
    } else if (leave.dateFrom <= dateKey && leave.dateTo >= dateKey) {
      return leave;
    }
  }
  return null;
}

export function getEmployeeApprovedLeaveDates(
  employee: Pick<Employee, "id" | "authUid">,
  leaves: LeaveRequest[],
): string[] {
  const dates = new Set<string>();
  for (const leave of leaves) {
    if (leave.status !== "approved" || !leaveMatchesEmployee(leave, employee)) continue;
    if (Array.isArray(leave.dates) && leave.dates.length > 0) {
      for (const d of leave.dates) {
        if (d.date) dates.add(d.date);
      }
    } else {
      let dateKey = leave.dateFrom;
      while (dateKey <= leave.dateTo) {
        dates.add(dateKey);
        dateKey = addCalendarDays(dateKey, 1);
      }
    }
  }
  return [...dates];
}

export function getLeaveLabel(leave: LeaveRequest | null | undefined): string {
  if (!leave?.leaveType || leave.leaveType === "full_day") return "On leave";
  if (leave.leaveType === "half_day")
    return leave.halfDayPeriod === "second_half"
      ? "Half-day leave · second half"
      : "Half-day leave · first half";
  return `On break${leave.startTime && leave.endTime ? ` · ${leave.startTime}–${leave.endTime}` : ""}`;
}

export function getActiveEmployeeLeave(
  employee: Employee,
  leaves: LeaveRequest[],
  instant = new Date(),
): LeaveRequest | null {
  const timezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(instant, timezone);

  for (const leave of leaves) {
    if (leave.status !== "approved" || !leaveMatchesEmployee(leave, employee)) continue;

    let targetLeave: LeaveRequest = leave;
    if (Array.isArray(leave.dates) && leave.dates.length > 0) {
      const match = leave.dates.find((d) => d.date === dateKey);
      if (!match) continue;
      targetLeave = {
        ...leave,
        dateFrom: match.date,
        dateTo: match.date,
        leaveType: match.leaveType || leave.leaveType || "full_day",
        paymentStatus: match.paymentStatus || leave.paymentStatus || "paid",
        leaveCategory: match.leaveCategory || leave.leaveCategory || "annual",
        halfDayPeriod: match.halfDayPeriod || leave.halfDayPeriod,
        startTime: match.startTime || leave.startTime,
        endTime: match.endTime || leave.endTime,
      };
    } else {
      if (leave.dateFrom > dateKey || leave.dateTo < dateKey) continue;
    }

    if (!targetLeave.leaveType || targetLeave.leaveType === "full_day") return targetLeave;
    if (targetLeave.leaveType === "timed_break" && targetLeave.startTime && targetLeave.endTime) {
      const start = zonedDateTimeToDate(dateKey, targetLeave.startTime, timezone);
      const end = zonedDateTimeToDate(dateKey, targetLeave.endTime, timezone);
      if (instant >= start && instant < end) return targetLeave;
    }
    if (targetLeave.leaveType === "half_day") {
      const shift = getShiftWindow(
        dateKey,
        employee.shiftStartTime || "09:00",
        employee.shiftEndTime || "17:00",
        timezone,
      );
      const midpoint = new Date((shift.start.getTime() + shift.end.getTime()) / 2);
      const isActive =
        targetLeave.halfDayPeriod === "second_half"
          ? instant >= midpoint && instant < shift.end
          : instant >= shift.start && instant < midpoint;
      if (isActive) return targetLeave;
    }
  }
  return null;
}

export function isHolidayAssignedToEmployee(
  holiday: CompanyHoliday,
  employee: Pick<Employee, "id" | "authUid" | "deptId" | "state" | "companyId" | "companyIds">,
): boolean {
  // If companyIds are specified on the holiday, the employee must belong to at least one target company first
  if (Array.isArray(holiday.companyIds) && holiday.companyIds.length > 0) {
    const empCompanyIds = [employee.companyId, ...(employee.companyIds || [])].filter(
      Boolean,
    ) as string[];

    const matchesCompany = empCompanyIds.some(
      (cId) =>
        holiday.companyIds?.includes(cId) ||
        (cId === "default" && holiday.companyIds?.includes(COMPANY_ID)),
    );
    if (!matchesCompany) return false;
  }

  if (holiday.targetType === "all" || holiday.targetType === "companies") return true;
  if (holiday.targetType === "departments")
    return Boolean(employee.deptId && holiday.departmentIds?.includes(employee.deptId));
  if (holiday.targetType === "states") {
    const employeeState = employee.state?.trim() || "N/A";
    return employeeState !== "N/A" && Boolean(holiday.stateCodes?.includes(employeeState));
  }

  const employeeIds = [employee.id, employee.authUid].filter(Boolean) as string[];
  return employeeIds.some((id) => holiday.employeeIds?.includes(id));
}

export function getEmployeeHoliday(
  company: Pick<Company, "holidays" | "holidayAssignments"> | null | undefined,
  employee:
    | Pick<Employee, "id" | "authUid" | "deptId" | "state" | "companyId" | "companyIds">
    | null
    | undefined,
  dateKey: string,
): CompanyHoliday | null {
  if (!company || !employee) return null;
  if (company.holidays?.includes(dateKey)) {
    return {
      id: `legacy-${dateKey}`,
      date: dateKey,
      name: "Company Holiday",
      targetType: "all",
    };
  }
  return (
    company.holidayAssignments?.find(
      (holiday) => holiday.date === dateKey && isHolidayAssignedToEmployee(holiday, employee),
    ) ?? null
  );
}

export function getEmployeeHolidayDates(
  company: Pick<Company, "holidays" | "holidayAssignments"> | null | undefined,
  employee: Pick<Employee, "id" | "authUid" | "deptId" | "state" | "companyId" | "companyIds">,
): string[] {
  const dates = new Set(company?.holidays ?? []);
  for (const holiday of company?.holidayAssignments ?? []) {
    if (isHolidayAssignedToEmployee(holiday, employee)) dates.add(holiday.date);
  }
  return [...dates];
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
  let startTime = employee.shiftStartTime || "09:00";
  let endTime = employee.shiftEndTime || "17:00";

  if (employee.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0) {
    const [shiftYear, shiftMonth, shiftDay] = dateKey.split("-").map(Number);
    const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
    const fallbackDays = employee.workingDays || [0, 1, 2, 3, 4, 5];
    const activeShifts = employee.shifts.filter((s) => {
      const days =
        Array.isArray(s.workingDays) && s.workingDays.length > 0 ? s.workingDays : fallbackDays;
      return days.includes(shiftWeekday);
    });

    if (activeShifts.length > 0) {
      startTime = activeShifts[0].startTime;
      endTime = activeShifts[activeShifts.length - 1].endTime;
    }
  }

  return getShiftWindow(dateKey, startTime, endTime, shiftTimezone);
}

export function getShiftCompletion(employee: Employee, punchedInAt: Date) {
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(punchedInAt, shiftTimezone);
  const shift = getEmployeeShiftWindow(employee, punchedInAt);
  const shiftDurationMs = Math.max(0, shift.end.getTime() - shift.start.getTime());
  const punchOutAt = new Date(punchedInAt.getTime() + shiftDurationMs);

  return { shift, shiftDurationMs, punchOutAt };
}

export function getShiftTimeout(
  employee: Employee,
  punchedInAt: Date,
  now = new Date(),
  graceMinutes = 0,
) {
  const completion = getShiftCompletion(employee, punchedInAt);
  // Auto punch-out triggers as soon as scheduled shift end is reached
  const timeoutThreshold = completion.shift.end.getTime();

  if (now.getTime() < timeoutThreshold) return null;

  return completion;
}

export function computeRegularWorkedMsForDay(
  employee: Employee,
  punches: Punch[],
  day = new Date(),
  now = new Date(),
) {
  const timezone = getShiftTimezone(employee);
  const targetDateKey = zonedDateKey(day, timezone);
  const shift = getEmployeeShiftWindow(employee, day);

  // Filter punches belonging to targetDateKey's shift session
  const dayPunches = punches.filter((punch) => {
    const pDate =
      punch.attendanceDate ||
      punch.date ||
      (punch.timestamp ? zonedDateKey(toDate(punch.timestamp) ?? new Date(), timezone) : "");
    return pDate === targetDateKey;
  });

  const sorted = [...dayPunches]
    .filter((punch) => punch.timestamp)
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));

  let openIn: number | null = null;
  let openType: string = "in";
  let workedMs = 0;

  for (const punch of sorted) {
    const timestamp = toMillis(punch.timestamp);
    if (!timestamp) continue;
    if (punch.type === "in" || punch.type === "extra_in" || punch.type === "lunch_end") {
      openIn = timestamp;
      openType = punch.type;
    } else if (
      (punch.type === "out" || punch.type === "extra_out" || punch.type === "lunch_start") &&
      openIn !== null
    ) {
      if (openType === "in" || openType === "lunch_end") {
        // Clamp regular shift worked ms to [shift.start, shift.end]
        const effectiveStart = Math.max(openIn, shift.start.getTime());
        const effectiveEnd = Math.min(timestamp, shift.end.getTime());
        if (effectiveEnd > effectiveStart) {
          workedMs += effectiveEnd - effectiveStart;
        }
      } else {
        workedMs += Math.max(0, timestamp - openIn);
      }
      openIn = null;
    }
  }

  if (openIn !== null) {
    if (openType === "in" || openType === "lunch_end") {
      const effectiveStart = Math.max(openIn, shift.start.getTime());
      const effectiveEnd = Math.min(now.getTime(), shift.end.getTime());
      if (effectiveEnd > effectiveStart) {
        workedMs += effectiveEnd - effectiveStart;
      }
    } else {
      workedMs += Math.max(0, now.getTime() - openIn);
    }
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

export function formatEmployeeShiftSummary(employee: Employee, instant = new Date()) {
  const shiftTz = getShiftTimezone(employee);
  const localTz = getEmployeeTimezone(employee);
  const conversions = getShiftConversions(employee, instant);

  const getCode = (tz: string) => {
    if (tz.includes("Sydney")) return "AU";
    if (tz.includes("Manila")) return "PH";
    if (tz.includes("Kathmandu")) return "NP";
    return tz.split("/")[1] || "TZ";
  };

  const shiftCode = getCode(shiftTz);
  const localCode = getCode(localTz);

  const shiftConv = conversions.find((c) => c.value === shiftTz) || {
    start: employee.shiftStartTime || "09:00",
    end: employee.shiftEndTime || "17:00",
  };
  const localConv = conversions.find((c) => c.value === localTz);

  const isCrossTimezone = shiftTz !== localTz && Boolean(localConv);
  const shiftText = `${employee.shiftStartTime || "09:00"}–${employee.shiftEndTime || "17:00"}`;

  return {
    shiftTz,
    localTz,
    shiftCode,
    localCode,
    isCrossTimezone,
    shiftText,
    shiftLabel: `${shiftText} ${shiftCode}`,
    localLabel: localConv ? `${localConv.start}–${localConv.end} ${localCode}` : "",
    localStart: localConv?.start || employee.shiftStartTime || "09:00",
    fullSummary:
      isCrossTimezone && localConv
        ? `${shiftText} ${shiftCode} (${localConv.start}–${localConv.end} ${localCode})`
        : `${shiftText} ${shiftCode}`,
  };
}

export function computeEmployeeLateness(
  punchValue: Date,
  employee: Employee,
  graceMinutes = MINIMUM_LATE_GRACE_MINUTES,
) {
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(punchValue, shiftTimezone);
  const employeeShift = getEmployeeShiftWindow(employee, punchValue);
  const fallbackWindow = getShiftWindow(
    dateKey,
    employee.shiftStartTime || "09:00",
    employee.shiftEndTime || "17:00",
    shiftTimezone,
  );
  const windowStart = employeeShift?.start || fallbackWindow.start;
  const differenceSeconds = Math.floor((punchValue.getTime() - windowStart.getTime()) / 1000);
  const isEarly = differenceSeconds < 0;
  const minutes = isEarly ? 0 : Math.max(0, Math.floor(differenceSeconds / 60));
  const effectiveGraceMinutes = getEffectiveLateGraceMinutes(graceMinutes);
  return {
    isLate: !isEarly && minutes > effectiveGraceMinutes,
    isEarly,
    minutes,
    seconds: Math.max(0, differenceSeconds),
    dateKey,
    scheduledAt: windowStart,
    shiftTimezone,
    graceMinutes: effectiveGraceMinutes,
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
        zonedDateKey(toDate(punch.timestamp) ?? new Date(0), shiftTimezone) === targetDate,
    )
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))[0];
}

export function getEffectiveEmployeeWorkingDays(
  employee?: Pick<Employee, "workingDays" | "isMultipleShift" | "shifts">,
  companyWorkingDays?: number[],
): number[] {
  if (employee?.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0) {
    const shiftDays = new Set<number>();
    let hasCustomShiftDays = false;
    for (const shift of employee.shifts) {
      if (Array.isArray(shift.workingDays) && shift.workingDays.length > 0) {
        hasCustomShiftDays = true;
        shift.workingDays.forEach((d) => shiftDays.add(d));
      }
    }
    if (hasCustomShiftDays && shiftDays.size > 0) {
      return Array.from(shiftDays).sort((a, b) => a - b);
    }
  }
  if (Array.isArray(employee?.workingDays) && employee!.workingDays!.length > 0) {
    return employee!.workingDays!;
  }
  if (Array.isArray(companyWorkingDays) && companyWorkingDays.length > 0) {
    return companyWorkingDays;
  }
  return [0, 1, 2, 3, 4, 5]; // Default Sunday to Friday (6 days)
}

export function getLiveAttendanceStatus(
  employee: Employee,
  punches: Punch[],
  now = new Date(),
  graceMinutes = MINIMUM_LATE_GRACE_MINUTES,
  workingDays?: number[],
  holidays: string[] = [],
) {
  const sorted = [...punches]
    .filter((punch) => punch.timestamp)
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
  const latest = sorted.at(-1);
  const shiftTimezone = getShiftTimezone(employee);
  const todayDateKey = zonedDateKey(now, shiftTimezone);
  const shift = getEmployeeShiftWindow(employee, now);

  const latestPunchDate = latest?.attendanceDate || latest?.date || (latest?.timestamp ? zonedDateKey(toDate(latest?.timestamp) ?? now, shiftTimezone) : "");
  const isStaleFromPastDay = latestPunchDate ? latestPunchDate < todayDateKey : false;
  const isPastShiftEnd = now.getTime() >= shift.end.getTime();

  // If latest punch is regular 'in' or 'lunch_start' but shift is already finished or from a previous day, consider shift auto-completed
  const isRegularActive =
    (latest?.type === "in" || latest?.type === "lunch_start" || latest?.type === "lunch_end") &&
    !isStaleFromPastDay &&
    !isPastShiftEnd;

  const isExtraActive = latest?.type === "extra_in";
  const isPunchedIn = Boolean(isRegularActive || isExtraActive);
  const isOnLunch = isRegularActive && latest?.type === "lunch_start";

  const firstIn = getFirstRegularPunchInForShift(employee, sorted, now);
  const [shiftYear, shiftMonth, shiftDay] = shift.dateKey.split("-").map(Number);
  const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
  const effectiveWorkingDays = getEffectiveEmployeeWorkingDays(employee, workingDays);
  const isScheduledDay =
    effectiveWorkingDays.includes(shiftWeekday) && !holidays.includes(shift.dateKey);
  const effectiveGraceMinutes = getEffectiveLateGraceMinutes(graceMinutes);
  const lateness =
    firstIn && isScheduledDay
      ? computeEmployeeLateness(toDate(firstIn.timestamp) ?? now, employee, effectiveGraceMinutes)
      : null;
  const missingMinutes = Math.max(0, Math.floor((now.getTime() - shift.start.getTime()) / 60000));
  const isMissingLate =
    isScheduledDay && !firstIn && missingMinutes > effectiveGraceMinutes && now <= shift.end;
  const isEarly = Boolean(lateness?.isEarly);
  const minutesEarly =
    isEarly && firstIn && lateness
      ? Math.floor(
          Math.abs(
            ((toDate(firstIn.timestamp)?.getTime() ?? 0) - lateness.scheduledAt.getTime()) / 1000,
          ) /
            60,
        )
      : 0;

  const isShiftCompleted = isPastShiftEnd;

  return {
    latest,
    firstIn,
    isPunchedIn,
    isOnLunch,
    isOvertimeSession: isExtraActive,
    isShiftCompleted,
    isPastShiftEnd,
    isLate: lateness?.isLate ?? isMissingLate,
    minutesLate: lateness?.minutes ?? (isMissingLate ? missingMinutes : 0),
    isEarly,
    minutesEarly,
    lateness,
    isMissingLate,
    isScheduledDay,
    shift,
  };
}

/**
 * Resolves the single active working session for an employee across ALL company memberships.
 * An employee can only be clocked in at ONE company at any given time.
 * Returns the companyId, latest punch, and live status of that single active session (or null if none).
 */
export function getActiveWorkingSession(
  allPunches: Punch[],
  employee: Employee | null | undefined,
  now: Date = new Date(),
  companies: Company[] = [],
): {
  activeCompanyId: string | null;
  activePunch: Punch | null;
  status: LiveAttendanceStatus | null;
  activeCompanyName: string | null;
} {
  if (!employee || !allPunches || allPunches.length === 0) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null };
  }

  // Sort punches chronologically ascending
  const sorted = [...allPunches]
    .filter((p) => p.timestamp)
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));

  if (sorted.length === 0) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null };
  }

  const latestGlobal = sorted[sorted.length - 1];
  const isGlobalIn =
    latestGlobal.type === "in" ||
    latestGlobal.type === "extra_in" ||
    latestGlobal.type === "lunch_start" ||
    latestGlobal.type === "lunch_end";

  if (!isGlobalIn) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null };
  }

  const activeCompanyId = getPunchCompanyId(latestGlobal, employee);
  const companyEmployee = getEmployeeForCompany(employee, activeCompanyId);
  const companyPunches = sorted.filter((p) => getPunchCompanyId(p, employee) === activeCompanyId);
  const comp = companies.find((c) => (c.id || COMPANY_ID) === activeCompanyId);
  const activeCompanyName = comp?.name || (activeCompanyId === COMPANY_ID ? "Main Company" : activeCompanyId);

  const status = getLiveAttendanceStatus(
    companyEmployee,
    companyPunches,
    now,
    comp?.lateGraceMinutes ?? 5,
    comp?.workingDays,
    getEmployeeHolidayDates(comp, companyEmployee),
  );

  if (!status.isPunchedIn) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null };
  }

  return {
    activeCompanyId,
    activePunch: latestGlobal,
    status,
    activeCompanyName,
  };
}
