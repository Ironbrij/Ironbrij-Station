import { dateTimeFormatter } from "./intl-format.ts";
import {
  COMPANY_ID,
  type Company,
  type CompanyHoliday,
  type Employee,
  type LeaveRequest,
  type Punch,
} from "./types.ts";
import { toDate, toMillis } from "./time.ts";
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getPunchCompanyId,
  normalizeCompanyId,
} from "./company-context.ts";

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
    dateTimeFormatter("en-US", { timeZone: timezone }).format();
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

    const matchesCompany = empCompanyIds.some((cId) =>
      holiday.companyIds?.some(
        (hId) => normalizeCompanyId(hId) === normalizeCompanyId(cId),
      ),
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
  const parts = dateTimeFormatter("en-CA", {
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

const zonedInstants = new Map<string, number>();
export function zonedDateTimeToDate(dateKey: string, time: string, timezone: string): Date {
  const cacheKey = `${dateKey}|${time}|${timezone}`;
  const cached = zonedInstants.get(cacheKey);
  if (cached !== undefined) return new Date(cached);
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
  if (zonedInstants.size >= 2048) zonedInstants.delete(zonedInstants.keys().next().value!);
  zonedInstants.set(cacheKey, guess);
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

export function getEmployeeShiftWindow(
  employee: Employee,
  instant = new Date(),
  punches?: Punch[],
  now = instant,
): ReturnType<typeof getShiftWindow> & { effectiveEnd: Date } {
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = zonedDateKey(instant, shiftTimezone);
  const sorted = getShiftPunches(employee, punches ?? [], now);
  // Keep an unfinished session anchored to its original shift, even when a
  // break extends it into the next slot or across midnight.
  let activeIn: Punch | undefined;
  for (const punch of sorted) {
    if (punch.type === "in") activeIn = punch;
    else if (punch.type === "out" || punch.type === "extra_in" || punch.type === "extra_out") {
      activeIn = undefined;
    }
  }
  if (activeIn) {
    const activeInTime =
      toDate(activeIn.timestamp) || (activeIn.createdAt ? new Date(activeIn.createdAt) : null);
    if (activeInTime && Math.abs(now.getTime() - activeInTime.getTime()) <= 24 * 60 * 60 * 1000) {
      const activeShift = getEmployeeShiftWindow(employee, activeInTime);
      const adjusted = extendShiftForBreaks(employee, activeShift, sorted, now);
      if (activeShift.dateKey === dateKey || now.getTime() <= adjusted.effectiveEnd.getTime()) {
        return adjusted;
      }
    }
  }
  const previousDate = addCalendarDays(dateKey, -1);
  const previousWeekday = new Date(`${previousDate}T12:00:00Z`).getUTCDay();
  const previousSchedules = employee.isMultipleShift && employee.shifts?.length
    ? employee.shifts
    : [{ startTime: employee.shiftStartTime || "09:00", endTime: employee.shiftEndTime || "17:00", workingDays: employee.workingDays }];
  const previousWindow = previousSchedules
    .filter((s) => s.endTime <= s.startTime)
    .filter((s) => (s.workingDays?.length ? s.workingDays.map(Number) : getEffectiveEmployeeWorkingDays(employee)).includes(previousWeekday))
    .map((s) => getShiftWindow(previousDate, s.startTime, s.endTime, shiftTimezone))
    .find((s) => s.crossesMidnight && instant >= s.start && instant < s.end);
  if (previousWindow) return extendShiftForBreaks(employee, previousWindow, sorted, now);

  let startTime = employee.shiftStartTime || "09:00";
  let endTime = employee.shiftEndTime || "17:00";

  if (employee.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0) {
    const [shiftYear, shiftMonth, shiftDay] = dateKey.split("-").map(Number);
    const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
    const fallbackDays = getEffectiveEmployeeWorkingDays(employee);
    const activeShifts = employee.shifts.filter((s) => {
      const days =
        Array.isArray(s.workingDays) && s.workingDays.length > 0
          ? s.workingDays.map(Number).filter((d) => !Number.isNaN(d) && d >= 0 && d <= 6)
          : fallbackDays;
      return days.includes(shiftWeekday);
    });

    if (activeShifts.length > 0) {
      const shiftWindows = activeShifts.map((s, index) => {
        const win = getShiftWindow(dateKey, s.startTime, s.endTime, shiftTimezone);
        return { shift: s, win, index };
      });

      // If punches are provided, filter out shift slots already completed today
      let uncompletedSlots = shiftWindows;
      if (Array.isArray(punches) && punches.length > 0) {
        const todayPunches = sorted.filter((p) => {
          const pDate =
            p.attendanceDate ||
            p.date ||
            (p.timestamp ? zonedDateKey(toDate(p.timestamp) ?? instant, shiftTimezone) : "");
          return pDate === dateKey;
        });
        const completedShiftsCount = todayPunches.filter((p) => p.type === "out").length;
        if (completedShiftsCount > 0 && completedShiftsCount < shiftWindows.length) {
          uncompletedSlots = shiftWindows.slice(completedShiftsCount);
        }
      }

      // Check if instant falls inside an uncompleted shift window
      const currentSlot = uncompletedSlots.find(
        ({ win }) =>
          instant.getTime() >= win.start.getTime() && instant.getTime() < win.end.getTime(),
      );

      if (currentSlot) {
        startTime = currentSlot.shift.startTime;
        endTime = currentSlot.shift.endTime;
      } else {
        const upcomingSlot = uncompletedSlots.find(
          ({ win }) => instant.getTime() < win.start.getTime(),
        );

        if (upcomingSlot) {
          startTime = upcomingSlot.shift.startTime;
          endTime = upcomingSlot.shift.endTime;
        } else {
          const lastSlot =
            uncompletedSlots[uncompletedSlots.length - 1] || shiftWindows[shiftWindows.length - 1];
          startTime = lastSlot.shift.startTime;
          endTime = lastSlot.shift.endTime;
        }
      }
    }
  }

  return extendShiftForBreaks(
    employee,
    getShiftWindow(dateKey, startTime, endTime, shiftTimezone),
    sorted,
    now,
  );
}

function getShiftPunches(employee: Employee, punches: Punch[], now: Date): Punch[] {
  const allowedCompanyIds = new Set(
    [employee.companyId, ...getEmployeeCompanyIds(employee)]
      .filter((v): v is string => Boolean(v))
      .map(normalizeCompanyId),
  );

  return punches
    .filter((punch) => {
      if (punch.voidedAt) return false;
      const punchEmpId = punch.employeeId;
      const empMatches =
        !punchEmpId ||
        punchEmpId === employee.id ||
        Boolean(employee.authUid && punchEmpId === employee.authUid);
      if (!empMatches) return false;

      if (punch.companyId) {
        const punchCId = normalizeCompanyId(punch.companyId);
        if (allowedCompanyIds.size > 0 && !allowedCompanyIds.has(punchCId)) return false;
      }

      const pDate =
        toDate(punch.timestamp) || (punch.createdAt ? new Date(punch.createdAt) : null);
      if (!pDate) return false;

      // Allow 5 minutes clock skew tolerance so client machine drift does not drop fresh punches
      return pDate.getTime() <= now.getTime() + 5 * 60 * 1000;
    })
    .sort((a, b) => {
      const tA = toMillis(a.timestamp) || (a.createdAt ? new Date(a.createdAt).getTime() : 0);
      const tB = toMillis(b.timestamp) || (b.createdAt ? new Date(b.createdAt).getTime() : 0);
      return tA - tB;
    });
}

function extendShiftForBreaks(
  employee: Employee,
  shift: ReturnType<typeof getShiftWindow>,
  sorted: Punch[],
  now: Date,
) {
  let totalBreakMs = 0;
  let breakStart: number | null = null;
  let inShift = false;
  const closeBreak = (end: number) => {
    if (breakStart !== null) totalBreakMs += Math.max(0, end - breakStart);
    breakStart = null;
  };

  for (const punch of sorted) {
    const timestamp =
      toMillis(punch.timestamp) || (punch.createdAt ? new Date(punch.createdAt).getTime() : 0);
    if (punch.type === "in") {
      closeBreak(timestamp);
      const sessionShift = getEmployeeShiftWindow(employee, new Date(timestamp));
      inShift = sessionShift.start.getTime() === shift.start.getTime();
    } else if (punch.type === "out" || punch.type === "extra_in" || punch.type === "extra_out") {
      closeBreak(timestamp);
      inShift = false;
    } else if (punch.type === "lunch_start" && inShift && breakStart === null) {
      const start = Math.max(timestamp, shift.start.getTime());
      // A break begun after the required shift has ended cannot reopen it.
      if (start < shift.end.getTime() + totalBreakMs) breakStart = start;
    } else if (punch.type === "lunch_end") {
      closeBreak(timestamp);
    }
  }
  // An ongoing break keeps pushing the deadline back; it never counts as work.
  // Cap ongoing break extension at 12 hours max to prevent an abandoned break from pushing deadline forever
  if (breakStart !== null) {
    const ongoingBreakEnd = Math.min(now.getTime(), breakStart + 12 * 60 * 60 * 1000);
    closeBreak(ongoingBreakEnd);
  }
  // Scheduled start/end are immutable schedule metadata. Only this runtime
  // deadline includes breaks; never persist it as scheduledShiftEnd.
  return { ...shift, effectiveEnd: new Date(shift.end.getTime() + totalBreakMs) };
}

export function getShiftCompletion(employee: Employee, punchedInAt: Date) {
  const shift = getEmployeeShiftWindow(employee, punchedInAt);
  const shiftDurationMs = Math.max(0, shift.end.getTime() - shift.start.getTime());
  const punchOutAt = shift.end;

  return { shift, shiftDurationMs, punchOutAt };
}

export function getShiftTimeout(
  employee: Employee,
  punchedInAt: Date,
  now = new Date(),
  graceMinutes = 0,
  punches: Punch[] = [],
) {
  const completion = getShiftCompletion(employee, punchedInAt);
  // Never close a late-started session before it began. It can be stopped manually.
  if (punchedInAt.getTime() >= completion.shift.end.getTime()) return null;
  const shift = extendShiftForBreaks(
    employee,
    completion.shift,
    getShiftPunches(employee, punches, now),
    now,
  );
  const timeoutThreshold = shift.effectiveEnd.getTime();

  if (now.getTime() < timeoutThreshold) return null;

  return { ...completion, shift, punchOutAt: shift.effectiveEnd };
}

export function computeRegularWorkedMsForDay(
  employee: Employee,
  punches: Punch[],
  day = new Date(),
  now = new Date(),
) {
  // Keep adjacent days for overnight shifts and break extensions.
  punches = punches.filter((p) => {
    const time = toMillis(p.timestamp) || toMillis(p.createdAt);
    return Math.abs(time - day.getTime()) <= 72 * 60 * 60 * 1000;
  });
  const timezone = getShiftTimezone(employee);
  const targetDateKey = getEmployeeShiftWindow(employee, day, punches, now).dateKey;
  const sorted = getShiftPunches(employee, punches, now);
  let session: Punch[] = [];
  let workedMs = 0;
  function finish(end: Date) {
    const first = session[0];
    if (!first) return;
    const started = toDate(first.timestamp) || toDate(first.createdAt);
    if (!started) return;
    const shift = getEmployeeShiftWindow(employee, started, session.filter((p) => p.type !== "out" && p.type !== "extra_out"), end);
    const dateKey = first.attendanceDate || first.date || shift.dateKey;
    if (dateKey !== targetDateKey) return;
    const extra = first.type === "extra_in" || started >= shift.end;
    let open: number | null = started.getTime();
    function add(until: number) {
      if (open === null) return;
      const from = extra ? open : Math.max(open, shift.start.getTime());
      const to = extra ? until : Math.min(until, shift.effectiveEnd.getTime());
      workedMs += Math.max(0, to - from);
    }
    for (const punch of session.slice(1)) {
      const time = toMillis(punch.timestamp) || toMillis(punch.createdAt);
      if (punch.type === "lunch_start" && open !== null) { add(time); open = null; }
      else if (punch.type === "lunch_end" && open === null) open = time;
    }
    add(end.getTime());
  }
  for (const punch of sorted) {
    const time = toDate(punch.timestamp) || toDate(punch.createdAt);
    if (!time) continue;
    if (punch.type === "in" || punch.type === "extra_in") {
      if (session.length) finish(time);
      session = [punch];
    } else if (punch.type === "out" || punch.type === "extra_out") {
      if (session.length) { session.push(punch); finish(time); session = []; }
    } else if (session.length) session.push(punch);
  }
  if (session.length) finish(now);
  return workedMs;
}

export function formatInTimezone(
  value: Date,
  timezone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  return dateTimeFormatter("en-US", {
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
  isExcused = false,
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
  const rawMinutes = isEarly ? 0 : Math.max(0, Math.floor(differenceSeconds / 60));
  const effectiveGraceMinutes = getEffectiveLateGraceMinutes(graceMinutes);
  const naturallyLate = !isEarly && rawMinutes > effectiveGraceMinutes;

  return {
    isLate: isExcused ? false : naturallyLate,
    naturallyLate,
    isExcused: Boolean(isExcused),
    isEarly,
    minutes: isExcused ? 0 : rawMinutes,
    rawMinutes,
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
  const targetShift = getEmployeeShiftWindow(employee, instant, punches, instant);
  const targetDate = targetShift.dateKey;
  return punches
    .filter((punch) => {
      if ((punch.type !== "in" && punch.type !== "extra_in") || !punch.timestamp) return false;
      const pDate =
        punch.attendanceDate ||
        punch.date ||
        zonedDateKey(toDate(punch.timestamp) ?? new Date(0), shiftTimezone);
      const at = toDate(punch.timestamp);
      return !punch.voidedAt && pDate === targetDate && at !== null &&
        getEmployeeShiftWindow(employee, at).start.getTime() === targetShift.start.getTime();
    })
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))[0];
}

export function getEffectiveEmployeeWorkingDays(
  employee?: Pick<Employee, "workingDays" | "isMultipleShift" | "shifts">,
  companyWorkingDays?: (number | string)[],
): number[] {
  const normalizeDays = (days?: (number | string)[]): number[] => {
    if (!Array.isArray(days)) return [];
    return days
      .map((d) => Number(d))
      .filter((d) => !Number.isNaN(d) && d >= 0 && d <= 6);
  };

  if (employee?.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0) {
    const shiftDays = new Set<number>();
    let hasCustomShiftDays = false;
    for (const shift of employee.shifts) {
      if (Array.isArray(shift.workingDays) && shift.workingDays.length > 0) {
        hasCustomShiftDays = true;
        normalizeDays(shift.workingDays).forEach((d) => shiftDays.add(d));
      }
    }
    if (hasCustomShiftDays && shiftDays.size > 0) {
      return Array.from(shiftDays).sort((a, b) => a - b);
    }
  }

  const normalizedCompanyDays = normalizeDays(companyWorkingDays);
  const normalizedEmployeeDays = normalizeDays(employee?.workingDays);

  if (normalizedEmployeeDays.length > 0) {
    // Explicit employee/company-membership schedules override company defaults.
    return normalizedEmployeeDays;
  }
  if (normalizedCompanyDays.length > 0) {
    return normalizedCompanyDays;
  }
  return [0, 1, 2, 3, 4, 5]; // Default Sunday to Friday (6 days)
}

// Live status only needs recent sessions and the last older event for its
// last-seen label. Keep full history available to reports and manual corrections.
function livePunchHistory(punches: Punch[], now: Date): Punch[] {
  const cutoff = now.getTime() - 72 * 60 * 60 * 1000;
  const recent: Punch[] = [];
  let previous: Punch | undefined;
  let previousTime = -Infinity;
  for (const punch of punches) {
    if (punch.voidedAt) continue;
    const time = toMillis(punch.timestamp) || toMillis(punch.createdAt);
    if (!time) continue;
    if (time >= cutoff) recent.push(punch);
    else if (time >= previousTime) { previous = punch; previousTime = time; }
  }
  if (previous) recent.unshift(previous);
  return recent;
}

export function getLiveAttendanceStatus(
  employee: Employee,
  punches: Punch[],
  now = new Date(),
  graceMinutes = MINIMUM_LATE_GRACE_MINUTES,
  workingDays?: (number | string)[],
  holidays: string[] = [],
) {
  const sorted = livePunchHistory(getShiftPunches(employee, punches, now), now);
  const latest = sorted.at(-1);
  const shiftTimezone = getShiftTimezone(employee);
  const todayDateKey = zonedDateKey(now, shiftTimezone);
  const shift = getEmployeeShiftWindow(employee, now, sorted);

  const latestPunchDate =
    latest?.attendanceDate ||
    latest?.date ||
    (latest?.timestamp ? zonedDateKey(toDate(latest?.timestamp) ?? now, shiftTimezone) : "");
  const isStaleFromPastDay = latestPunchDate
    ? latestPunchDate < todayDateKey && latestPunchDate !== shift.dateKey
    : false;

  // An active session is regular if latest punch is 'in' or lunch break, and not from a stale past day.
  // Clocked-in work past shift end remains active so employee can punch out cleanly.
  const isRegularActive =
    (latest?.type === "in" || latest?.type === "lunch_start" || latest?.type === "lunch_end") &&
    !isStaleFromPastDay;

  const isExtraActive = latest?.type === "extra_in";
  const isPunchedIn = Boolean(isRegularActive || isExtraActive);
  const isOnLunch = isRegularActive && latest?.type === "lunch_start";

  const firstIn = getFirstRegularPunchInForShift(employee, sorted, now);
  const [shiftYear, shiftMonth, shiftDay] = shift.dateKey.split("-").map(Number);
  const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
  const effectiveWorkingDays = getEffectiveEmployeeWorkingDays(employee, workingDays);
  const isScheduledDay =
    effectiveWorkingDays.includes(shiftWeekday) && !holidays.includes(shift.dateKey);

  // Multi-shift progress tracking
  const todayPunches = sorted.filter((p) => {
    const pDate =
      p.attendanceDate ||
      p.date ||
      (p.timestamp ? zonedDateKey(toDate(p.timestamp) ?? now, shiftTimezone) : "");
    return pDate === todayDateKey || pDate === shift.dateKey;
  });

  const fallbackDays = effectiveWorkingDays;
  const activeShiftsForToday =
    employee.isMultipleShift && Array.isArray(employee.shifts) && employee.shifts.length > 0
      ? employee.shifts.filter((s) => {
          const days =
            Array.isArray(s.workingDays) && s.workingDays.length > 0
              ? s.workingDays.map(Number).filter((d) => !Number.isNaN(d) && d >= 0 && d <= 6)
              : fallbackDays;
          return days.includes(shiftWeekday);
        })
      : [];

  const completedRegularShiftsCount = todayPunches.filter((p) => p.type === "out").length;
  const hasMultipleShiftsToday = activeShiftsForToday.length > 1;
  const totalShiftsToday = hasMultipleShiftsToday ? activeShiftsForToday.length : 1;
  const remainingShiftsCount = hasMultipleShiftsToday
    ? Math.max(0, activeShiftsForToday.length - completedRegularShiftsCount - (isPunchedIn ? 1 : 0))
    : isPunchedIn || completedRegularShiftsCount > 0
      ? 0
      : 1;

  const hasCompletedAllShiftsToday = hasMultipleShiftsToday
    ? completedRegularShiftsCount >= activeShiftsForToday.length
    : completedRegularShiftsCount > 0;

  // Only consider shift completed (for triggering post-shift overtime) if all scheduled shifts
  // for today have actually been worked & punched out, and the break-adjusted deadline has passed.
  // If the employee hasn't worked yet today or has shifts remaining, isPastShiftEnd is false
  // so the employee can start their regular shift without being forced into overtime.
  const isPastShiftEnd =
    hasCompletedAllShiftsToday && now.getTime() >= shift.effectiveEnd.getTime();
  const isShiftCompleted = isPastShiftEnd;

  const effectiveGraceMinutes = getEffectiveLateGraceMinutes(graceMinutes);
  const isExcused = Boolean(firstIn?.isExcused);
  const lateness =
    firstIn && isScheduledDay
      ? computeEmployeeLateness(
          toDate(firstIn.timestamp) ?? now,
          employee,
          effectiveGraceMinutes,
          isExcused,
        )
      : null;
  const missingMinutes = Math.max(0, Math.floor((now.getTime() - shift.start.getTime()) / 60000));
  const isMissingLate =
    isScheduledDay &&
    !isPunchedIn &&
    !firstIn &&
    missingMinutes > effectiveGraceMinutes &&
    now <= shift.effectiveEnd &&
    !hasCompletedAllShiftsToday;
  const isEarly = Boolean(lateness?.isEarly);
  const minutesEarly =
    isEarly && firstIn && lateness
      ? Math.floor(
          Math.abs(
            ((toDate(firstIn.timestamp)?.getTime() ?? 0) - lateness.scheduledAt.getTime()) / 1000,
          ) / 60,
        )
      : 0;

  return {
    latest,
    firstIn,
    isPunchedIn,
    isOnLunch,
    isOvertimeSession: isExtraActive,
    isShiftCompleted,
    isPastShiftEnd,
    isLate: isExcused ? false : (lateness?.isLate ?? isMissingLate),
    isExcused,
    excuseReason: firstIn?.excuseReason,
    minutesLate: isExcused ? 0 : (lateness?.minutes ?? (isMissingLate ? missingMinutes : 0)),
    rawMinutesLate: lateness?.rawMinutes ?? (isMissingLate ? missingMinutes : 0),
    isEarly,
    minutesEarly,
    lateness,
    isMissingLate,
    isScheduledDay,
    shift,
    completedRegularShiftsCount,
    totalShiftsToday,
    remainingShiftsCount,
    hasCompletedAllShiftsToday,
  };
}

export type LiveAttendanceStatus = ReturnType<typeof getLiveAttendanceStatus>;

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
  sessionType: "in" | "break" | null;
} {
  if (!employee || !allPunches || allPunches.length === 0) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null, sessionType: null };
  }

  // Sort punches chronologically ascending
  const sorted = getShiftPunches(employee, livePunchHistory(allPunches.filter((p) =>
    p.employeeId === employee.id || Boolean(employee.authUid && p.employeeId === employee.authUid),
  ), now), now);

  if (sorted.length === 0) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null, sessionType: null };
  }

  // A closing punch only ends its own company's session. A switch-company
  // auto out can arrive at the same time as (or after) the new company's in.
  let latestGlobal: Punch | undefined;
  for (const punch of sorted) {
    if (punch.type === "in" || punch.type === "extra_in") {
      latestGlobal = punch;
    } else if (latestGlobal &&
      getPunchCompanyId(punch, employee, companies) ===
        getPunchCompanyId(latestGlobal, employee, companies)) {
      if (punch.type === "out" || punch.type === "extra_out") latestGlobal = undefined;
      else if (punch.type === "lunch_start" || punch.type === "lunch_end") latestGlobal = punch;
    }
  }

  if (!latestGlobal) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null, sessionType: null };
  }

  const activeCompanyId = getPunchCompanyId(latestGlobal, employee, companies);
  const companyEmployee = getEmployeeForCompany(employee, activeCompanyId);
  const companyPunches = sorted.filter((p) => getPunchCompanyId(p, employee, companies) === activeCompanyId);
  const comp = companies.find(
    (c) => normalizeCompanyId(c.id) === normalizeCompanyId(activeCompanyId),
  );
  const activeCompanyName =
    comp?.name || (normalizeCompanyId(activeCompanyId) === COMPANY_ID ? "Main Company" : activeCompanyId);

  const status = getLiveAttendanceStatus(
    companyEmployee,
    companyPunches,
    now,
    comp?.lateGraceMinutes ?? 5,
    comp?.workingDays,
    getEmployeeHolidayDates(comp, companyEmployee),
  );

  if (!status.isPunchedIn) {
    return { activeCompanyId: null, activePunch: null, status: null, activeCompanyName: null, sessionType: null };
  }

  const sessionType: "in" | "break" =
    latestGlobal.type === "lunch_start" || status.isOnLunch ? "break" : "in";

  return {
    activeCompanyId,
    activePunch: latestGlobal,
    status,
    activeCompanyName,
    sessionType,
  };
}
