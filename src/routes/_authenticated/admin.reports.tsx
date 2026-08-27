import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, Timestamp, updateDoc } from "firebase/firestore";
import {
  Download,
  FileText,
  Search,
  Mail,
  Plus,
  Trash2,
  RotateCcw,
  Calendar,
  Building,
  UserCheck,
  Clock,
  Send,
  Eye,
  X,
  Sparkles,
  Info,
  Check,
  Ban,
  ChevronRight,
  AlertTriangle,
  CheckCheck,
  Sliders,
  ShieldCheck,
  ClockAlert,
} from "lucide-react";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type Department,
  type Employee,
  type LeaveRequest,
  type OvertimeRequest,
  type Punch,
} from "@/lib/types";
import { computeDay, toDate, toMillis } from "@/lib/time";
import { calculateAttendanceSession, formatWorkMinutes } from "@/lib/attendance-calculation";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getEffectiveEmployeeWorkingDays,
  getEffectiveLateGraceMinutes,
  getEmployeeApprovedLeaveForDate,
  getEmployeeApprovedLeaveDates,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getShiftTimezone,
  getLeaveLabel,
  zonedDateKey,
  zonedDateTimeToDate,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import {
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "@/lib/company-context";
import { companyEmailBranding } from "@/lib/email-branding";

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
  regularHours: number;
  rawOvertimeHours: number;
  isOvertimeApproved: boolean;
  status: string;
  note?: string;
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
  remarks: string;
  dailyIntervals: DailyIntervalRecord[];
}

type AttendanceRow = {
  key: string;
  employee: Employee;
  department: string;
  date: string;
  firstIn?: Punch;
  lastOut?: Punch;
  hours: number;
  status: string;
  minutesLate: number;
  isAutoPunchOut: boolean;
};

export const Route = createFileRoute("/_authenticated/admin/reports")({
  head: () => ({ meta: [{ title: "Reports & Client Delivery — SavyTimes Admin" }] }),
  component: ReportsPage,
});

function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function getDayOfWeekStr(dateStr: string): string {
  try {
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  } catch {
    return "";
  }
}

