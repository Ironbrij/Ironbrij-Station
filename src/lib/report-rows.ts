import type {
  Company,
  Department,
  Employee,
  LeaveRequest,
  OvertimeRequest,
  Punch,
} from "./types.ts";
import { COMPANY_ID } from "./types.ts";
import { toDate, toMillis } from "./time.ts";
import { formatWorkMinutes } from "./attendance-calculation.ts";
import { buildAttendanceSessions, type AttendanceSession } from "./attendance-sessions.ts";
import { computeLeaveCreditBalance, leaveDayHours } from "./leave-credits.ts";
import { formatCovered, formatDaysAndHours, formatHours, formatShortDate } from "./report-format.ts";
import { getShiftIntervals } from "./shift-clients.ts";
import { totalsFromDays } from "./report-edits.ts";
import {
  formatInTimezone,
  getEffectiveEmployeeWorkingDays,
  getEffectiveLateGraceMinutes,
  getEmployeeApprovedLeaveDates,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getLeaveLabel,
  getShiftTimezone,
  zonedDateKey,
} from "./attendance.ts";
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getEmployeeLeavesForCompany,
  getIndexedEmployeePunches,
  getRequiredWorkMinutes,
  indexPunchesByEmployee,
  normalizeCompanyId,
} from "./company-context.ts";

export interface PunchSessionRecord {
  inTime: string;
  outTime?: string;
  durationMinutes: number;
  isOvertime: boolean;
  isAuto: boolean;
  type: string;
}

export interface DailyIntervalRecord {
  date: string;
  dayOfWeek: string;
  scheduledShift: string;
  punchInTime?: string; // HH:mm
  punchOutTime?: string; // HH:mm
  firstInPunchId?: string;
  lastOutPunchId?: string;
  sessions?: PunchSessionRecord[];
  isMissingPunchOut: boolean;
  isAutoPunchOut: boolean;
  minutesLate: number;
  /** Break the employee actually punched, in minutes. */
  breakMinutes: number;
  /** Break allowance charged because none was punched, in minutes. */
  unloggedBreakMinutes: number;
  regularHours: number;
  rawOvertimeHours: number;
  isOvertimeApproved: boolean;
  isOvertimeRejected?: boolean;
  overtimeStatus?: "approved" | "pending" | "rejected" | "none";
  status: string;
  note?: string;
  isCustom?: boolean;
}

export interface ReportRow {
  id: string;
  isCustom?: boolean;
  isAdjusted?: boolean;
  worked: boolean; // toggle if the person worked or not
  employeeId?: string;
  employeeName: string;
  employeeEmail?: string;
  department: string;
  role: string;
  /** Who the work was for: the clients named on the shifts, else the company reported on. */
  client: string;
  /** The employee's standing, "active" or "inactive". */
  status: string;
  /** Length of the employee's working day, to show leave in days and hours. */
  hoursPerDay: number;
  workedDays: number;
  absentDays: number;
  lateDays: number;
  leaveDays: number;
  regularHours: number;
  overtimeHours: number;
  pendingOvertimeHours: number;
  overtimeDates: string[];
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  /** Paid leave as the report shows it, "2.5 Days (20 hours)"; an admin may type over it. */
  paidLeaveUsed: string;
  /** Unpaid leave as the report shows it; an admin may type over it. */
  unpaidLeaveUsed: string;
  /**
   * Paid leave credit left after leave taken this year up to the period's end, as
   * the report shows it: "7.54 Days (60.32 hours)". Blank when none is set.
   */
  availableLeaveCredit: string;
  remarks: string;
  dailyIntervals: DailyIntervalRecord[];
}

export interface ReportRowsInput {
  employees: Employee[];
  punches: Punch[];
  leaves: LeaveRequest[];
  overtimeRequests: OvertimeRequest[];
  departments: Department[];
  companies: Company[];
  /** A company id, or "all" to report across every client. */
  companyFilter: string;
  /** Company used for holidays and grace when reporting across all clients. */
  fallbackCompany?: Company | null;
  from: string;
  to: string;
  /** The moment the report is read; sessions still running are measured to it. */
  now?: Date;
}

export function addCalendarDay(dateKey: string): string {
  const next = new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** "sick leave (unpaid) - dentist", so a zero-hours day explains itself. */
export function describeLeave(leave: LeaveRequest): string {
  const category = leave.leaveCategory ? `${leave.leaveCategory} leave` : "Leave";
  const payment = leave.paymentStatus === "unpaid" ? " (unpaid)" : "";
  const reason = leave.reason?.trim();
  return `${category}${payment}${reason ? ` - ${reason}` : ""}`;
}

export function getDayOfWeekStr(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  } catch {
    return "";
  }
}

