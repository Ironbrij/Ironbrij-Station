import type {
  Company,
  Department,
  Employee,
  LeaveRequest,
  OvertimeRequest,
  Punch,
} from "./types.ts";
import { COMPANY_ID } from "./types.ts";
import { computeDay, toDate, toMillis } from "./time.ts";
import { breakDurationMs } from "./work-breaks.ts";
import { calculateAttendanceSession, formatWorkMinutes } from "./attendance-calculation.ts";
import { computeLeaveCreditBalance } from "./leave-credits.ts";
import {
  computeEmployeeLateness,
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
  getEmployeeForCompany,
  getEmployeeLeavesForCompany,
  getEmployeePunchesForCompany,
  getRequiredWorkMinutes,
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
  /** Paid leave credit left after leave taken this year up to the period's end; null when none is set. */
  availableLeaveCredit: number | null;
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
}: ReportRowsInput): ReportRow[] {
    const rows: ReportRow[] = [];

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
      const dayPunchGroups = new Map<string, Punch[]>();

      // Shared scoping drops voided corrections and matches company aliases.
      for (const punch of getEmployeePunchesForCompany(
        punches,
        rawEmployee,
        companyFilter,
        reportCompany?.name,
      )) {
        if (!punch.timestamp) continue;
        const punchedAt = toDate(punch.timestamp);
        if (!punchedAt) continue;
        const date = punch.attendanceDate || punch.date || zonedDateKey(punchedAt, shiftTimezone);
        if (date < from || date > to) continue;
        if (!dayPunchGroups.has(date)) dayPunchGroups.set(date, []);
        dayPunchGroups.get(date)!.push(punch);
      }

      // Collect dates from leaves and holidays within range as well
      for (const date of getEmployeeHolidayDates(reportCompany, employee)) {
        if (date >= from && date <= to && !dayPunchGroups.has(date)) dayPunchGroups.set(date, []);
      }
      for (const date of getEmployeeApprovedLeaveDates(employee, employeeLeaves)) {
        if (date >= from && date <= to && !dayPunchGroups.has(date)) dayPunchGroups.set(date, []);
      }
      // A scheduled day with neither punch nor leave is exactly the day an admin
      // is asking about when a week reads as zero worked days. Seed every one so
      // it gets a row that says what happened instead of going missing.
      const scheduledDays = getEffectiveEmployeeWorkingDays(employee, reportCompany?.workingDays);
      const todayKey = zonedDateKey(new Date(), shiftTimezone);
      const joinedKey = rawEmployee.createdAt
        ? zonedDateKey(new Date(rawEmployee.createdAt), shiftTimezone)
        : "";
      const lastCountedDay = to < todayKey ? to : todayKey;
      for (let date = from; date <= lastCountedDay; date = addCalendarDay(date)) {
        if (dayPunchGroups.has(date) || (joinedKey && date < joinedKey)) continue;
        if (!scheduledDays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
        dayPunchGroups.set(date, []);
      }

      let totalRegularHours = 0;
      let totalApprovedOvertimeHours = 0;
      let totalPendingOvertimeHours = 0;
      const approvedOvertimeDatesList: string[] = [];
      let totalLateDays = 0;
      let workedDaysCount = 0;
      let absentDaysCount = 0;
      let leaveDaysCount = 0;

      const dailyIntervals: DailyIntervalRecord[] = [];

      const sortedDates = Array.from(dayPunchGroups.keys()).sort();

      for (const date of sortedDates) {
        const dayPunches = dayPunchGroups.get(date) || [];
        const sorted = [...dayPunches].sort(
          (a, b) => toMillis(a.timestamp) - toMillis(b.timestamp),
        );

        const firstIn = sorted.find((punch) => punch.type === "in");
        const lastOut = [...sorted].reverse().find((punch) => punch.type === "out");

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
        }
        if (approvedLeave) {
          leaveDaysCount++;
        }

        // Build individual punch sessions breakdown for the day
        const sessions: PunchSessionRecord[] = [];
        let currentIn: Punch | null = null;
        for (const p of sorted) {
          if (p.type === "in" || p.type === "extra_in") {
            currentIn = p;
          } else if ((p.type === "out" || p.type === "extra_out") && currentIn) {
            const inDate = toDate(currentIn.timestamp);
            const outDate = toDate(p.timestamp);
            if (inDate && outDate) {
              const durMins = Math.max(
                0,
                Math.floor((outDate.getTime() - inDate.getTime()) / 60_000),
              );
              const inTimeStr = formatInTimezone(inDate, shiftTimezone, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });
              const outTimeStr = formatInTimezone(outDate, shiftTimezone, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });
              const isOt =
                p.type === "extra_out" ||
                (typeof p.overtimeMinutes === "number" && p.overtimeMinutes > 0);
              sessions.push({
                inTime: inTimeStr,
                outTime: outTimeStr,
                durationMinutes: durMins,
                isOvertime: isOt,
                isAuto: Boolean(p.isAuto),
                type: p.type === "extra_out" ? "Extra / OT" : "Regular",
              });
            }
            currentIn = null;
          }
        }
        if (currentIn) {
          const inDate = toDate(currentIn.timestamp);
          if (inDate) {
            const inTimeStr = formatInTimezone(inDate, shiftTimezone, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });
            sessions.push({
              inTime: inTimeStr,
              durationMinutes: Math.max(0, Math.floor((Date.now() - inDate.getTime()) / 60_000)),
              isOvertime: currentIn.type === "extra_in",
              isAuto: false,
              type: "In Progress",
            });
          }
        }

        const sessionCalc = firstIn
          ? calculateAttendanceSession({
              employee,
              company: reportCompany,
          punchIn: toDate(firstIn.timestamp) ?? new Date(),
              punchOut: lastOut ? (toDate(lastOut.timestamp) ?? new Date()) : null,
              requiredWorkMinutes: getRequiredWorkMinutes(employee, reportCompany),
              isOffShiftDay,
            })
          : null;

        const isExcused = Boolean(firstIn?.isExcused);
        const lateness =
          firstIn && isScheduledDay
            ? computeEmployeeLateness(
                toDate(firstIn.timestamp) ?? new Date(),
                employee,
                getEffectiveLateGraceMinutes(reportCompany?.lateGraceMinutes),
                isExcused,
              )
            : null;

        if (lateness?.isLate) totalLateDays++;

        const isMissingPunchOut = Boolean(firstIn && !lastOut && sessionCalc?.missingPunchOut);
        const isAutoPunchOut = Boolean(lastOut?.isAuto);

        const regHours = sessionCalc ? sessionCalc.normalWorkMinutes / 60 : 0;
        const otHours = sessionCalc ? sessionCalc.overtimeMinutes / 60 : 0;

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

        totalRegularHours += regHours;
        if (approvedOtHours > 0) {
          totalApprovedOvertimeHours += approvedOtHours;
          const displayOtText =
            approvedOtHours >= 0.1
              ? `+${approvedOtHours.toFixed(1)}h`
              : `+${Math.round(approvedDayOtMinutes)}m`;
          approvedOvertimeDatesList.push(`${date} (${displayOtText})`);
        }
        if (pendingOtHours > 0) {
          totalPendingOvertimeHours += pendingOtHours;
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

        const punchInTimeStr = firstIn
          ? formatInTimezone(toDate(firstIn.timestamp) ?? new Date(), shiftTimezone, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          : undefined;

        const punchOutTimeStr = lastOut
          ? formatInTimezone(toDate(lastOut.timestamp) ?? new Date(), shiftTimezone, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          : undefined;

        // Lunch and other breaks the employee punched, plus any allowance charged
        // because none was punched: both explain the gap between clock and hours.
        const punchedBreakMinutes =
          firstIn && lastOut
            ? Math.round(
                breakDurationMs(
                  sorted,
                  toDate(firstIn.timestamp) ?? new Date(),
                  toDate(lastOut.timestamp) ?? new Date(),
                ) / 60_000,
              )
            : 0;

        dailyIntervals.push({
          date,
          dayOfWeek: getDayOfWeekStr(date),
          breakMinutes: punchedBreakMinutes,
          unloggedBreakMinutes: sessionCalc?.unloggedBreakMinutes || 0,
          scheduledShift: scheduledShiftStr,
          punchInTime: punchInTimeStr,
          punchOutTime: punchOutTimeStr,
          firstInPunchId: firstIn?.id,
          lastOutPunchId: lastOut?.id,
          sessions,
          isMissingPunchOut,
          isAutoPunchOut,
          minutesLate: lateness?.isLate ? lateness.minutes : 0,
          regularHours: Math.round(regHours * 10) / 10,
          rawOvertimeHours: Math.round(displayOtHours * 10) / 10,
          isOvertimeApproved,
          isOvertimeRejected,
          overtimeStatus,
          note:
            approvedLeave
              ? describeLeave(approvedLeave)
              : holiday?.name ||
                (sessionCalc?.unloggedBreakMinutes
                  ? `${formatWorkMinutes(sessionCalc.unloggedBreakMinutes)} break deducted (none punched)`
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
                    : isExcused
                      ? "Excused (Not Late)"
                      : lateness?.isLate
                        ? `Late (${lateness.minutes}m)`
                        : firstIn
                          ? "Complete"
                          : isScheduledDay
                            ? "Absent (no punch)"
                            : "Off / No punches",
        });
      }

      // Count Paid vs Unpaid Leaves within date bounds
      let paidLeaveDays = 0;
      let unpaidLeaveDays = 0;
      for (const leave of employeeLeaves) {
        const leaveDates = getEmployeeApprovedLeaveDates(employee, [leave]).filter(
          (d) => d >= from && d <= to,
        );
        if (leave.paymentStatus === "unpaid") {
          unpaidLeaveDays += leaveDates.length;
        } else {
          paidLeaveDays += leaveDates.length;
        }
      }

      // Zero worked days is only useful next to its reason, so the remarks open
      // with the leave and absence behind it.
      const leaveReasons = [
        ...new Set(
          employeeLeaves
            .filter((leave) =>
              getEmployeeApprovedLeaveDates(employee, [leave]).some((d) => d >= from && d <= to),
            )
            .map((leave) => leave.leaveCategory || "leave"),
        ),
      ];
      const notes: string[] = [];
      if (leaveDaysCount > 0) {
        notes.push(
          `On leave ${leaveDaysCount} day${leaveDaysCount > 1 ? "s" : ""}` +
            (leaveReasons.length ? ` (${leaveReasons.join(", ")})` : ""),
        );
      }
      if (absentDaysCount > 0) {
        notes.push(
          `Absent ${absentDaysCount} scheduled day${absentDaysCount > 1 ? "s" : ""}`,
        );
      }
      if (totalLateDays > 0) {
        notes.push(`Late on ${totalLateDays} shift${totalLateDays > 1 ? "s" : ""}`);
      }
      const initialRemarks = notes.join("; ");

      // Credits are the person's, not the client's, so every leave they filed counts.
      const leaveBalance = computeLeaveCreditBalance(rawEmployee, leaves, to, scheduledDays);

      const reg = Math.round(totalRegularHours * 10) / 10;
      const ot = Math.round(totalApprovedOvertimeHours * 10) / 10;
      // Someone scheduled who never punched is exactly who an admin is looking
      // for, so keep the row and let its remarks say absent rather than drop it.
      const hasWork =
        reg > 0 ||
        ot > 0 ||
        paidLeaveDays > 0 ||
        unpaidLeaveDays > 0 ||
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
        workedDays: workedDaysCount,
        absentDays: absentDaysCount,
        lateDays: totalLateDays,
        leaveDays: leaveDaysCount,
        regularHours: reg,
        overtimeHours: ot,
        pendingOvertimeHours: Math.round(totalPendingOvertimeHours * 10) / 10,
        overtimeDates: approvedOvertimeDatesList,
        paidLeaveDays,
        unpaidLeaveDays,
        availableLeaveCredit: leaveBalance?.remaining ?? null,
        remarks: initialRemarks,
        dailyIntervals,
      });
    }

    return rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}