function ReportsPage() {
  const { company: authCompany, user } = useAuth();
  const currentMonth = new Date().toISOString().slice(0, 7);
  const initialBounds = monthBounds(currentMonth);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyFilter, setCompanyFilter] = useState("all");
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [overtimeRequests, setOvertimeRequests] = useState<OvertimeRequest[]>([]);
  const [month, setMonth] = useState(currentMonth);
  const [from, setFrom] = useState(initialBounds.from);
  const [to, setTo] = useState(initialBounds.to);
  const [departmentId, setDepartmentId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [search, setSearch] = useState("");

  // Report view mode: 'summary' = Interactive Company & VA Report, 'daily' = Raw Daily Logs
  const [viewMode, setViewMode] = useState<"summary" | "daily">("summary");

  // Editable summary rows
  const [reportRows, setReportRows] = useState<ReportRow[]>([]);
  const [hasCustomEdits, setHasCustomEdits] = useState(false);

  // Modals & Drawer state
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [isAddRowModalOpen, setIsAddRowModalOpen] = useState(false);
  const [selectedIntervalEmployee, setSelectedIntervalEmployee] = useState<ReportRow | null>(null);

  // Add row form state
  const [newRowData, setNewRowData] = useState<Omit<ReportRow, "id" | "dailyIntervals">>({
    employeeName: "",
    employeeEmail: "",
    worked: true,
    department: "General",
    role: "V.A.",
    workedDays: 0,
    absentDays: 0,
    lateDays: 0,
    leaveDays: 0,
    regularHours: 0,
    overtimeHours: 0,
    pendingOvertimeHours: 0,
    overtimeDates: [],
    paidLeaveDays: 0,
    unpaidLeaveDays: 0,
    remarks: "",
  });

  // Send Email State
  const [recipientEmailsText, setRecipientEmailsText] = useState("");
  const [clientName, setClientName] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [customNote, setCustomNote] = useState("");
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [showEmailPreview, setShowEmailPreview] = useState(false);

  useEffect(() => {
    const unsubscribers = [
      onSnapshot(collection(db(), "companies"), (snapshot) =>
        setCompanies(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Company, "id">) })),
        ),
      ),
      onSnapshot(collection(db(), "employees"), (snapshot) =>
        setEmployees(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Employee, "id">) })),
        ),
      ),
      onSnapshot(collection(db(), "departments"), (snapshot) =>
        setDepartments(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Department, "id">),
          })),
        ),
      ),
      onSnapshot(collection(db(), "leaveRequests"), (snapshot) =>
        setLeaves(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<LeaveRequest, "id">),
          })),
        ),
      ),
      onSnapshot(collection(db(), "punches"), (snapshot) =>
        setPunches(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) })),
        ),
      ),
      onSnapshot(collection(db(), "overtimeRequests"), (snapshot) =>
        setOvertimeRequests(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<OvertimeRequest, "id">),
          })),
        ),
      ),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  const selectedCompany = useMemo(() => {
    if (companyFilter === "all") return authCompany;
    return companies.find((c) => (c.id || COMPANY_ID) === companyFilter) || authCompany;
  }, [companyFilter, companies, authCompany]);

  const filteredEmployees = useMemo(
    () =>
      employees.filter((employee) => {
        if (companyFilter !== "all") {
          const matchCompany =
            employee.companyId === companyFilter ||
            employee.companyIds?.includes(companyFilter) ||
            (!employee.companyId && companyFilter === COMPANY_ID);
          if (!matchCompany) return false;
        }
        if (departmentId && employee.deptId !== departmentId) return false;
        if (employeeId && employee.id !== employeeId && employee.authUid !== employeeId)
          return false;
        if (
          search &&
          !`${employee.name} ${employee.email} ${employee.jobTitle || ""}`
            .toLowerCase()
            .includes(search.toLowerCase())
        )
          return false;
        return true;
      }),
    [employees, companyFilter, departmentId, employeeId, search],
  );

  // Compute Raw Day-by-Day Attendance Rows
  const dailyRows = useMemo(() => {
    const output: AttendanceRow[] = [];
    for (const rawEmployee of filteredEmployees) {
      const employee =
        companyFilter === "all" ? rawEmployee : getEmployeeForCompany(rawEmployee, companyFilter);
      const reportCompany =
        companyFilter === "all"
          ? authCompany
          : companies.find((item) => (item.id || COMPANY_ID) === companyFilter) || authCompany;
      const employeeLeaves = leaves.filter(
        (leave) =>
          companyFilter === "all" ||
          (leave.companyId || rawEmployee.companyIds?.[0] || rawEmployee.companyId) ===
            companyFilter,
      );
      const ids = new Set([employee.id, employee.authUid].filter(Boolean));
      const shiftTimezone = getShiftTimezone(employee);
      const groups = new Map<string, Punch[]>();
      for (const punch of punches) {
        if (!ids.has(punch.employeeId) || !punch.timestamp) continue;
        if (companyFilter !== "all" && getPunchCompanyId(punch, rawEmployee) !== companyFilter)
          continue;
        const punchedAt = toDate(punch.timestamp);
        if (!punchedAt) continue;
        const date = punch.attendanceDate || punch.date || zonedDateKey(punchedAt, shiftTimezone);
        if (date < from || date > to) continue;
        if (!groups.has(date)) groups.set(date, []);
        groups.get(date)!.push(punch);
      }
      for (const date of getEmployeeHolidayDates(reportCompany, employee)) {
        if (date >= from && date <= to && !groups.has(date)) groups.set(date, []);
      }
      for (const date of getEmployeeApprovedLeaveDates(employee, employeeLeaves)) {
        if (date >= from && date <= to && !groups.has(date)) groups.set(date, []);
      }
      for (const [date, dayPunches] of groups) {
        const sorted = [...dayPunches].sort(
          (a, b) => toMillis(a.timestamp) - toMillis(b.timestamp),
        );
        const firstIn = sorted.find((punch) => punch.type === "in");
        const lastOut = [...sorted].reverse().find((punch) => punch.type === "out");
        const calculation = computeDay(sorted, { employee, company: reportCompany });
        const approvedLeave = getEmployeeApprovedLeaveForDate(employee, employeeLeaves, date);
        const holiday = getEmployeeHoliday(reportCompany, employee, date);
        const [shiftYear, shiftMonth, shiftDay] = date.split("-").map(Number);
        const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
        const effectiveWorkingDays = getEffectiveEmployeeWorkingDays(employee, reportCompany?.workingDays);
        const isScheduledDay = effectiveWorkingDays.includes(shiftWeekday) && !holiday;
        const isOffShiftDay = !isScheduledDay;

        const late = firstIn && isScheduledDay
          ? computeEmployeeLateness(
              toDate(firstIn.timestamp) ?? new Date(),
              employee,
              getEffectiveLateGraceMinutes(reportCompany?.lateGraceMinutes),
            )
          : null;
        const isAutoPunchOut = Boolean(lastOut?.isAuto);

        const dayOtRequests = overtimeRequests.filter(
          (r) =>
            (r.employeeId === employee.id || (employee.authUid && r.employeeId === employee.authUid)) &&
            r.date === date,
        );
        const approvedDayOtMinutes = dayOtRequests
          .filter((r) => r.status === "approved")
          .reduce((sum, r) => sum + (r.overtimeMinutes || 0), 0);
        const isOvertimeApproved = approvedDayOtMinutes > 0;
        const effectiveHours =
          calculation.regularHours + (approvedDayOtMinutes > 0 ? approvedDayOtMinutes / 60 : 0);

        output.push({
          key: `${employee.id}-${date}`,
          employee,
          department: departments.find((item) => item.id === employee.deptId)?.name || "General",
          date,
          firstIn,
          lastOut,
          hours: Math.round(effectiveHours * 10) / 10,
          status: holiday
            ? "Holiday"
            : approvedLeave
              ? getLeaveLabel(approvedLeave)
              : isOffShiftDay && firstIn
                ? "Off-day Shift"
                : !firstIn
                  ? "No punch in"
                  : !lastOut
                    ? "Still punched in"
                    : isAutoPunchOut
                      ? late?.isLate
                        ? "Auto punched out · Late"
                        : "Auto punched out"
                      : late?.isLate
                        ? "Late"
                        : "On time",
          minutesLate: !holiday && !approvedLeave && late?.isLate ? late.minutes : 0,
          isAutoPunchOut,
        });
      }
    }
    return output.sort(
      (a, b) => b.date.localeCompare(a.date) || a.employee.name.localeCompare(b.employee.name),
    );
  }, [
    filteredEmployees,
    punches,
    leaves,
    overtimeRequests,
    departments,
    from,
    to,
    authCompany,
    companies,
    companyFilter,
  ]);

  // Compute Auto-Aggregated Report Rows & Daily Intervals per Employee/VA
  const computedSummaryRows = useMemo(() => {
    const rows: ReportRow[] = [];

    for (const rawEmployee of filteredEmployees) {
      const employee =
        companyFilter === "all" ? rawEmployee : getEmployeeForCompany(rawEmployee, companyFilter);
      const reportCompany =
        companyFilter === "all"
          ? authCompany
          : companies.find((item) => (item.id || COMPANY_ID) === companyFilter) || authCompany;

      const employeeLeaves = leaves.filter(
        (leave) =>
          leave.employeeId === employee.id &&
          leave.status === "approved" &&
          (companyFilter === "all" ||
            (leave.companyId || rawEmployee.companyIds?.[0] || rawEmployee.companyId) ===
              companyFilter),
      );

      const ids = new Set([employee.id, employee.authUid].filter(Boolean));
      const shiftTimezone = getShiftTimezone(employee);
      const dayPunchGroups = new Map<string, Punch[]>();

      for (const punch of punches) {
        if (!ids.has(punch.employeeId) || !punch.timestamp) continue;
        if (companyFilter !== "all" && getPunchCompanyId(punch, rawEmployee) !== companyFilter)
          continue;
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
        const effectiveWorkingDays = getEffectiveEmployeeWorkingDays(employee, reportCompany?.workingDays);
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
              const durMins = Math.max(0, Math.floor((outDate.getTime() - inDate.getTime()) / 60_000));
              const inTimeStr = formatInTimezone(inDate, shiftTimezone, { hour: "2-digit", minute: "2-digit", hour12: false });
              const outTimeStr = formatInTimezone(outDate, shiftTimezone, { hour: "2-digit", minute: "2-digit", hour12: false });
              const isOt = p.type === "extra_out" || (typeof p.overtimeMinutes === "number" && p.overtimeMinutes > 0);
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
            const inTimeStr = formatInTimezone(inDate, shiftTimezone, { hour: "2-digit", minute: "2-digit", hour12: false });
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
              punchOut: lastOut ? toDate(lastOut.timestamp) ?? new Date() : null,
              requiredWorkMinutes: getRequiredWorkMinutes(employee, reportCompany),
              isOffShiftDay,
            })
          : null;

        const lateness = firstIn && isScheduledDay
          ? computeEmployeeLateness(
              toDate(firstIn.timestamp) ?? new Date(),
              employee,
              getEffectiveLateGraceMinutes(reportCompany?.lateGraceMinutes),
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
            (r.employeeId === employee.id || (employee.authUid && r.employeeId === employee.authUid)) &&
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

        dailyIntervals.push({
          date,
          dayOfWeek: getDayOfWeekStr(date),
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
                    : lateness?.isLate
                      ? `Late (${lateness.minutes}m)`
                      : firstIn
                        ? "Complete"
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

      let initialRemarks = "";
      if (totalLateDays > 0) {
        initialRemarks = `Late on ${totalLateDays} shift${totalLateDays > 1 ? "s" : ""}`;
      }

      const reg = Math.round(totalRegularHours * 10) / 10;
      const ot = Math.round(totalApprovedOvertimeHours * 10) / 10;
      const hasWork =
        reg > 0 || ot > 0 || paidLeaveDays > 0 || unpaidLeaveDays > 0 || workedDaysCount > 0;

      // If the employee did not work and had no active leave during this period, exclude them from report
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
        remarks: initialRemarks,
        dailyIntervals,
      });
    }

    return rows.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  }, [
    filteredEmployees,
    punches,
    leaves,
    overtimeRequests,
    departments,
    from,
    to,
    authCompany,
    companies,
    companyFilter,
  ]);

  // Sync computedSummaryRows to reportRows unless user has custom edits
  useEffect(() => {
    if (!hasCustomEdits) {
      setReportRows(computedSummaryRows);
    }
  }, [computedSummaryRows, hasCustomEdits]);

  // Reset custom edits back to computed values
  function handleResetToCalculated() {
    setReportRows(computedSummaryRows);
    setHasCustomEdits(false);
    setSelectedIntervalEmployee(null);
    toast.success("Reset report back to live calculated data.");
  }

  // Update specific row column inline
  function handleUpdateRowField(id: string, field: keyof ReportRow, value: unknown) {
    setHasCustomEdits(true);
    setReportRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        return { ...row, [field]: value };
      }),
    );
  }

  // Toggle worked state for an employee
  function handleToggleWorked(id: string) {
    setHasCustomEdits(true);
    setReportRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        const nextWorked = !row.worked;
        return {
          ...row,
          worked: nextWorked,
          ...(nextWorked === false
            ? {
                regularHours: 0,
                overtimeHours: 0,
                overtimeDates: [],
                remarks: row.remarks ? row.remarks : "Did not work during this period",
              }
            : {}),
        };
      }),
    );
  }

  // Delete row
  function handleDeleteRow(id: string) {
    setHasCustomEdits(true);
    setReportRows((prev) => prev.filter((row) => row.id !== id));
    if (selectedIntervalEmployee?.id === id) {
      setSelectedIntervalEmployee(null);
    }
    toast.success("Removed row from current report.");
  }

  // Add custom row
  function handleAddCustomRow() {
    if (!newRowData.employeeName.trim()) {
      return toast.error("Please enter the employee or VA name");
    }
    const newRow: ReportRow = {
      ...newRowData,
      id: `custom-${Date.now()}`,
      isCustom: true,
      worked: true,
      workedDays: Number(newRowData.workedDays) || 0,
      absentDays: Number(newRowData.absentDays) || 0,
      lateDays: Number(newRowData.lateDays) || 0,
      leaveDays: Number(newRowData.leaveDays) || 0,
      regularHours: Number(newRowData.regularHours) || 0,
      overtimeHours: Number(newRowData.overtimeHours) || 0,
      pendingOvertimeHours: 0,
      paidLeaveDays: Number(newRowData.paidLeaveDays) || 0,
      unpaidLeaveDays: Number(newRowData.unpaidLeaveDays) || 0,
      dailyIntervals: [],
    };
    setHasCustomEdits(true);
    setReportRows((prev) => [newRow, ...prev]);
    setIsAddRowModalOpen(false);
    setNewRowData({
      employeeName: "",
      employeeEmail: "",
      worked: true,
      department: "General",
      role: "V.A.",
      workedDays: 0,
      absentDays: 0,
      lateDays: 0,
      leaveDays: 0,
      regularHours: 0,
      overtimeHours: 0,
      pendingOvertimeHours: 0,
      overtimeDates: [],
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
      remarks: "",
    });
    toast.success("Added new person to report.");
  }

  // Reset custom edits to computed real-time calculations
  function handleResetToCalculated() {
    setReportRows(computedSummaryRows);
    setHasCustomEdits(false);
    toast.success("Reset table to real-time calculated hours.");
  }

  // --------------------------------------------------------------------------
  // DAILY INTERVAL & OVERTIME APPROVAL HANDLERS
  // --------------------------------------------------------------------------

  // Update a single day's interval record for an employee
  function handleUpdateDayInterval(
    employeeRowId: string,
    date: string,
    updates: Partial<DailyIntervalRecord>,
  ) {
    setHasCustomEdits(true);
    setReportRows((prev) =>
      prev.map((row) => {
        if (row.id !== employeeRowId) return row;

        const updatedIntervals = row.dailyIntervals.map((day) => {
          if (day.date !== date) return day;
          return { ...day, ...updates };
        });

        // Recompute totals from updated intervals
        let newReg = 0;
        let newApprovedOt = 0;
        let newPendingOt = 0;
        const newOtDates: string[] = [];

        for (const day of updatedIntervals) {
          newReg += day.regularHours;
          if (day.rawOvertimeHours > 0) {
            if (day.isOvertimeApproved) {
              newApprovedOt += day.rawOvertimeHours;
              newOtDates.push(`${day.date} (+${day.rawOvertimeHours.toFixed(1)}h)`);
            } else {
              newPendingOt += day.rawOvertimeHours;
            }
          }
        }

        const updatedRow: ReportRow = {
          ...row,
          dailyIntervals: updatedIntervals,
          regularHours: Math.round(newReg * 10) / 10,
          overtimeHours: Math.round(newApprovedOt * 10) / 10,
          pendingOvertimeHours: Math.round(newPendingOt * 10) / 10,
          overtimeDates: newOtDates,
          worked: newReg > 0 || newApprovedOt > 0,
        };

        if (selectedIntervalEmployee?.id === employeeRowId) {
          setSelectedIntervalEmployee(updatedRow);
        }

        return updatedRow;
      }),
    );
  }

  // Fix Missed Punch Out on a day (sets standard shift end time from employee profile)
  async function handleFixMissedPunchOut(employeeRowId: string, date: string) {
    const emp = filteredEmployees.find((e) => e.id === employeeRowId || e.authUid === employeeRowId);
    const defaultEndTime = emp?.shiftEndTime || "17:00";
    const empTz = emp ? getShiftTimezone(emp) : "Australia/Sydney";
    const fixedOutDate = zonedDateTimeToDate(date, defaultEndTime, empTz);

    try {
      const fixedPunchRef = await addDoc(collection(db(), "punches"), {
        employeeId: emp?.id || employeeRowId,
        employeeName: emp?.name || selectedIntervalEmployee?.employeeName || "Employee",
        companyId: companyFilter === "all" ? (emp?.companyId || COMPANY_ID) : companyFilter,
        companyName: selectedCompany?.name || "Company",
        date,
        attendanceDate: date,
        type: "out",
        timestamp: Timestamp.fromDate(fixedOutDate),
        source: "app",
        isAuto: false,
        isAdminFix: true,
        adminFixedBy: user?.email || "admin",
        adminFixedAt: new Date().toISOString(),
        shiftTimezone: empTz,
        attendanceStatus: "complete",
      });

      handleUpdateDayInterval(employeeRowId, date, {
        punchOutTime: defaultEndTime,
        lastOutPunchId: fixedPunchRef.id,
        isMissingPunchOut: false,
        status: "Punch Out Fixed by Admin",
      });
      toast.success(`Fixed punch out for ${date} (set to ${defaultEndTime})`);
    } catch (err) {
      console.error("Failed to fix punch out:", err);
      toast.error("Could not fix punch out: " + (err as Error).message);
    }
  }

  // Summary KPI Totals (calculated live from current edited table)
  const reportTotals = useMemo(() => {
    return reportRows.reduce(
      (acc, r) => {
        acc.totalHours += Number(r.regularHours) || 0;
        acc.totalOvertime += Number(r.overtimeHours) || 0;
        acc.totalPendingOvertime += Number(r.pendingOvertimeHours) || 0;
        acc.totalPaidLeave += Number(r.paidLeaveDays) || 0;
        acc.totalUnpaidLeave += Number(r.unpaidLeaveDays) || 0;
        if (r.worked) acc.totalWorkedCount++;
        return acc;
      },
      {
        totalHours: 0,
        totalOvertime: 0,
        totalPendingOvertime: 0,
        totalPaidLeave: 0,
        totalUnpaidLeave: 0,
        totalEmployees: reportRows.length,
        totalWorkedCount: 0,
      },
    );
  }, [reportRows]);

  const periodLabel = `${from} to ${to}`;
  const companyDisplayName =
    companyFilter === "all" ? "All Companies" : selectedCompany?.name || "Company";

  // Open Send Modal with Pre-filled Defaults
  function openSendEmailModal() {
    setEmailSubject(`${companyDisplayName} Attendance & Work Report (${periodLabel})`);
    setClientName(selectedCompany?.name || "");
    setRecipientEmailsText("");
    setCustomNote("");
    setShowEmailPreview(false);
    setIsSendModalOpen(true);
  }

  // Dispatch Email via Backend API
  async function handleSendReportEmail() {
    if (!recipientEmailsText.trim()) {
      return toast.error("Please enter at least one recipient email address.");
    }

    const emailList = recipientEmailsText
      .split(/[,;\n]+/)
      .map((e) => e.trim())
      .filter((e) => Boolean(e));

    if (emailList.length === 0) {
      return toast.error("Please enter valid recipient email addresses.");
    }

    setIsSendingEmail(true);
    try {
      const idToken = await user?.getIdToken();
      if (!idToken) {
        toast.error("Please ensure you are logged in as admin.");
        setIsSendingEmail(false);
        return;
      }

      const response = await fetch("/api/send-report", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          recipientEmails: emailList,
          subject: emailSubject,
          customMessage: customNote,
          company: companyEmailBranding(selectedCompany),
          companyName: companyDisplayName,
          clientName: clientName.trim(),
          periodLabel,
          summary: reportTotals,
          rows: reportRows.map((r) => {
            const leaveDates = (r.dailyIntervals || [])
              .filter(
                (d) =>
                  d.status &&
                  (d.status.toLowerCase().includes("leave") ||
                    d.status.toLowerCase().includes("vacation") ||
                    d.status.toLowerCase().includes("sick")),
              )
              .map((d) => `${d.date} (${d.status})`);

            return {
              employeeName: r.employeeName,
              employeeEmail: r.employeeEmail,
              role: r.role,
              department: r.department,
              workedDays: r.workedDays || 0,
              regularHours: Number(r.regularHours) || 0,
              overtimeHours: Number(r.overtimeHours) || 0,
              overtimeDates: r.overtimeDates || [],
              paidLeaveDays: Number(r.paidLeaveDays) || 0,
              unpaidLeaveDays: Number(r.unpaidLeaveDays) || 0,
              leaveDates,
              remarks: r.remarks,
            };
          }),
        }),
      });

      const data = (await response.json()) as {
        ok: boolean;
        error?: string;
        recipientCount?: number;
      };

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Failed to send report email");
      }

      toast.success(
        `Report successfully dispatched to ${emailList.length} recipient${
          emailList.length > 1 ? "s" : ""
        }!`,
      );
      setIsSendModalOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send report email.");
    } finally {
      setIsSendingEmail(false);
    }
  }

  // Export Current Reviewed/Edited Table to CSV
  function exportSummaryCsv() {
    if (!reportRows.length) return toast.error("No report rows available to export.");
    const data = reportRows.map((row) => ({
      "Employee / V.A.": row.employeeName,
      "Worked / Active": row.worked ? "Yes" : "No",
      Email: row.employeeEmail || "",
      Role: row.role,
      Department: row.department,
      "Worked Days": row.workedDays || 0,
      "Absent Days": row.absentDays || 0,
      "Leave Days": row.leaveDays || 0,
      "Late Days": row.lateDays || 0,
      "Regular Hours": Number(row.regularHours).toFixed(1),
      "Accepted Overtime Hours": Number(row.overtimeHours).toFixed(1),
      "Overtime Dates": (row.overtimeDates || []).join("; "),
      "Paid Leave (Days)": row.paidLeaveDays,
      "Unpaid Leave (Days)": row.unpaidLeaveDays,
      Remarks: row.remarks,
    }));
    const blob = new Blob([Papa.unparse(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `report_${companyDisplayName.replace(/\s+/g, "_")}_${from}_to_${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Downloaded Report CSV");
  }

  // Export Current Reviewed/Edited Table to PDF
  function exportSummaryPdf() {
    if (!reportRows.length) return toast.error("No report rows available to export.");
    const pdf = new jsPDF({ orientation: "landscape" });

    pdf.setFontSize(16);
    pdf.setTextColor(15, 23, 42);
    pdf.text(`${companyDisplayName} — Attendance & Hours Report`, 14, 16);

    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Period: ${periodLabel} · Total Team Members: ${reportRows.length}`, 14, 22);

    let y = 32;
    pdf.setFont("helvetica", "bold");
    pdf.setFillColor(241, 245, 249);
    pdf.rect(14, y - 5, 268, 8, "F");
    pdf.setTextColor(30, 41, 59);
    pdf.text("Employee / V.A.", 16, y);
    pdf.text("Worked", 60, y);
    pdf.text("Dept / Role", 80, y);
    pdf.text("Reg Hours", 125, y);
    pdf.text("Overtime & Dates", 155, y);
    pdf.text("Paid / Unpaid", 205, y);
    pdf.text("Remarks", 235, y);

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8.5);

    for (const row of reportRows) {
      y += 8;
      if (y > 190) {
        pdf.addPage();
        y = 20;
      }
      pdf.setTextColor(15, 23, 42);
      pdf.text(row.employeeName.slice(0, 20), 16, y);
      pdf.setTextColor(row.worked ? 22 : 220, row.worked ? 163 : 38, row.worked ? 74 : 38);
      pdf.text(row.worked ? "Yes" : "No", 60, y);
      pdf.setTextColor(100, 116, 139);
      pdf.text(`${row.department} (${row.role})`.slice(0, 20), 80, y);
      pdf.setTextColor(2, 132, 199);
      pdf.text(`${Number(row.regularHours).toFixed(1)}h`, 125, y);
      pdf.setTextColor(217, 119, 6);
      const otDates = row.overtimeDates || [];
      const otText =
        row.overtimeHours > 0
          ? `+${Number(row.overtimeHours).toFixed(1)}h ${otDates.length ? `(${otDates.length} dates)` : ""}`
          : "—";
      pdf.text(otText, 155, y);
      pdf.setTextColor(30, 41, 59);
      pdf.text(`Paid: ${row.paidLeaveDays}d | Unpaid: ${row.unpaidLeaveDays}d`, 205, y);
      pdf.setTextColor(71, 85, 105);
      pdf.text((row.remarks || "—").slice(0, 25), 235, y);
    }

    pdf.save(`report_${companyDisplayName.replace(/\s+/g, "_")}_${from}_to_${to}.pdf`);
    toast.success("Downloaded Report PDF");
  }

  // Export Daily Logs to CSV
  function exportDailyCsv() {
    if (!dailyRows.length) return toast.error("No daily logs available to export.");
    const data = dailyRows.map((row) => ({
      Date: row.date,
      Employee: row.employee.name,
      Email: row.employee.email || "",
      Department: row.department,
      "Punch In": row.firstIn
        ? formatInTimezone(
            toDate(row.firstIn.timestamp) ?? new Date(),
            getEmployeeTimezone(row.employee),
          )
        : "—",
      "Punch Out": row.lastOut
        ? formatInTimezone(
            toDate(row.lastOut.timestamp) ?? new Date(),
            getEmployeeTimezone(row.employee),
          )
        : "—",
      "Hours Worked": Number(row.hours).toFixed(1),
      Status: row.status,
      "Minutes Late": row.minutesLate,
      "Auto Punch-Out": row.isAutoPunchOut ? "Yes" : "No",
    }));
    const blob = new Blob([Papa.unparse(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `daily_logs_${companyDisplayName.replace(/\s+/g, "_")}_${from}_to_${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Downloaded Daily Logs CSV");
  }

  // Export Daily Logs to PDF
  function exportDailyPdf() {
    if (!dailyRows.length) return toast.error("No daily logs available to export.");
    const pdf = new jsPDF({ orientation: "landscape" });

    pdf.setFontSize(16);
    pdf.setTextColor(15, 23, 42);
    pdf.text(`${companyDisplayName} — Daily Punch Logs`, 14, 16);

    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Period: ${periodLabel} · Total Log Entries: ${dailyRows.length}`, 14, 22);

    let y = 32;
    pdf.setFont("helvetica", "bold");
    pdf.setFillColor(241, 245, 249);
    pdf.rect(14, y - 5, 268, 8, "F");
    pdf.setTextColor(30, 41, 59);
    pdf.text("Date", 16, y);
    pdf.text("Employee", 45, y);
    pdf.text("Department", 95, y);
    pdf.text("Punch In", 135, y);
    pdf.text("Punch Out", 175, y);
    pdf.text("Hours", 215, y);
    pdf.text("Status", 235, y);

    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8.5);

    for (const row of dailyRows) {
      y += 8;
      if (y > 190) {
        pdf.addPage();
        y = 20;
      }
      const tz = getEmployeeTimezone(row.employee);
      pdf.setTextColor(15, 23, 42);
      pdf.text(row.date, 16, y);
      pdf.text(row.employee.name.slice(0, 20), 45, y);
      pdf.setTextColor(100, 116, 139);
      pdf.text(row.department.slice(0, 18), 95, y);
      pdf.text(
        row.firstIn ? formatInTimezone(toDate(row.firstIn.timestamp) ?? new Date(), tz) : "—",
        135,
        y,
      );
      pdf.text(
        row.lastOut ? formatInTimezone(toDate(row.lastOut.timestamp) ?? new Date(), tz) : "—",
        175,
        y,
      );
      pdf.setTextColor(2, 132, 199);
      pdf.text(`${Number(row.hours).toFixed(1)}h`, 215, y);
      pdf.setTextColor(30, 41, 59);
      pdf.text(row.status.slice(0, 15), 235, y);
    }

    pdf.save(`daily_logs_${companyDisplayName.replace(/\s+/g, "_")}_${from}_to_${to}.pdf`);
    toast.success("Downloaded Daily Logs PDF");
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-16">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-foreground flex items-center gap-2.5">
            <FileText className="h-6 w-6 text-primary" /> Reports & Client Delivery
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Inspect daily intervals, fix missed punch-outs, accept overtime, and email automated
            reports to clients.
          </p>
        </div>

        {/* View Mode Switcher */}
        <div className="flex items-center gap-1.5 p-1 bg-secondary/70 border rounded-lg self-start sm:self-auto">
          <button
            onClick={() => setViewMode("summary")}
            className={`px-3.5 py-1.5 rounded-md text-xs font-bold transition-all ${
              viewMode === "summary"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Company & V.A. Report
          </button>
          <button
            onClick={() => setViewMode("daily")}
            className={`px-3.5 py-1.5 rounded-md text-xs font-bold transition-all ${
              viewMode === "daily"
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Raw Daily Punch Logs
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="rounded-xl border bg-card p-4 shadow-sm space-y-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-6 gap-3">
          <label className="text-xs font-bold text-muted-foreground">
            <span className="flex items-center gap-1 mb-1">
              <Building className="h-3.5 w-3.5 text-primary" /> Target Company
            </span>
            <select
              value={companyFilter}
              onChange={(event) => {
                setCompanyFilter(event.target.value);
                setEmployeeId("");
                setHasCustomEdits(false);
              }}
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground font-semibold"
            >
              <option value="all">All Companies ({companies.length})</option>
              {companies.map((c) => (
                <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                  {c.name} {c.isMain ? "(Main)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-bold text-muted-foreground">
            <span className="flex items-center gap-1 mb-1">
              <Calendar className="h-3.5 w-3.5 text-primary" /> Month Preset
            </span>
            <input
              type="month"
              value={month}
              onChange={(event) => {
                const value = event.target.value;
                setMonth(value);
                const bounds = monthBounds(value);
                setFrom(bounds.from);
                setTo(bounds.to);
                setHasCustomEdits(false);
              }}
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>

          <label className="text-xs font-bold text-muted-foreground">
            <span className="block mb-1">From Date</span>
            <input
              type="date"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
                setHasCustomEdits(false);
              }}
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>

          <label className="text-xs font-bold text-muted-foreground">
            <span className="block mb-1">To Date</span>
            <input
              type="date"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
                setHasCustomEdits(false);
              }}
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>

          <label className="text-xs font-bold text-muted-foreground">
            <span className="block mb-1">Department</span>
            <select
              value={departmentId}
              onChange={(event) => {
                setDepartmentId(event.target.value);
                setEmployeeId("");
              }}
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="">All departments</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-bold text-muted-foreground">
            <span className="block mb-1">Employee / V.A.</span>
            <select
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
              className="block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="">All employees</option>
              {employees
                .filter((emp) => !departmentId || emp.deptId === departmentId)
                .map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
            </select>
          </label>
        </div>

        {/* Action Controls & Search */}
        <div className="flex flex-col sm:flex-row gap-3 pt-1">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by employee, email, role, remarks…"
              className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm"
            />
          </div>

          <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
            {viewMode === "summary" && (
              <>
                <button
                  onClick={() => setIsAddRowModalOpen(true)}
                  className="rounded-md border border-primary/20 bg-primary/5 hover:bg-primary/10 text-primary px-3.5 py-2 text-xs font-bold flex items-center justify-center gap-1.5 transition"
                  title="Add custom person or manual hours row"
                >
                  <Plus className="h-4 w-4" /> Add Person
                </button>

                {hasCustomEdits && (
                  <button
                    onClick={handleResetToCalculated}
                    className="rounded-md border px-3 py-2 text-xs font-bold text-muted-foreground hover:text-foreground flex items-center gap-1.5"
                    title="Revert all edits back to live calculated punches"
                  >
                    <RotateCcw className="h-3.5 w-3.5" /> Reset Calculations
                  </button>
                )}

                <button
                  onClick={openSendEmailModal}
                  className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition"
                >
                  <Mail className="h-4 w-4" /> Send Report to Them
                </button>
              </>
            )}

            <button
              onClick={viewMode === "summary" ? exportSummaryCsv : exportDailyCsv}
              className="rounded-md border px-3.5 py-2 text-xs font-bold text-foreground hover:bg-secondary flex items-center justify-center gap-1.5"
            >
              <Download className="h-4 w-4 text-muted-foreground" /> CSV
            </button>
            <button
              onClick={viewMode === "summary" ? exportSummaryPdf : exportDailyPdf}
              className="rounded-md bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90 flex items-center justify-center gap-1.5"
            >
              <FileText className="h-4 w-4" /> PDF
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            <UserCheck className="h-3.5 w-3.5 text-primary" /> Active / Total
          </div>
          <div className="mt-1 text-2xl font-black text-foreground">
            {reportTotals.totalWorkedCount}
            <span className="text-sm font-semibold text-muted-foreground">
              /{reportTotals.totalEmployees}
            </span>
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            <Clock className="h-3.5 w-3.5 text-sky-600" /> Regular Hours
          </div>
          <div className="mt-1 text-2xl font-black text-sky-600">
            {reportTotals.totalHours.toFixed(1)}h
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 text-amber-600" /> Accepted Overtime
          </div>
          <div className="mt-1 text-2xl font-black text-amber-600">
            {reportTotals.totalOvertime > 0 ? `+${reportTotals.totalOvertime.toFixed(1)}h` : "0.0h"}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Paid Leaves
          </div>
          <div className="mt-1 text-2xl font-black text-emerald-600">
            {reportTotals.totalPaidLeave}d
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Unpaid Leaves
          </div>
          <div className="mt-1 text-2xl font-black text-rose-600">
            {reportTotals.totalUnpaidLeave}d
          </div>
        </div>
      </div>

      {/* Main Table View */}
      {viewMode === "summary" ? (
        <div className="rounded-xl border bg-card overflow-hidden shadow-sm">
          {/* Informational Banner */}
          <div className="px-4 py-3 bg-blue-50 dark:bg-blue-950/40 border-b border-blue-200 dark:border-blue-800 flex items-center justify-between text-xs text-blue-900 dark:text-blue-200 gap-2">
            <div className="flex items-center gap-2 font-medium">
              <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <span>
                <strong>Spreadsheet & Interval Inspection:</strong> Click on{" "}
                <span className="font-bold text-primary underline">Inspect Daily Intervals</span> on
                any employee to see day-by-day hours, fix missed punch-outs, and review
                overtimes.
              </span>
            </div>
            {hasCustomEdits && (
              <div className="flex items-center gap-2 shrink-0">
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-700">
                  Custom Edits Active
                </span>
                <button
                  type="button"
                  onClick={handleResetToCalculated}
                  className="px-2 py-0.5 rounded bg-secondary hover:bg-muted text-foreground text-[11px] font-bold border transition"
                  title="Discard manual edits and recalculate from raw attendance punches"
                >
                  Reset to Calculated
                </button>
              </div>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="bg-secondary/70 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3 font-bold w-[70px] text-center">Worked?</th>
                  <th className="p-3 font-bold min-w-[170px]">Employee / V.A.</th>
                  <th className="p-3 font-bold min-w-[130px]">Role / Title</th>
                  <th className="p-3 font-bold w-[120px] text-right">Regular Hours</th>
                  <th className="p-3 font-bold min-w-[130px] text-right">Overtime</th>
                  <th className="p-3 font-bold min-w-[180px]">Overtime Dates</th>
                  <th className="p-3 font-bold w-[90px] text-center">Paid Leave</th>
                  <th className="p-3 font-bold w-[90px] text-center">Unpaid Leave</th>
                  <th className="p-3 font-bold min-w-[180px]">Remarks / Notes</th>
                  <th className="p-3 font-bold min-w-[130px] text-center">Daily Intervals</th>
                  <th className="p-3 font-bold w-[45px] text-center"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {reportRows.map((row) => (
                  <tr
                    key={row.id}
                    className={`transition-colors ${
                      row.worked
                        ? "hover:bg-secondary/20"
                        : "bg-muted/30 opacity-70 hover:opacity-100"
                    }`}
                  >
                    {/* Worked Toggle Checkbox */}
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() => handleToggleWorked(row.id)}
                        className={`h-7 w-7 rounded-md inline-flex items-center justify-center font-bold transition ${
                          row.worked
                            ? "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
                            : "bg-muted text-muted-foreground border hover:border-foreground"
                        }`}
                        title={
                          row.worked
                            ? "Mark as did not work (zeros hours)"
                            : "Mark as worked during period"
                        }
                      >
                        {row.worked ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Ban className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>

                    {/* Employee Name, Email & Attendance Tallies */}
                    <td className="p-3">
                      <input
                        type="text"
                        value={row.employeeName}
                        onChange={(e) =>
                          handleUpdateRowField(row.id, "employeeName", e.target.value)
                        }
                        placeholder="Employee Name"
                        className="w-full font-bold text-foreground text-xs px-2 py-1 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                      />
                      {row.employeeEmail && (
                        <div className="text-[11px] text-muted-foreground px-2">
                          {row.employeeEmail}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-2 text-[10px] font-bold">
                        <span
                          className="px-2 py-0.5 rounded-full bg-emerald-600 text-white font-bold shadow-2xs"
                          title="Days Worked"
                        >
                          {row.workedDays || 0}d worked
                        </span>
                        {(row.absentDays || 0) > 0 && (
                          <span
                            className="px-2 py-0.5 rounded-full bg-rose-600 text-white font-bold shadow-2xs"
                            title="Unexcused Absences"
                          >
                            {row.absentDays}d absent
                          </span>
                        )}
                        {(row.leaveDays || 0) > 0 && (
                          <span
                            className="px-2 py-0.5 rounded-full bg-purple-600 text-white font-bold shadow-2xs"
                            title="Approved Leaves"
                          >
                            {row.leaveDays}d leave
                          </span>
                        )}
                        {(row.lateDays || 0) > 0 && (
                          <span
                            className="px-2 py-0.5 rounded-full bg-rose-600 text-white font-bold shadow-2xs"
                            title="Late Shifts"
                          >
                            {row.lateDays}d late
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Role / Job Title */}
                    <td className="p-3">
                      <input
                        type="text"
                        value={row.role}
                        onChange={(e) => handleUpdateRowField(row.id, "role", e.target.value)}
                        placeholder="Role / Title"
                        className="w-full text-xs font-medium px-2 py-1.5 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                      />
                    </td>

                    {/* Regular Hours Input */}
                    <td className="p-3 text-right">
                      <div className="relative inline-flex items-center w-full">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={row.regularHours}
                          onChange={(e) =>
                            handleUpdateRowField(
                              row.id,
                              "regularHours",
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          className="w-full text-right font-bold text-sky-700 text-xs px-2 py-1.5 pr-6 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                        />
                        <span className="absolute right-2 text-[11px] font-semibold text-muted-foreground pointer-events-none">
                          h
                        </span>
                      </div>
                    </td>

                    {/* Overtime Hours Input */}
                    <td className="p-3 text-right">
                      <div className="relative inline-flex items-center w-full">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={row.overtimeHours}
                          onChange={(e) =>
                            handleUpdateRowField(
                              row.id,
                              "overtimeHours",
                              parseFloat(e.target.value) || 0,
                            )
                          }
                          className={`w-full text-right font-bold text-xs px-2 py-1.5 pr-6 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition ${
                            row.overtimeHours > 0 ? "text-amber-600" : "text-muted-foreground"
                          }`}
                        />
                        <span className="absolute right-2 text-[11px] font-semibold text-muted-foreground pointer-events-none">
                          h
                        </span>
                      </div>
                      {row.pendingOvertimeHours > 0 && (
                        <div className="text-right mt-0.5">
                          <Link
                            to="/admin/overtime"
                            className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-700 dark:text-amber-300 hover:underline"
                            title="Click to review in Overtime tab"
                          >
                            <ClockAlert className="h-2.5 w-2.5" /> +{row.pendingOvertimeHours.toFixed(1)}h in OT tab →
                          </Link>
                        </div>
                      )}
                    </td>

                    {/* Overtime Dates Input */}
                    <td className="p-3">
                      <input
                        type="text"
                        value={(row.overtimeDates || []).join(", ")}
                        onChange={(e) =>
                          handleUpdateRowField(
                            row.id,
                            "overtimeDates",
                            e.target.value
                              .split(",")
                              .map((s) => s.trim())
                              .filter(Boolean),
                          )
                        }
                        placeholder="e.g. Aug 12 (1.5h), Aug 15 (2h)"
                        className="w-full text-xs text-foreground px-2 py-1.5 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                      />
                    </td>

                    {/* Paid Leave Input */}
                    <td className="p-3 text-center">
                      <div className="relative inline-flex items-center w-full justify-center">
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={row.paidLeaveDays}
                          onChange={(e) =>
                            handleUpdateRowField(
                              row.id,
                              "paidLeaveDays",
                              parseInt(e.target.value, 10) || 0,
                            )
                          }
                          className="w-14 text-center font-bold text-emerald-700 text-xs px-1 py-1.5 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                        />
                      </div>
                    </td>

                    {/* Unpaid Leave Input */}
                    <td className="p-3 text-center">
                      <div className="relative inline-flex items-center w-full justify-center">
                        <input
                          type="number"
                          step="1"
                          min="0"
                          value={row.unpaidLeaveDays}
                          onChange={(e) =>
                            handleUpdateRowField(
                              row.id,
                              "unpaidLeaveDays",
                              parseInt(e.target.value, 10) || 0,
                            )
                          }
                          className="w-14 text-center font-bold text-rose-700 text-xs px-1 py-1.5 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                        />
                      </div>
                    </td>

                    {/* Remarks Input */}
                    <td className="p-3">
                      <input
                        type="text"
                        value={row.remarks}
                        onChange={(e) => handleUpdateRowField(row.id, "remarks", e.target.value)}
                        placeholder="Add client remarks / performance note…"
                        className="w-full text-xs px-2 py-1.5 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                      />
                    </td>

                    {/* Daily Interval Inspection Action */}
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() => setSelectedIntervalEmployee(row)}
                        className="px-2.5 py-1.5 rounded-lg border bg-secondary/60 hover:bg-primary/10 hover:text-primary hover:border-primary/30 text-foreground text-xs font-bold inline-flex items-center gap-1 transition"
                      >
                        <Sliders className="h-3.5 w-3.5 text-primary" />
                        <span>Inspect Days ({row.dailyIntervals.length})</span>
                      </button>
                    </td>

                    {/* Row Remove */}
                    <td className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() => handleDeleteRow(row.id)}
                        className="p-1 rounded text-muted-foreground hover:text-rose-600 hover:bg-rose-500/10 transition"
                        title="Remove person from report"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}

                {reportRows.length === 0 && (
                  <tr>
                    <td colSpan={11} className="p-10 text-center text-muted-foreground">
                      No team members found for this company and period. Click &quot;+ Add
                      Person&quot; to add custom entries.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Detailed Daily Log View */
        <div className="rounded-xl border bg-card overflow-x-auto shadow-sm">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-secondary/70 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Date</th>
                <th className="p-3">Employee</th>
                <th className="p-3">Department</th>
                <th className="p-3">Punch in</th>
                <th className="p-3">Punch out</th>
                <th className="p-3">Hours</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {dailyRows.map((row) => {
                const timezone = getEmployeeTimezone(row.employee);
                return (
                  <tr key={row.key} className="hover:bg-secondary/30">
                    <td className="p-3 font-mono text-xs">{row.date}</td>
                    <td className="p-3">
                      <Link
                        to="/admin/employees/$id"
                        params={{ id: row.employee.id }}
                        className="font-bold text-primary hover:underline"
                      >
                        {row.employee.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">{row.employee.email}</div>
                    </td>
                    <td className="p-3">{row.department}</td>
                    <td className="p-3 font-mono text-xs">
                      {row.firstIn
                        ? formatInTimezone(toDate(row.firstIn.timestamp) ?? new Date(), timezone)
                        : "—"}
                    </td>
                    <td className="p-3 font-mono text-xs">
                      {row.lastOut
                        ? formatInTimezone(toDate(row.lastOut.timestamp) ?? new Date(), timezone)
                        : row.firstIn
                          ? "Still in"
                          : "—"}
                    </td>
                    <td className="p-3 font-bold">{row.hours.toFixed(2)}</td>
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs font-bold ${
                          row.isAutoPunchOut
                            ? "bg-sky-500/10 text-sky-700"
                            : row.minutesLate
                              ? "bg-amber-500/10 text-amber-700"
                              : "bg-emerald-500/10 text-emerald-700"
                        }`}
                      >
                        {row.status}
                        {row.minutesLate ? ` (${row.minutesLate}m)` : ""}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <Link
                        to="/admin/employees/$id"
                        params={{ id: row.employee.id }}
                        className="text-xs font-bold text-primary hover:underline"
                      >
                        Open profile
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {dailyRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-10 text-center text-muted-foreground">
                    No attendance records match the selected date bounds.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ========================================================================= */}
      {/* DAILY INTERVALS & OVERTIME APPROVAL MODAL/DRAWER                          */}
      {/* ========================================================================= */}
      {selectedIntervalEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="rounded-2xl border bg-card max-w-4xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-5 border-b bg-secondary/30 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-black text-foreground">
                    Daily Interval Breakdown & Overtime Approval
                  </h3>
                  <span className="text-xs font-bold px-2 py-0.5 rounded bg-primary/10 text-primary">
                    {selectedIntervalEmployee.employeeName}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Inspect day-by-day punches, fix missing punch outs, edit hours, and accept
                  overtimes for the report ({periodLabel}).
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedIntervalEmployee(null)}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Quick Summary Stats for Selected Employee */}
            <div className="grid grid-cols-3 gap-3 p-4 bg-muted/20 border-b text-xs">
              <div className="p-2.5 rounded-lg border bg-card">
                <div className="text-[10px] uppercase font-bold text-muted-foreground">
                  Regular Work Hours
                </div>
                <div className="text-lg font-black text-sky-600">
                  {selectedIntervalEmployee.regularHours.toFixed(1)}h
                </div>
              </div>
              <div className="p-2.5 rounded-lg border bg-card">
                <div className="text-[10px] uppercase font-bold text-muted-foreground">
                  Accepted Overtime
                </div>
                <div className="text-lg font-black text-amber-600">
                  +{selectedIntervalEmployee.overtimeHours.toFixed(1)}h
                </div>
              </div>
              <div className="p-2.5 rounded-lg border bg-card">
                <div className="text-[10px] uppercase font-bold text-muted-foreground">
                  Pending Overtime Approval
                </div>
                <div className="text-lg font-black text-rose-600">
                  {selectedIntervalEmployee.pendingOvertimeHours > 0
                    ? `+${selectedIntervalEmployee.pendingOvertimeHours.toFixed(1)}h`
                    : "0.0h"}
                </div>
              </div>
            </div>

            {/* Daily Intervals Table */}
            <div className="p-4 overflow-y-auto flex-1">
              <table className="w-full text-xs">
                <thead className="bg-secondary/70 uppercase text-muted-foreground font-bold">
                  <tr>
                    <th className="p-2.5 text-left">Date & Day</th>
                    <th className="p-2.5 text-left">Shift Window</th>
                    <th className="p-2.5 text-left">Punch In</th>
                    <th className="p-2.5 text-left">Punch Out</th>
                    <th className="p-2.5 text-right">Regular (h)</th>
                    <th className="p-2.5 text-right">Overtime (h)</th>
                    <th className="p-2.5 text-center">Overtime Status</th>
                    <th className="p-2.5 text-left">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {selectedIntervalEmployee.dailyIntervals.map((day) => (
                    <tr
                      key={day.date}
                      className={`hover:bg-secondary/20 transition-colors ${
                        day.isMissingPunchOut ? "bg-amber-500/5" : ""
                      }`}
                    >
                      <td className="p-2.5 font-bold text-foreground">
                        <div className="flex items-center gap-1.5">
                          <span>{day.date}</span>
                          <span className="text-[10px] text-muted-foreground font-normal">
                            ({day.dayOfWeek})
                          </span>
                        </div>
                      </td>

                      <td className="p-2.5 text-muted-foreground font-mono">
                        {day.scheduledShift}
                      </td>

                      {/* Punch In */}
                      <td className="p-2.5">
                        <input
                          type="time"
                          value={day.punchInTime || ""}
                          onChange={(e) =>
                            handleUpdateDayInterval(selectedIntervalEmployee.id, day.date, {
                              punchInTime: e.target.value,
                              status: "Edited In",
                            })
                          }
                          className="px-2 py-1 rounded border bg-background font-mono text-xs w-[85px]"
                        />
                        {day.sessions && day.sessions.length > 1 && (
                          <div className="mt-1 space-y-0.5">
                            {day.sessions.map((s, sIdx) => (
                              <div
                                key={sIdx}
                                className="text-[10px] text-muted-foreground font-mono truncate"
                                title={`Session ${sIdx + 1}: ${s.inTime} - ${s.outTime || "..."} (${formatWorkMinutes(s.durationMinutes)})`}
                              >
                                <span className="font-bold text-foreground">#{sIdx + 1}:</span> {s.inTime}–{s.outTime || "..."} ({formatWorkMinutes(s.durationMinutes)}{s.isOvertime ? " OT" : ""})
                              </div>
                            ))}
                          </div>
                        )}
                      </td>

                      {/* Punch Out / Fix Missed Punch Out */}
                      <td className="p-2.5">
                        {day.isMissingPunchOut ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-rose-600 font-bold flex items-center gap-1">
                              <AlertTriangle className="h-3 w-3" /> Missed Out
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                handleFixMissedPunchOut(selectedIntervalEmployee.id, day.date)
                              }
                              className="px-2 py-0.5 rounded bg-primary text-white font-bold text-[10px] hover:opacity-90 shadow-sm"
                              title="Set shift end punch-out time"
                            >
                              Fix End
                            </button>
                          </div>
                        ) : (
                          <input
                            type="time"
                            value={day.punchOutTime || ""}
                            onChange={(e) =>
                              handleUpdateDayInterval(selectedIntervalEmployee.id, day.date, {
                                punchOutTime: e.target.value,
                                isMissingPunchOut: false,
                                status: "Edited Out",
                              })
                            }
                            className="px-2 py-1 rounded border bg-background font-mono text-xs w-[85px]"
                          />
                        )}
                      </td>

                      {/* Regular Hours */}
                      <td className="p-2.5 text-right">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={day.regularHours}
                          onChange={(e) =>
                            handleUpdateDayInterval(selectedIntervalEmployee.id, day.date, {
                              regularHours: parseFloat(e.target.value) || 0,
                            })
                          }
                          className="w-16 text-right font-bold text-sky-700 px-1.5 py-1 rounded border bg-background text-xs"
                        />
                      </td>

                      {/* Overtime Hours */}
                      <td className="p-2.5 text-right">
                        <input
                          type="number"
                          step="0.1"
                          min="0"
                          value={day.rawOvertimeHours}
                          onChange={(e) =>
                            handleUpdateDayInterval(selectedIntervalEmployee.id, day.date, {
                              rawOvertimeHours: parseFloat(e.target.value) || 0,
                            })
                          }
                          className={`w-16 text-right font-bold px-1.5 py-1 rounded border bg-background text-xs ${
                            day.rawOvertimeHours > 0 ? "text-amber-600" : "text-muted-foreground"
                          }`}
                        />
                      </td>

                      {/* Overtime Status */}
                      <td className="p-2.5 text-center">
                        {day.rawOvertimeHours > 0 ? (
                          day.isOvertimeApproved ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-600 text-white shadow-2xs">
                              <Check className="h-3 w-3" /> Approved
                            </span>
                          ) : (
                            <Link
                              to="/admin/overtime"
                              className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 hover:bg-amber-600 text-slate-950 shadow-2xs transition"
                              title="Click to review in Overtime tab"
                            >
                              <ClockAlert className="h-3 w-3" /> Pending in OT Tab →
                            </Link>
                          )
                        ) : (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="p-2.5">
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-secondary text-foreground">
                          {day.status}
                        </span>
                      </td>
                    </tr>
                  ))}

                  {selectedIntervalEmployee.dailyIntervals.length === 0 && (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-muted-foreground">
                        No recorded intervals found for this date range.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="p-4 border-t bg-secondary/30 flex items-center justify-between">
              <div className="text-xs text-muted-foreground">
                All edits immediately recalculate regular hours, overtime, and overtime dates in the
                report table.
              </div>
              <button
                type="button"
                onClick={() => setSelectedIntervalEmployee(null)}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold shadow-sm"
              >
                Done Inspecting
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* SEND REPORT EMAIL MODAL                                                   */}
      {/* ========================================================================= */}
      {isSendModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="rounded-2xl border bg-card max-w-4xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="p-5 border-b bg-secondary/30 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="h-9 w-9 rounded-xl bg-emerald-500/10 text-emerald-600 flex items-center justify-center font-bold">
                  <Mail className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">
                    Send Report to Client & Stakeholders
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Automatically dispatch a branded summary and breakdown table via email.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setIsSendModalOpen(false)}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1 text-sm">
              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Recipient Email(s) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={recipientEmailsText}
                  onChange={(e) => setRecipientEmailsText(e.target.value)}
                  placeholder="e.g. client@company.com, manager@domain.com"
                  className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm font-medium focus:ring-2 focus:ring-primary/20 outline-none"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  You can enter multiple email addresses separated by commas.
                </p>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-foreground mb-1">
                    Client / Recipient Name
                  </label>
                  <input
                    type="text"
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="e.g. Ironbrij Client Team"
                    className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-foreground mb-1">
                    Email Subject
                  </label>
                  <input
                    type="text"
                    value={emailSubject}
                    onChange={(e) => setEmailSubject(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm font-medium"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Custom Cover Message / Remarks for Client (Optional)
                </label>
                <textarea
                  rows={3}
                  value={customNote}
                  onChange={(e) => setCustomNote(e.target.value)}
                  placeholder="e.g. Please find the work hours and overtime summary for this month attached below. All shifts and leaves have been reviewed and approved."
                  className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-sm resize-none"
                />
              </div>

              {/* Toggle Live Preview */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowEmailPreview(!showEmailPreview)}
                  className="text-xs font-bold text-primary hover:underline flex items-center gap-1.5"
                >
                  <Eye className="h-3.5 w-3.5" />
                  {showEmailPreview ? "Hide Email Preview" : "Show Live Email Preview"}
                </button>

                {showEmailPreview && (
                  <div className="mt-3 p-4 rounded-xl border bg-muted/40 text-xs space-y-3">
                    <div className="font-bold text-foreground border-b pb-2">
                      Subject: {emailSubject}
                    </div>
                    {customNote && (
                      <div className="p-3 bg-blue-50 border border-blue-200 text-blue-900 rounded-lg whitespace-pre-wrap">
                        {customNote}
                      </div>
                    )}
                    <div className="grid grid-cols-4 gap-2 text-center py-2 bg-background rounded-lg border">
                      <div>
                        <div className="text-[10px] text-muted-foreground uppercase font-bold">
                          Team Active
                        </div>
                        <div className="font-black text-sm">{reportTotals.totalWorkedCount}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground uppercase font-bold">
                          Reg Hours
                        </div>
                        <div className="font-black text-sm text-sky-600">
                          {reportTotals.totalHours.toFixed(1)}h
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground uppercase font-bold">
                          Accepted OT
                        </div>
                        <div className="font-black text-sm text-amber-600">
                          +{reportTotals.totalOvertime.toFixed(1)}h
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-muted-foreground uppercase font-bold">
                          Leaves
                        </div>
                        <div className="font-black text-sm text-emerald-600">
                          {reportTotals.totalPaidLeave + reportTotals.totalUnpaidLeave}d
                        </div>
                      </div>
                    </div>
                    {/* Full Employee Breakdown Table Preview */}
                    <div className="rounded-lg border bg-card overflow-hidden">
                      <div className="p-2.5 bg-muted/60 border-b font-bold text-foreground text-xs flex items-center justify-between">
                        <span>Detailed Team Member Report Table</span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {reportRows.length} team members
                        </span>
                      </div>
                      <div className="overflow-x-auto max-h-64">
                        <table className="w-full text-left text-xs">
                          <thead className="bg-secondary/70 text-[10px] uppercase font-bold text-muted-foreground sticky top-0">
                            <tr>
                              <th className="p-2">Employee / V.A.</th>
                              <th className="p-2">Role / Dept</th>
                              <th className="p-2 text-right">Reg Hours</th>
                              <th className="p-2 text-right">Overtime</th>
                              <th className="p-2 text-center">Leaves</th>
                              <th className="p-2">Remarks</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/60">
                            {reportRows.map((row) => (
                              <tr
                                key={row.id}
                                className={`hover:bg-muted/30 ${!row.worked ? "opacity-60 bg-muted/20" : ""}`}
                              >
                                <td className="p-2 font-bold text-foreground">
                                  {row.employeeName}
                                  {row.employeeEmail && (
                                    <div className="text-[10px] text-muted-foreground font-normal">
                                      {row.employeeEmail}
                                    </div>
                                  )}
                                </td>
                                <td className="p-2 text-muted-foreground">
                                  {row.role} · {row.department}
                                </td>
                                <td className="p-2 text-right font-bold text-sky-600">
                                  {Number(row.regularHours).toFixed(1)}h
                                </td>
                                <td className="p-2 text-right font-bold text-amber-600 whitespace-nowrap">
                                  {row.overtimeHours > 0
                                    ? `+${Number(row.overtimeHours).toFixed(1)}h`
                                    : "—"}
                                  {(row.overtimeDates || []).length > 0 && (
                                    <div className="text-[9px] text-muted-foreground font-normal">
                                      {(row.overtimeDates || []).length} date(s)
                                    </div>
                                  )}
                                </td>
                                <td className="p-2 text-center text-muted-foreground whitespace-nowrap">
                                  {row.paidLeaveDays > 0 || row.unpaidLeaveDays > 0
                                    ? `Paid: ${row.paidLeaveDays}d | Unpaid: ${row.unpaidLeaveDays}d`
                                    : "—"}
                                </td>
                                <td className="p-2 text-muted-foreground italic max-w-xs truncate">
                                  {row.remarks || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="p-4 border-t bg-secondary/30 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setIsSendModalOpen(false)}
                className="px-4 py-2 rounded-lg border text-xs font-bold text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSendingEmail}
                onClick={handleSendReportEmail}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center gap-2 shadow-sm transition disabled:opacity-50"
              >
                {isSendingEmail ? (
                  <>Sending Report…</>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5" /> Send Report Now
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ADD CUSTOM PERSON MODAL                                                   */}
      {/* ========================================================================= */}
      {isAddRowModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
          <div className="rounded-2xl border bg-card max-w-md w-full shadow-2xl p-5 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-bold text-foreground">Add Custom Person to Report</h3>
              <button
                onClick={() => setIsAddRowModalOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-sm">
              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1">
                  Employee / V.A. Name <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={newRowData.employeeName}
                  onChange={(e) => setNewRowData({ ...newRowData, employeeName: e.target.value })}
                  placeholder="e.g. Sarah Jenkins"
                  className="w-full px-3 py-2 rounded-lg border bg-background text-foreground"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1">Role</label>
                  <input
                    type="text"
                    value={newRowData.role}
                    onChange={(e) => setNewRowData({ ...newRowData, role: e.target.value })}
                    placeholder="e.g. Virtual Assistant / V.A."
                    className="w-full px-3 py-2 rounded-lg border bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1">
                    Department
                  </label>
                  <input
                    type="text"
                    value={newRowData.department}
                    onChange={(e) => setNewRowData({ ...newRowData, department: e.target.value })}
                    placeholder="e.g. Operations"
                    className="w-full px-3 py-2 rounded-lg border bg-background text-foreground"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1">
                    Regular Hours
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={newRowData.regularHours || ""}
                    onChange={(e) =>
                      setNewRowData({ ...newRowData, regularHours: Number(e.target.value) || 0 })
                    }
                    placeholder="0"
                    className="w-full px-3 py-2 rounded-lg border bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-muted-foreground mb-1">
                    Overtime Hours
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={newRowData.overtimeHours || ""}
                    onChange={(e) =>
                      setNewRowData({ ...newRowData, overtimeHours: Number(e.target.value) || 0 })
                    }
                    placeholder="0"
                    className="w-full px-3 py-2 rounded-lg border bg-background text-foreground"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1">
                  Overtime Dates
                </label>
                <input
                  type="text"
                  value={(newRowData.overtimeDates || []).join(", ")}
                  onChange={(e) =>
                    setNewRowData({
                      ...newRowData,
                      overtimeDates: e.target.value
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="e.g. Aug 10 (2h)"
                  className="w-full px-3 py-2 rounded-lg border bg-background text-foreground"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted-foreground mb-1">
                  Remarks
                </label>
                <input
                  type="text"
                  value={newRowData.remarks}
                  onChange={(e) => setNewRowData({ ...newRowData, remarks: e.target.value })}
                  placeholder="e.g. Special client task"
                  className="w-full px-3 py-2 rounded-lg border bg-background text-foreground"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setIsAddRowModalOpen(false)}
                className="px-4 py-2 rounded-lg border text-xs font-bold text-muted-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddCustomRow}
                className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold"
              >
                Add Person
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