/**
 * Who a row's work was for. A shift slot that names its client is the most
 * specific answer; otherwise it is the company being reported on, or across all
 * clients, the companies the person belongs to other than the main one.
 */
function reportClientName(
  employee: Employee,
  rawEmployee: Employee,
  companyFilter: string,
  reportCompany: Company | null,
  companies: Company[],
): string {
  const shiftClients = [
    ...new Set(
      getShiftIntervals(employee)
        .map((shift) => shift.clientName?.trim() || "")
        .filter(Boolean),
    ),
  ];
  if (shiftClients.length > 0) return shiftClients.join(", ");
  if (companyFilter !== "all") return reportCompany?.name || "";
  const memberOf = getEmployeeCompanyIds(rawEmployee)
    .map((id) => companies.find((item) => normalizeCompanyId(item.id) === normalizeCompanyId(id)))
    .filter((item): item is Company => Boolean(item));
  const clients = memberOf.filter((item) => !item.isMain);
  return (clients.length > 0 ? clients : memberOf).map((item) => item.name).join(", ");
}

/**
 * The report's per-employee figures. The admin screen and the emailed weekly
 * report both read this, so a client is never sent numbers that differ from the
 * ones on screen.
 */
export function buildReportRows({
  employees: filteredEmployees,
  punches,
  leaves,
  overtimeRequests,
  departments,
  companies,
  companyFilter,
  fallbackCompany: authCompany = null,
  from,
  to,
  now = new Date(),
}: ReportRowsInput): ReportRow[] {
    const rows: ReportRow[] = [];
    // Every punch, across every client, so a switch to another client ends a
    // session here exactly as it does on the dashboard.
    const punchesByEmployee = indexPunchesByEmployee(
      punches.filter((punch) => !punch.voidedAt && punch.timestamp),
    );
    const reportCompanyId = companyFilter === "all" ? null : normalizeCompanyId(companyFilter);

    for (const rawEmployee of filteredEmployees) {
      const employee =
        companyFilter === "all" ? rawEmployee : getEmployeeForCompany(rawEmployee, companyFilter);
      const reportCompany =
        companyFilter === "all"
          ? authCompany
          : companies.find(
              (item) => normalizeCompanyId(item.id) === normalizeCompanyId(companyFilter),
            ) || authCompany;

      const employeeLeaves = getEmployeeLeavesForCompany(
        leaves,
        rawEmployee,
        companyFilter,
      ).filter((leave) => leave.status === "approved");

      const shiftTimezone = getShiftTimezone(employee);
      // The dashboard's sessions: breaks punched are taken off, a gap between
      // two sessions is not work, and each is judged on the schedule its punch
      // was made under.
      const ownPunches = getIndexedEmployeePunches(punchesByEmployee, rawEmployee)
        .filter((punch) => toMillis(punch.timestamp) <= now.getTime() + 5 * 60_000)
        .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
      const sessionsByDate = new Map<string, AttendanceSession[]>();
      for (const session of buildAttendanceSessions({
        employee: rawEmployee,
        punches: ownPunches,
        companies,
        now,
      })) {
        if (reportCompanyId && session.companyId !== reportCompanyId) continue;
        const date = session.attendanceDate;
        if (date < from || date > to) continue;
        const list = sessionsByDate.get(date);
        if (list) list.push(session);
        else sessionsByDate.set(date, [session]);
      }
      const dayPunchGroups = new Set<string>(sessionsByDate.keys());

      // Collect dates from leaves and holidays within range as well
      for (const date of getEmployeeHolidayDates(reportCompany, employee)) {
        if (date >= from && date <= to) dayPunchGroups.add(date);
      }
      for (const date of getEmployeeApprovedLeaveDates(employee, employeeLeaves)) {
        if (date >= from && date <= to) dayPunchGroups.add(date);
      }
      // A scheduled day with neither punch nor leave is exactly the day an admin
      // is asking about when a week reads as zero worked days. Seed every one so
      // it gets a row that says what happened instead of going missing.
      const scheduledDays = getEffectiveEmployeeWorkingDays(employee, reportCompany?.workingDays);
      const todayKey = zonedDateKey(now, shiftTimezone);
      const joinedKey = rawEmployee.createdAt
        ? zonedDateKey(new Date(rawEmployee.createdAt), shiftTimezone)
        : "";
      const lastCountedDay = to < todayKey ? to : todayKey;
      for (let date = from; date <= lastCountedDay; date = addCalendarDay(date)) {
        if (dayPunchGroups.has(date) || (joinedKey && date < joinedKey)) continue;
        if (!scheduledDays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
        dayPunchGroups.add(date);
      }

      const requiredMinutes = getRequiredWorkMinutes(employee, reportCompany);
      const hoursPerDay = requiredMinutes > 0 ? requiredMinutes / 60 : 8;

      const approvedOvertimeDatesList: string[] = [];
      let totalLateDays = 0;
      let workedDaysCount = 0;
      let absentDaysCount = 0;
      let leaveDaysCount = 0;
      let paidLeaveHours = 0;
      let unpaidLeaveHours = 0;
      // One dated line per exception, for the remarks.
      const absentLines: string[] = [];
      const lateLines: string[] = [];
      const paidLeaveLines: string[] = [];
      const unpaidLeaveLines: string[] = [];
      const overtimeLines: string[] = [];

      const dailyIntervals: DailyIntervalRecord[] = [];

      const sortedDates = Array.from(dayPunchGroups).sort();

      for (const date of sortedDates) {
        const daySessions = sessionsByDate.get(date) || [];
        const firstIn = daySessions.find((session) => session.start.type === "in")?.start;
        const lastOut = [...daySessions]
          .reverse()
          .find((session) => session.end?.type === "out")?.end;

        const approvedLeave = getEmployeeApprovedLeaveForDate(employee, employeeLeaves, date);
        const holiday = getEmployeeHoliday(reportCompany, employee, date);
        const [shiftYear, shiftMonth, shiftDay] = date.split("-").map(Number);
        const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
        const effectiveWorkingDays = getEffectiveEmployeeWorkingDays(
          employee,
          reportCompany?.workingDays,
        );
        const isScheduledDay = effectiveWorkingDays.includes(shiftWeekday) && !holiday;
        const isOffShiftDay = !isScheduledDay;

        if (firstIn) {
          workedDaysCount++;
        } else if (isScheduledDay && !approvedLeave) {
          absentDaysCount++;
          absentLines.push(`${formatShortDate(date)} No punch`);
        }
        if (approvedLeave) {
          leaveDaysCount++;
        }
        // Leave over a weekend or holiday is not a working day taken off.
        if (approvedLeave && isScheduledDay) {
          const hours = leaveDayHours(approvedLeave, hoursPerDay);
          if (approvedLeave.paymentStatus === "unpaid") {
            unpaidLeaveHours += hours;
            unpaidLeaveLines.push(`${formatShortDate(date)} Unpaid Leave (${formatHours(hours)})`);
          } else {
            paidLeaveHours += hours;
            paidLeaveLines.push(`${formatShortDate(date)} Paid Leave (${formatHours(hours)})`);
          }
        }

        // One line per session, as the dashboard lists them.
        const sessions: PunchSessionRecord[] = daySessions.map((session) => {
          const finished = session.endedAt || session.switchedAt || null;
          const clock = (value: Date) =>
            formatInTimezone(value, session.timezone, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });
          const isOvertime =
            session.start.type === "extra_in" ||
            session.end?.type === "extra_out" ||
            (typeof session.end?.overtimeMinutes === "number" && session.end.overtimeMinutes > 0);
          return {
            inTime: clock(session.startedAt),
            ...(finished ? { outTime: clock(finished) } : {}),
            durationMinutes: Math.max(
              0,
              Math.floor(((finished ?? now).getTime() - session.startedAt.getTime()) / 60_000),
            ),
            isOvertime,
            isAuto: Boolean(session.end?.isAuto),
            type: session.unresolved
              ? "Missing Punch Out"
              : session.active
                ? "In Progress"
                : isOvertime
                  ? "Extra / OT"
                  : "Regular",
          };
        });

        // A session with no clock-out is not counted as worked: the dashboard
        // marks it for review, and so does this report.
        const resolved = daySessions.filter((session) => !session.unresolved);
        const regularMinutes = resolved.reduce(
          (sum, session) => sum + session.calc.normalWorkMinutes,
          0,
        );
        const unloggedBreak = resolved.reduce(
          (sum, session) => sum + session.calc.unloggedBreakMinutes,
          0,
        );
        const punchedBreakMinutes = daySessions.reduce(
          (sum, session) => sum + session.breakMinutes,
          0,
        );

        // Lateness is the late log's: the first clock-in of each shift, on the
        // schedule saved with it, and never on a day off, a holiday or leave.
        const judged = daySessions
          .map((session) => session.lateness)
          .filter((lateness): lateness is NonNullable<AttendanceSession["lateness"]> =>
            Boolean(lateness),
          );
        const countsLateness = isScheduledDay && !approvedLeave;
        const minutesLate = countsLateness
          ? judged.reduce((sum, lateness) => sum + lateness.minutes, 0)
          : 0;
        const isExcused = judged.some((lateness) => lateness.excused);

        if (minutesLate > 0) {
          totalLateDays++;
          lateLines.push(`${formatShortDate(date)} (${minutesLate} min late)`);
        }

        const isMissingPunchOut = daySessions.some((session) => session.unresolved);
        const isAutoPunchOut = Boolean(lastOut?.isAuto);

        const regHours = regularMinutes / 60;

        // Check all overtime requests for this employee on this day
        const dayOtRequests = overtimeRequests.filter(
          (r) =>
            (r.employeeId === employee.id ||
              (employee.authUid && r.employeeId === employee.authUid)) &&
            r.date === date,
        );

        const approvedDayOtMinutes = dayOtRequests
          .filter((r) => r.status === "approved")
          .reduce((sum, r) => sum + (r.overtimeMinutes || 0), 0);

        const pendingDayOtMinutes = dayOtRequests
          .filter((r) => r.status === "pending")
          .reduce((sum, r) => sum + (r.overtimeMinutes || 0), 0);

        const approvedOtHours = approvedDayOtMinutes / 60;
        const pendingOtHours = pendingDayOtMinutes / 60;

        if (approvedOtHours > 0) {
          const displayOtText =
            approvedOtHours >= 0.1
              ? `+${approvedOtHours.toFixed(1)}h`
              : `+${Math.round(approvedDayOtMinutes)}m`;
          approvedOvertimeDatesList.push(`${date} (${displayOtText})`);
          overtimeLines.push(`${approvedOtHours.toFixed(1)}hr OT ${formatShortDate(date)}`);
        }

        const isOvertimeApproved = approvedOtHours > 0;
        const isOvertimePending = pendingOtHours > 0;
        const isOvertimeRejected =
          dayOtRequests.some((r) => r.status === "rejected") && !isOvertimeApproved && !isOvertimePending;

        const overtimeStatus: "approved" | "pending" | "rejected" | "none" = isOvertimeApproved
          ? "approved"
          : isOvertimePending
            ? "pending"
            : isOvertimeRejected
              ? "rejected"
              : "none";

        const displayOtHours =
          approvedOtHours > 0 ? approvedOtHours : pendingOtHours > 0 ? pendingOtHours : 0;

        const scheduledShiftStr =
          employee.shiftStartTime && employee.shiftEndTime
            ? `${employee.shiftStartTime}–${employee.shiftEndTime}`
            : "09:00–17:00";

        const dayTimezone = daySessions[0]?.timezone || shiftTimezone;
        const punchInTimeStr = firstIn
          ? formatInTimezone(toDate(firstIn.timestamp) ?? now, dayTimezone, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          : undefined;

        const punchOutTimeStr = lastOut
          ? formatInTimezone(toDate(lastOut.timestamp) ?? now, dayTimezone, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          : undefined;

        dailyIntervals.push({
          date,
          dayOfWeek: getDayOfWeekStr(date),
          breakMinutes: punchedBreakMinutes,
          unloggedBreakMinutes: unloggedBreak,
          scheduledShift: scheduledShiftStr,
          punchInTime: punchInTimeStr,
          punchOutTime: punchOutTimeStr,
          firstInPunchId: firstIn?.id,
          lastOutPunchId: lastOut?.id,
          sessions,
          isMissingPunchOut,
          isAutoPunchOut,
          minutesLate,
          regularHours: Math.round(regHours * 10) / 10,
          rawOvertimeHours: Math.round(displayOtHours * 10) / 10,
          isOvertimeApproved,
          isOvertimeRejected,
          overtimeStatus,
          note:
            approvedLeave
              ? describeLeave(approvedLeave)
              : holiday?.name ||
                (unloggedBreak
                  ? `${formatWorkMinutes(unloggedBreak)} break deducted (none punched)`
                  : undefined),
          status: holiday
            ? "Holiday"
            : approvedLeave
              ? getLeaveLabel(approvedLeave)
              : isMissingPunchOut
                ? "Missing Punch Out"
                : isAutoPunchOut
                  ? "Auto Punched Out"
                  : isOffShiftDay && firstIn
                    ? "Off-day Shift"
                    : isExcused && minutesLate === 0
                      ? "Excused (Not Late)"
                      : minutesLate > 0
                        ? `Late (${minutesLate}m)`
                        : firstIn
                          ? "Complete"
                          : isScheduledDay
                            ? "Absent (no punch)"
                            : "Off / No punches",
        });
      }

      // Half days and timed breaks count for what they are, so "Paid Leave Used"
      // and the credit balance agree.
      const paidLeaveDays = Math.round((paidLeaveHours / hoursPerDay) * 100) / 100;
      const unpaidLeaveDays = Math.round((unpaidLeaveHours / hoursPerDay) * 100) / 100;

      // Remarks follow the client sheet: an attendance line, then a titled section
      // with one dated line for each absence, late start, leave and overtime.
      const isWeek = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) < 7 * 86_400_000;
      const sections: string[] = [];
      if (absentLines.length > 0) {
        sections.push(`Absent:\n${absentLines.join("\n")}`);
      } else if (workedDaysCount > 0) {
        sections.push(
          `Complete Attendance for the ${isWeek ? "Week" : "Period"}: ${formatCovered(from, to)}`,
        );
      }
      if (lateLines.length > 0) sections.push(`Late:\n${lateLines.join("\n")}`);
      if (paidLeaveLines.length > 0) sections.push(`Paid Leave:\n${paidLeaveLines.join("\n")}`);
      if (unpaidLeaveLines.length > 0) {
        sections.push(`Unpaid Leave:\n${unpaidLeaveLines.join("\n")}`);
      }
      if (overtimeLines.length > 0) sections.push(`Overtime:\n${overtimeLines.join("\n")}`);
      const initialRemarks = sections.join("\n\n");

      // Credits are the person's, not the client's, so every leave they filed counts.
      const leaveBalance = computeLeaveCreditBalance(rawEmployee, leaves, to, {
        hoursPerDay,
        isWorkingDay: (date) =>
          scheduledDays.includes(new Date(`${date}T12:00:00Z`).getUTCDay()) &&
          !getEmployeeHoliday(reportCompany, employee, date),
      });

      // Totals come from the days as listed, so the row and its inspect panel agree
      // to the tenth of an hour.
      const dayTotals = totalsFromDays(dailyIntervals);
      const reg = dayTotals.regularHours;
      const ot = dayTotals.overtimeHours;
      // Someone scheduled who never punched is exactly who an admin is looking
      // for, so keep the row and let its remarks say absent rather than drop it.
      const hasWork =
        reg > 0 ||
        ot > 0 ||
        paidLeaveDays > 0 ||
        unpaidLeaveDays > 0 ||
        leaveDaysCount > 0 ||
        workedDaysCount > 0 ||
        absentDaysCount > 0;

      // Nothing scheduled and nothing worked in this period: not this report's row.
      if (!hasWork) {
        continue;
      }

      rows.push({
        id: employee.id,
        isCustom: false,
        worked: true,
        employeeId: employee.id,
        employeeName: employee.name,
        employeeEmail: employee.email,
        department: departments.find((d) => d.id === employee.deptId)?.name || "General",
        role: employee.jobTitle || "V.A.",
        client: reportClientName(employee, rawEmployee, companyFilter, reportCompany, companies),
        status: rawEmployee.status === "inactive" ? "inactive" : "active",
        hoursPerDay,
        workedDays: workedDaysCount,
        absentDays: absentDaysCount,
        lateDays: totalLateDays,
        leaveDays: leaveDaysCount,
        regularHours: reg,
        overtimeHours: ot,
        pendingOvertimeHours: dayTotals.pendingOvertimeHours,
        overtimeDates: approvedOvertimeDatesList,
        paidLeaveDays,
        unpaidLeaveDays,
        paidLeaveUsed: formatDaysAndHours(paidLeaveDays, hoursPerDay),
        unpaidLeaveUsed: formatDaysAndHours(unpaidLeaveDays, hoursPerDay),
        availableLeaveCredit: leaveBalance
          ? formatDaysAndHours(leaveBalance.remaining, hoursPerDay, "0 Days (0 hours)")
          : "",
        remarks: initialRemarks,
        dailyIntervals,
      });
    }

    return rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}
