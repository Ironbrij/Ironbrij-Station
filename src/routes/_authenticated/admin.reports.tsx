import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, Timestamp, updateDoc } from "firebase/firestore";
import { punchesSinceQuery } from "@/lib/punch-queries";
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
  XCircle,
} from "lucide-react";
import Papa from "papaparse";
import { createPdf } from "@/lib/pdf-export";
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
import { breakDurationMs } from "@/lib/work-breaks";
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
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getEmployeeLeavesForCompany,
  getEmployeePunchesForCompany,
  getRequiredWorkMinutes,
  normalizeCompanyId,
} from "@/lib/company-context";
import { filterEmployeeList } from "@/lib/employee-list";
import { companyEmailBranding } from "@/lib/email-branding";
import {
  addCalendarDay,
  buildReportRows,
  describeLeave,
  getDayOfWeekStr,
  type DailyIntervalRecord,
  type PunchSessionRecord,
  type ReportRow,
} from "@/lib/report-rows";
import { applyPunchCorrection } from "@/lib/punch-corrections";
import { resolveManualClockOut } from "@/lib/manual-clock-in";
import { parseLeaveDays } from "@/lib/report-format";

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

export type { DailyIntervalRecord, PunchSessionRecord, ReportRow };

export const Route = createFileRoute("/_authenticated/admin/reports")({
  head: () => ({ meta: [{ title: "Reports & Client Delivery — SavyTimes Admin" }] }),
  component: ReportsPage,
});

function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function ReportsPage() {
  const { company: authCompany, user } = useAuth();
  const currentMonth = new Date().toISOString().slice(0, 7);
  const initialBounds = monthBounds(currentMonth);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  // Reports open across every client; the Target Company picker below narrows them.
  const [companyFilter, setCompanyFilter] = useState("all");
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [overtimeRequests, setOvertimeRequests] = useState<OvertimeRequest[]>([]);
  const [syncError, setSyncError] = useState("");
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
  const [removedRowIds, setRemovedRowIds] = useState<string[]>([]);

  // Modals & Drawer state
  const [isSendModalOpen, setIsSendModalOpen] = useState(false);
  const [isAddRowModalOpen, setIsAddRowModalOpen] = useState(false);
  const [selectedIntervalEmployee, setSelectedIntervalEmployee] = useState<ReportRow | null>(null);

  // Add custom day / info modal state for inspect drawer
  const [showAddDayModal, setShowAddDayModal] = useState(false);
  const [customDayDate, setCustomDayDate] = useState("");
  const [customDayNote, setCustomDayNote] = useState("");
  const [customDayRegularHours, setCustomDayRegularHours] = useState(8);
  const [customDayPunchIn, setCustomDayPunchIn] = useState("09:00");
  const [customDayPunchOut, setCustomDayPunchOut] = useState("17:00");
  const [customDayStatus, setCustomDayStatus] = useState("Custom Entry");
  const [syncToPunches, setSyncToPunches] = useState(true);
  const [isSavingCustomDay, setIsSavingCustomDay] = useState(false);

  // Add row form state
  const [newRowData, setNewRowData] = useState<Omit<ReportRow, "id" | "dailyIntervals">>({
    employeeName: "",
    employeeEmail: "",
    worked: true,
    department: "General",
    role: "V.A.",
    client: "",
    status: "active",
    hoursPerDay: 8,
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
    paidLeaveUsed: "0",
    unpaidLeaveUsed: "0",
    availableLeaveCredit: "",
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
    // A dropped listener used to leave an empty report that looked like "no data".
    const failed = (source: string) => (error: Error) =>
      setSyncError(`${source} could not sync (${error.message}). Refresh to reconnect.`);
    const unsubscribers = [
      onSnapshot(
        collection(db(), "companies"),
        (snapshot) =>
          setCompanies(
            snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Company, "id">) })),
          ),
        failed("Companies"),
      ),
      onSnapshot(
        collection(db(), "employees"),
        (snapshot) =>
          setEmployees(
            snapshot.docs.map((item) => ({
              id: item.id,
              ...(item.data() as Omit<Employee, "id">),
            })),
          ),
        failed("Employees"),
      ),
      onSnapshot(
        collection(db(), "departments"),
        (snapshot) =>
          setDepartments(
            snapshot.docs.map((item) => ({
              id: item.id,
              ...(item.data() as Omit<Department, "id">),
            })),
          ),
        failed("Departments"),
      ),
      onSnapshot(
        collection(db(), "leaveRequests"),
        (snapshot) =>
          setLeaves(
            snapshot.docs.map((item) => ({
              id: item.id,
              ...(item.data() as Omit<LeaveRequest, "id">),
            })),
          ),
        failed("Leave requests"),
      ),
      onSnapshot(
        collection(db(), "overtimeRequests"),
        (snapshot) =>
          setOvertimeRequests(
            snapshot.docs.map((item) => ({
              id: item.id,
              ...(item.data() as Omit<OvertimeRequest, "id">),
            })),
          ),
        failed("Overtime requests"),
      ),
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  // Punches from the report's start date on, with two days' slack for timezones.
  const punchesSince = /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : "";
  useEffect(() => {
    const start = punchesSince
      ? new Date(Date.parse(`${punchesSince}T00:00:00Z`) - 2 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() - 32 * 24 * 60 * 60 * 1000);
    return onSnapshot(
      punchesSinceQuery(start),
      (snapshot) =>
        setPunches(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) })),
        ),
      (error) =>
        setSyncError(`Attendance could not sync (${error.message}). Refresh to reconnect.`),
    );
  }, [punchesSince]);

  const selectedCompany = useMemo(() => {
    if (companyFilter === "all") return authCompany;
    const target = normalizeCompanyId(companyFilter);
    return companies.find((c) => normalizeCompanyId(c.id) === target) || authCompany;
  }, [companyFilter, companies, authCompany]);

  // Someone can work a week for a client and be reassigned afterwards. Their
  // punches are the record of that week, so the report cannot rely on who is
  // assigned today or the week disappears from the client's report.
  const workedEmployeeIds = useMemo(() => {
    const target = normalizeCompanyId(companyFilter);
    const ids = new Set<string>();
    for (const punch of punches) {
      if (punch.voidedAt || !punch.employeeId) continue;
      const date = punch.attendanceDate || punch.date;
      if (date && (date < from || date > to)) continue;
      if (companyFilter !== "all" && normalizeCompanyId(punch.companyId || "") !== target) continue;
      ids.add(punch.employeeId);
    }
    return ids;
  }, [companyFilter, from, punches, to]);

  // Company and department assignments live in companyMemberships and use aliases,
  // so reports must resolve them the same way the employee list does.
  const filteredEmployees = useMemo(() => {
    const assigned = filterEmployeeList(
      employees,
      companies,
      departments,
      companyFilter,
      departmentId,
      search,
    );
    const seen = new Set(assigned.map((employee) => employee.id));
    const query = search.trim().toLowerCase();
    const alsoWorked = employees.filter(
      (employee) =>
        !seen.has(employee.id) &&
        (workedEmployeeIds.has(employee.id) ||
          Boolean(employee.authUid && workedEmployeeIds.has(employee.authUid))) &&
        (!query ||
          [employee.name, employee.email, employee.jobTitle, employee.id].some((value) =>
            value?.toLowerCase().includes(query),
          )),
    );
    return [...assigned, ...alsoWorked]
      .filter(
        (employee) =>
          !employeeId || employee.id === employeeId || employee.authUid === employeeId,
      )
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  }, [
    companies,
    companyFilter,
    departmentId,
    employeeId,
    employees,
    departments,
    search,
    workedEmployeeIds,
  ]);

  // Compute Raw Day-by-Day Attendance Rows
  const dailyRows = useMemo(() => {
    const output: AttendanceRow[] = [];
    for (const rawEmployee of filteredEmployees) {
      const employee =
        companyFilter === "all" ? rawEmployee : getEmployeeForCompany(rawEmployee, companyFilter);
      const reportCompany =
        companyFilter === "all"
          ? authCompany
          : companies.find(
              (item) => normalizeCompanyId(item.id) === normalizeCompanyId(companyFilter),
            ) || authCompany;
      const employeeLeaves = getEmployeeLeavesForCompany(leaves, rawEmployee, companyFilter);
      const shiftTimezone = getShiftTimezone(employee);
      const groups = new Map<string, Punch[]>();
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
        const effectiveWorkingDays = getEffectiveEmployeeWorkingDays(
          employee,
          reportCompany?.workingDays,
        );
        const isScheduledDay = effectiveWorkingDays.includes(shiftWeekday) && !holiday;
        const isOffShiftDay = !isScheduledDay;

        const isExcused = Boolean(firstIn?.isExcused);
        const late =
          firstIn && isScheduledDay
            ? computeEmployeeLateness(
                toDate(firstIn.timestamp) ?? new Date(),
                employee,
                getEffectiveLateGraceMinutes(reportCompany?.lateGraceMinutes),
                isExcused,
              )
            : null;
        const isAutoPunchOut = Boolean(lastOut?.isAuto);

        const dayOtRequests = overtimeRequests.filter(
          (r) =>
            (r.employeeId === employee.id ||
              (employee.authUid && r.employeeId === employee.authUid)) &&
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
                  ? isOffShiftDay
                    ? "Off day"
                    : "No punch in"
                  : !lastOut
                    ? "Still punched in"
                    : isAutoPunchOut
                      ? late?.isLate
                        ? "Auto punched out · Late"
                        : "Auto punched out"
                      : isExcused
                        ? "Excused (Not Late)"
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
  const computedSummaryRows = useMemo(
    () =>
      buildReportRows({
        employees: filteredEmployees,
        punches,
        leaves,
        overtimeRequests,
        departments,
        companies,
        companyFilter,
        fallbackCompany: authCompany,
        from,
        to,
      }),
    [
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
    ],
  );
  // Manual edits belong to the period and company they were made for, so a scope
  // change releases them rather than pinning the report to the previous scope.
  const reportScope = `${companyFilter}|${from}|${to}|${departmentId}|${employeeId}`;
  useEffect(() => {
    setHasCustomEdits(false);
    setRemovedRowIds([]);
  }, [reportScope]);

  // Live figures and manual edits both matter: recompute from Firestore every
  // time and lay the admin's own changes back on top, instead of freezing the
  // whole report at the first edit and never syncing again.
  useEffect(() => {
    setReportRows((previous) => {
      const edited = new Map(
        previous.filter((row) => row.isAdjusted).map((row) => [row.id, row] as const),
      );
      const added = previous.filter((row) => row.isCustom);
      const computed = computedSummaryRows
        .filter((row) => !removedRowIds.includes(row.id))
        .map((row) => {
          const manual = edited.get(row.id);
          if (!manual) return row;
          return {
            ...row,
            ...manual,
            // Day-level records stay live unless the admin edited them too.
            dailyIntervals: manual.dailyIntervals?.length
              ? manual.dailyIntervals
              : row.dailyIntervals,
          };
        });
      return [...added, ...computed];
    });
  }, [computedSummaryRows, removedRowIds]);

  // The inspect drawer holds a copy of one row, so it has to follow the live
  // rows or a punch fixed inside it keeps showing the figures from before.
  useEffect(() => {
    setSelectedIntervalEmployee((current) =>
      current ? reportRows.find((row) => row.id === current.id) || current : current,
    );
  }, [reportRows]);

  // Reset custom edits back to computed values
  function handleResetToCalculated() {
    setRemovedRowIds([]);
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
        return { ...row, isAdjusted: true, [field]: value };
      }),
    );
  }

  // A typed leave figure keeps its wording for the email and its days for the totals.
  function handleUpdateLeaveUsed(id: string, kind: "paid" | "unpaid", text: string) {
    setHasCustomEdits(true);
    setReportRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        const days = parseLeaveDays(text, row.hoursPerDay);
        return kind === "paid"
          ? { ...row, isAdjusted: true, paidLeaveUsed: text, paidLeaveDays: days }
          : { ...row, isAdjusted: true, unpaidLeaveUsed: text, unpaidLeaveDays: days };
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
          isAdjusted: true,
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
    setRemovedRowIds((previous) => (previous.includes(id) ? previous : [...previous, id]));
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
      client: "",
      status: "active",
      hoursPerDay: 8,
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
      paidLeaveUsed: "0",
      unpaidLeaveUsed: "0",
      availableLeaveCredit: "",
      remarks: "",
    });
    toast.success("Added new person to report.");
  }

  // --------------------------------------------------------------------------
  // DAILY INTERVAL & OVERTIME APPROVAL HANDLERS
  // --------------------------------------------------------------------------

  // Update a single day's interval record for an employee.
  // `persisted` means the change was written to Firestore: the row must then
  // follow the recomputed figures, not a hand-patched copy of them, or fixing a
  // punch here looks like it never took effect.
  function handleUpdateDayInterval(
    employeeRowId: string,
    date: string,
    updates: Partial<DailyIntervalRecord>,
    { persisted = false }: { persisted?: boolean } = {},
  ) {
    if (!persisted) setHasCustomEdits(true);
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
            } else if (!day.isOvertimeRejected && day.overtimeStatus !== "rejected") {
              newPendingOt += day.rawOvertimeHours;
            }
          }
        }

        const updatedRow: ReportRow = {
          ...row,
          isAdjusted: !persisted,
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

  // A membership-only employee has no top-level companyId, so a punch written from
  // this page has to resolve its company the same way the report scopes one.
  function resolveWriteCompanyId(employee?: Employee | null): string {
    if (companyFilter !== "all") return normalizeCompanyId(companyFilter);
    return getEmployeeCompanyIds(employee)[0] || COMPANY_ID;
  }

  // Typing a punch time in the report used to change the display only, so the
  // change was lost on the next recompute. Write it as a real punch instead.
  const [savingDayPunch, setSavingDayPunch] = useState("");
  async function handleSaveDayPunch(
    employeeRowId: string,
    day: DailyIntervalRecord,
    field: "in" | "out",
    time: string,
  ) {
    if (!time) return;
    const emp = filteredEmployees.find(
      (item) => item.id === employeeRowId || item.authUid === employeeRowId,
    );
    if (!emp) {
      toast.error("Could not find this employee to record the punch.");
      return;
    }
    const writeCompanyId = resolveWriteCompanyId(emp);
    const scopedEmp = getEmployeeForCompany(emp, writeCompanyId);
    const timezone = getShiftTimezone(scopedEmp);
    const inTime = field === "in" ? time : day.punchInTime;
    if (!inTime) {
      toast.error("Set the clock-in time first, then the clock-out.");
      return;
    }
    const outTime = field === "out" ? time : day.punchOutTime;
    const busyKey = `${employeeRowId}:${day.date}:${field}`;
    setSavingDayPunch(busyKey);
    try {
      const punchIn = zonedDateTimeToDate(day.date, inTime, timezone);
      const punchOut = outTime
        ? resolveManualClockOut(day.date, outTime, timezone, punchIn)
        : null;
      const result = await applyPunchCorrection({
        employee: scopedEmp,
        profile: emp,
        companyId: writeCompanyId,
        companyName: selectedCompany?.name,
        company: selectedCompany,
        punches,
        punchIn,
        punchOut,
        actor: user?.email || "admin",
        note: `Corrected from the ${day.date} report`,
        timezoneUsed: timezone,
      });
      handleUpdateDayInterval(
        employeeRowId,
        day.date,
        {
          punchInTime: inTime,
          punchOutTime: outTime || undefined,
          firstInPunchId: result.punchInId,
          lastOutPunchId: result.punchOutId,
          isMissingPunchOut: false,
          status: field === "in" ? "Clock-in corrected" : "Clock-out corrected",
        },
        { persisted: true },
      );
      toast.success(
        `${emp.name}: ${day.date} saved as ${inTime}${outTime ? ` – ${outTime}` : ""}.`,
      );
    } catch (err) {
      toast.error("Could not record the punch: " + (err as Error).message);
    } finally {
      setSavingDayPunch("");
    }
  }

  // Fix Missed Punch Out on a day (sets standard shift end time from employee profile)
  async function handleFixMissedPunchOut(employeeRowId: string, date: string) {
    const emp = filteredEmployees.find(
      (e) => e.id === employeeRowId || e.authUid === employeeRowId,
    );
    const writeCompanyId = resolveWriteCompanyId(emp);
    const scopedEmp = emp ? getEmployeeForCompany(emp, writeCompanyId) : null;
    const defaultEndTime = scopedEmp?.shiftEndTime || "17:00";
    const empTz = scopedEmp ? getShiftTimezone(scopedEmp) : "Australia/Sydney";
    const fixedOutDate = zonedDateTimeToDate(date, defaultEndTime, empTz);
    // Pair the clock-out with the day's clock-in so hours and overtime recompute
    // against the schedule that shift was actually opened on.
    const dayIn = punches.find(
      (punch) =>
        !punch.voidedAt &&
        punch.type === "in" &&
        (punch.attendanceDate || punch.date) === date &&
        (punch.employeeId === emp?.id || punch.employeeId === emp?.authUid),
    );

    try {
      const fixedPunchRef = await addDoc(collection(db(), "punches"), {
        employeeId: dayIn?.employeeId || emp?.id || employeeRowId,
        employeeName: emp?.name || selectedIntervalEmployee?.employeeName || "Employee",
        companyId: writeCompanyId,
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
        shiftTimezone: dayIn?.shiftTimezone || empTz,
        ...(dayIn ? { punchInId: dayIn.id } : {}),
        ...(dayIn?.scheduledShiftStart
          ? {
              scheduledShiftStart: dayIn.scheduledShiftStart,
              scheduledShiftEnd: dayIn.scheduledShiftEnd,
            }
          : {}),
        attendanceStatus: "complete",
      });

      handleUpdateDayInterval(
        employeeRowId,
        date,
        {
          punchOutTime: defaultEndTime,
          lastOutPunchId: fixedPunchRef.id,
          isMissingPunchOut: false,
          status: "Punch Out Fixed by Admin",
        },
        { persisted: true },
      );
      toast.success(`Fixed punch out for ${date} (set to ${defaultEndTime})`);
    } catch (err) {
      console.error("Failed to fix punch out:", err);
      toast.error("Could not fix punch out: " + (err as Error).message);
    }
  }

  // Add custom information / manual record for a day in the inspect modal
  async function handleAddCustomDay() {
    if (!selectedIntervalEmployee || !customDayDate) {
      toast.error("Please provide a date.");
      return;
    }

    setIsSavingCustomDay(true);
    try {
      const emp = filteredEmployees.find(
        (e) => e.id === selectedIntervalEmployee.id || e.authUid === selectedIntervalEmployee.id,
      );
      const effectiveCompId = resolveWriteCompanyId(emp);
      const scopedEmp = emp ? getEmployeeForCompany(emp, effectiveCompId) : null;
      const empTz = scopedEmp ? getShiftTimezone(scopedEmp) : "Australia/Sydney";

      let inPunchId: string | undefined;
      let outPunchId: string | undefined;

      // If syncToPunches is true, create official Punch records in Firestore
      if (syncToPunches) {
        if (customDayPunchIn) {
          const inDate = zonedDateTimeToDate(customDayDate, customDayPunchIn, empTz);
          const inRef = await addDoc(collection(db(), "punches"), {
            employeeId: emp?.id || selectedIntervalEmployee.id,
            employeeName: emp?.name || selectedIntervalEmployee.employeeName,
            companyId: effectiveCompId,
            companyName: selectedCompany?.name || "Company",
            date: customDayDate,
            attendanceDate: customDayDate,
            type: "in",
            timestamp: Timestamp.fromDate(inDate),
            source: "app",
            manualNote: customDayNote.trim() || `Manual entry by admin`,
            addedByAdmin: user?.email || "admin",
            createdAt: new Date().toISOString(),
            shiftTimezone: empTz,
            attendanceStatus: "complete",
          });
          inPunchId = inRef.id;
        }

        if (customDayPunchOut) {
          const outDate = zonedDateTimeToDate(customDayDate, customDayPunchOut, empTz);
          const outRef = await addDoc(collection(db(), "punches"), {
            employeeId: emp?.id || selectedIntervalEmployee.id,
            employeeName: emp?.name || selectedIntervalEmployee.employeeName,
            companyId: effectiveCompId,
            companyName: selectedCompany?.name || "Company",
            date: customDayDate,
            attendanceDate: customDayDate,
            type: "out",
            timestamp: Timestamp.fromDate(outDate),
            source: "app",
            manualNote: customDayNote.trim() || `Manual entry by admin`,
            addedByAdmin: user?.email || "admin",
            createdAt: new Date().toISOString(),
            shiftTimezone: empTz,
            attendanceStatus: "complete",
          });
          outPunchId = outRef.id;
        }
      }

      // Update in-memory report rows & dailyIntervals. When the day was written
      // to punches, the recompute is the source of truth and must not be pinned
      // behind this local copy.
      const empRowId = selectedIntervalEmployee.id;
      if (!syncToPunches) setHasCustomEdits(true);

      setReportRows((prev) =>
        prev.map((row) => {
          if (row.id !== empRowId) return row;

          const existingIndex = row.dailyIntervals.findIndex((d) => d.date === customDayDate);
          let updatedIntervals: DailyIntervalRecord[];

          const updatedDayRecord: DailyIntervalRecord = {
            date: customDayDate,
            dayOfWeek: getDayOfWeekStr(customDayDate),
            scheduledShift:
              emp?.shiftStartTime && emp?.shiftEndTime
                ? `${emp.shiftStartTime}–${emp.shiftEndTime}`
                : "09:00–17:00",
            punchInTime: customDayPunchIn || undefined,
            punchOutTime: customDayPunchOut || undefined,
            firstInPunchId: inPunchId,
            lastOutPunchId: outPunchId,
            regularHours: Number(customDayRegularHours) || 0,
            rawOvertimeHours: 0,
            isOvertimeApproved: false,
            overtimeStatus: "none",
            isMissingPunchOut: false,
            isAutoPunchOut: false,
            minutesLate: 0,
            breakMinutes: 0,
            unloggedBreakMinutes: 0,
            status:
              customDayStatus.trim() ||
              (customDayNote ? customDayNote.slice(0, 20) : "Custom Record"),
            note: customDayNote.trim() || undefined,
            isCustom: true,
          };

          if (existingIndex >= 0) {
            updatedIntervals = row.dailyIntervals.map((d, idx) =>
              idx === existingIndex
                ? {
                    ...d,
                    ...updatedDayRecord,
                    note: customDayNote.trim() || d.note,
                  }
                : d,
            );
          } else {
            updatedIntervals = [...row.dailyIntervals, updatedDayRecord].sort((a, b) =>
              a.date.localeCompare(b.date),
            );
          }

          // Recompute totals
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
              } else if (!day.isOvertimeRejected && day.overtimeStatus !== "rejected") {
                newPendingOt += day.rawOvertimeHours;
              }
            }
          }

          const newRemarks = customDayNote.trim()
            ? row.remarks
              ? `${row.remarks}; [${customDayDate}: ${customDayNote.trim()}]`
              : `[${customDayDate}: ${customDayNote.trim()}]`
            : row.remarks;

          const updatedRow: ReportRow = {
            ...row,
            isAdjusted: !syncToPunches,
            dailyIntervals: updatedIntervals,
            regularHours: Math.round(newReg * 10) / 10,
            overtimeHours: Math.round(newApprovedOt * 10) / 10,
            pendingOvertimeHours: Math.round(newPendingOt * 10) / 10,
            overtimeDates: newOtDates,
            workedDays: updatedIntervals.filter((d) => d.regularHours > 0).length,
            remarks: newRemarks,
            worked: newReg > 0 || newApprovedOt > 0,
          };

          if (selectedIntervalEmployee?.id === empRowId) {
            setSelectedIntervalEmployee(updatedRow);
          }

          return updatedRow;
        }),
      );

      toast.success(
        `Custom info recorded for ${customDayDate}${syncToPunches ? " & synchronized to punches" : ""}! ✓`,
      );
      setShowAddDayModal(false);
      setCustomDayNote("");
    } catch (err) {
      console.error("Failed to add custom record:", err);
      toast.error("Could not add custom record: " + (err as Error).message);
    } finally {
      setIsSavingCustomDay(false);
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
          periodFrom: from,
          periodTo: to,
          summary: reportTotals,
          // Leave and overtime dates travel in the remarks, as in the client sheet.
          rows: reportRows.map((r) => {
            return {
              employeeName: r.employeeName,
              employeeEmail: r.employeeEmail,
              role: r.role,
              department: r.department,
              client: r.client,
              status: r.status,
              hoursPerDay: r.hoursPerDay,
              workedDays: r.workedDays || 0,
              regularHours: Number(r.regularHours) || 0,
              overtimeHours: Number(r.overtimeHours) || 0,
              overtimeDates: r.overtimeDates || [],
              paidLeaveDays: Number(r.paidLeaveDays) || 0,
              unpaidLeaveDays: Number(r.unpaidLeaveDays) || 0,
              paidLeaveUsed: r.paidLeaveUsed,
              unpaidLeaveUsed: r.unpaidLeaveUsed,
              availableLeaveCredit: r.availableLeaveCredit,
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
      Client: row.client || clientName.trim(),
      Status: row.status === "inactive" ? "Inactive" : "Active",
      "Worked / Active": row.worked ? "Yes" : "No",
      Email: row.employeeEmail || "",
      Role: row.role,
      Department: row.department,
      "Worked Days": row.workedDays || 0,
      "Absent Days": row.absentDays || 0,
      "Leave Days": row.leaveDays || 0,
      "Late Days": row.lateDays || 0,
      "Break Taken (h)": (
        row.dailyIntervals.reduce((sum, day) => sum + (day.breakMinutes || 0), 0) / 60
      ).toFixed(1),
      "Break Deducted (h)": (
        row.dailyIntervals.reduce((sum, day) => sum + (day.unloggedBreakMinutes || 0), 0) / 60
      ).toFixed(1),
      "Regular Hours": Number(row.regularHours).toFixed(1),
      "Accepted Overtime Hours": Number(row.overtimeHours).toFixed(1),
      "Overtime Dates": (row.overtimeDates || []).join("; "),
      "Paid Leave Used": row.paidLeaveUsed,
      "Unpaid Leave Used": row.unpaidLeaveUsed,
      "Available Leave Credit": row.availableLeaveCredit,
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
  async function exportSummaryPdf() {
    if (!reportRows.length) return toast.error("No report rows available to export.");
    const pdf = await createPdf({ orientation: "landscape" });
    if (!pdf) return;

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
    pdf.text("Reg Hours", 122, y);
    pdf.text("Overtime & Dates", 143, y);
    pdf.text("Paid/Unpaid Used", 176, y);
    pdf.text("Leave Credit", 208, y);
    pdf.text("Remarks", 250, y);

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
      pdf.text(`${Number(row.regularHours).toFixed(1)}h`, 122, y);
      pdf.setTextColor(217, 119, 6);
      const otDates = row.overtimeDates || [];
      const otText =
        row.overtimeHours > 0
          ? `+${Number(row.overtimeHours).toFixed(1)}h ${otDates.length ? `(${otDates.length} dates)` : ""}`
          : "—";
      pdf.text(otText, 143, y);
      pdf.setTextColor(30, 41, 59);
      pdf.text(`Paid: ${row.paidLeaveDays}d | Unpaid: ${row.unpaidLeaveDays}d`, 176, y);
      pdf.text((row.availableLeaveCredit || "—").slice(0, 26), 208, y);
      pdf.setTextColor(71, 85, 105);
      pdf.text((row.remarks || "—").split("\n")[0].slice(0, 20), 250, y);
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
  async function exportDailyPdf() {
    if (!dailyRows.length) return toast.error("No daily logs available to export.");
    const pdf = await createPdf({ orientation: "landscape" });
    if (!pdf) return;

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

      {syncError && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-semibold text-amber-900"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{syncError}</span>
        </div>
      )}

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
              {/* Only the people this report actually covers, including anyone who
                  worked for the client in the period but is no longer assigned. */}
              {(employeeId
                ? employees.filter(
                    (emp) => emp.id === employeeId || emp.authUid === employeeId,
                  )
                : filteredEmployees
              ).map((emp) => (
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
            Paid Leave Used
          </div>
          <div className="mt-1 text-2xl font-black text-emerald-600">
            {reportTotals.totalPaidLeave}d
          </div>
        </div>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            Unpaid Leave Used
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
                <strong>Edit before sending:</strong> click any outlined cell to change it, including
                leave used and leave credit, e.g. <em>2.5 Days (20 hours)</em>. Click{" "}
                <span className="font-bold text-primary underline">Inspect Days</span> on any
                employee to see day-by-day hours, fix missed punch-outs, and review overtimes.
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
            <table className="w-full min-w-[1420px] text-sm">
              <thead className="bg-secondary/70 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3 font-bold w-[70px] text-center">Worked?</th>
                  <th className="p-3 font-bold min-w-[170px]">Employee / V.A.</th>
                  <th className="p-3 font-bold min-w-[130px]">Role / Title</th>
                  <th className="p-3 font-bold w-[120px] text-right">Regular Hours</th>
                  <th className="p-3 font-bold min-w-[130px] text-right">Overtime</th>
                  <th className="p-3 font-bold min-w-[180px]">Overtime Dates</th>
                  <th className="p-3 font-bold min-w-[150px] text-center">Paid Leave Used</th>
                  <th className="p-3 font-bold min-w-[150px] text-center">Unpaid Leave Used</th>
                  <th
                    className="p-3 font-bold min-w-[170px] text-center"
                    title="Paid leave credit left: the yearly credits set on the employee's profile, less paid leave taken this year up to the end of this period. Type over it to show your own figure, e.g. 7.54 Days (60.32 hours)."
                  >
                    Available Leave Credit
                  </th>
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
                        className="w-full font-bold text-foreground text-xs px-2 py-1 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition"
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
                        className="w-full text-xs font-medium px-2 py-1.5 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition"
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
                          className="w-full text-right font-bold text-sky-700 text-xs px-2 py-1.5 pr-6 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition"
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
                          className={`w-full text-right font-bold text-xs px-2 py-1.5 pr-6 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition ${
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
                            <ClockAlert className="h-2.5 w-2.5" /> +
                            {row.pendingOvertimeHours.toFixed(1)}h in OT tab →
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
                        className="w-full text-xs text-foreground px-2 py-1.5 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition"
                      />
                    </td>

                    {/* Paid Leave Used: free text such as "2.5 Days (20 hours)" */}
                    <td className="p-3 text-center">
                      <input
                        type="text"
                        value={row.paidLeaveUsed}
                        placeholder="e.g. 2.5 Days (20 hours)"
                        onChange={(e) => handleUpdateLeaveUsed(row.id, "paid", e.target.value)}
                        className="w-full text-center font-bold text-emerald-700 text-xs px-2 py-1.5 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition"
                      />
                    </td>

                    {/* Unpaid Leave Used: free text such as "1 Day (8 hours)" */}
                    <td className="p-3 text-center">
                      <input
                        type="text"
                        value={row.unpaidLeaveUsed}
                        placeholder="e.g. 1 Day (8 hours)"
                        onChange={(e) => handleUpdateLeaveUsed(row.id, "unpaid", e.target.value)}
                        className="w-full text-center font-bold text-rose-700 text-xs px-2 py-1.5 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition"
                      />
                    </td>

                    {/* Available Leave Credit: free text such as "7.54 Days (60.32 hours)" */}
                    <td className="p-3 text-center">
                      <input
                        type="text"
                        value={row.availableLeaveCredit}
                        placeholder="e.g. 7.54 Days (60.32 hours)"
                        onChange={(e) =>
                          handleUpdateRowField(row.id, "availableLeaveCredit", e.target.value)
                        }
                        className={`w-full text-center font-bold text-xs px-2 py-1.5 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition ${
                          row.availableLeaveCredit.trim().startsWith("-")
                            ? "text-rose-700"
                            : "text-teal-700"
                        }`}
                      />
                    </td>

                    {/* Remarks: one section per line group, as in the client sheet */}
                    <td className="p-3">
                      <textarea
                        value={row.remarks}
                        rows={Math.min(8, Math.max(2, row.remarks.split("\n").length))}
                        onChange={(e) => handleUpdateRowField(row.id, "remarks", e.target.value)}
                        placeholder="Add client remarks / performance note…"
                        className="w-full resize-y text-xs leading-snug px-2 py-1.5 rounded border border-dashed border-border hover:border-primary/60 focus:border-solid focus:border-primary bg-background/40 focus:bg-background outline-none transition"
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
                  type="button"
                  onClick={() => {
                    const fallbackDate =
                      selectedIntervalEmployee.dailyIntervals[0]?.date ||
                      new Date().toISOString().slice(0, 10);
                    setCustomDayDate(fallbackDate);
                    setCustomDayNote("");
                    setCustomDayRegularHours(8);
                    setCustomDayPunchIn("09:00");
                    setCustomDayPunchOut("17:00");
                    setCustomDayStatus("Custom Entry");
                    setSyncToPunches(true);
                    setShowAddDayModal(true);
                  }}
                  className="btn-lift inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground shadow-xs hover:opacity-90"
                  title="Add custom information or manual record for a date"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>Add Info / Day</span>
                </button>
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
                    <th className="p-2.5 text-right">Break</th>
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
                          defaultValue={day.punchInTime || ""}
                          disabled={savingDayPunch !== ""}
                          title="Records a real clock-in for this day"
                          onBlur={(e) => {
                            if (e.target.value && e.target.value !== day.punchInTime) {
                              handleSaveDayPunch(
                                selectedIntervalEmployee.id,
                                day,
                                "in",
                                e.target.value,
                              );
                            }
                          }}
                          key={`in-${day.date}-${day.punchInTime || ""}`}
                          className="px-2 py-1 rounded border bg-background font-mono text-xs w-[85px] disabled:opacity-60"
                        />
                        {day.sessions && day.sessions.length > 1 && (
                          <div className="mt-1 space-y-0.5">
                            {day.sessions.map((s, sIdx) => (
                              <div
                                key={sIdx}
                                className="text-[10px] text-muted-foreground font-mono truncate"
                                title={`Session ${sIdx + 1}: ${s.inTime} - ${s.outTime || "..."} (${formatWorkMinutes(s.durationMinutes)})`}
                              >
                                <span className="font-bold text-foreground">#{sIdx + 1}:</span>{" "}
                                {s.inTime}–{s.outTime || "..."} (
                                {formatWorkMinutes(s.durationMinutes)}
                                {s.isOvertime ? " OT" : ""})
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
                            defaultValue={day.punchOutTime || ""}
                            disabled={savingDayPunch !== ""}
                            title="Records a real clock-out for this day"
                            onBlur={(e) => {
                              if (e.target.value && e.target.value !== day.punchOutTime) {
                                handleSaveDayPunch(
                                  selectedIntervalEmployee.id,
                                  day,
                                  "out",
                                  e.target.value,
                                );
                              }
                            }}
                            key={`out-${day.date}-${day.punchOutTime || ""}`}
                            className="px-2 py-1 rounded border bg-background font-mono text-xs w-[85px] disabled:opacity-60"
                          />
                        )}
                      </td>

                      {/* Break taken */}
                      <td className="p-2.5 text-right">
                        {day.breakMinutes > 0 ? (
                          <span
                            className="font-semibold text-foreground"
                            title="Break punched by the employee"
                          >
                            {formatWorkMinutes(day.breakMinutes)}
                          </span>
                        ) : day.unloggedBreakMinutes > 0 ? (
                          <span
                            className="font-semibold text-amber-600"
                            title="No break was punched, so the shift's break allowance was deducted"
                          >
                            {formatWorkMinutes(day.unloggedBreakMinutes)}
                            <span className="block text-[10px] font-medium text-muted-foreground">
                              auto
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
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
                        {day.overtimeStatus === "approved" || day.isOvertimeApproved ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-600 text-white shadow-2xs">
                            <Check className="h-3 w-3" /> Approved
                          </span>
                        ) : day.overtimeStatus === "rejected" || day.isOvertimeRejected ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300 border border-rose-200 dark:border-rose-800 shadow-2xs">
                            <XCircle className="h-3 w-3 text-rose-600" /> Rejected
                          </span>
                        ) : day.overtimeStatus === "pending" || day.rawOvertimeHours > 0 ? (
                          <Link
                            to="/admin/overtime"
                            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 hover:bg-amber-600 text-slate-950 shadow-2xs transition"
                            title="Click to review in Overtime tab"
                          >
                            <ClockAlert className="h-3 w-3" /> Pending in OT Tab →
                          </Link>
                        ) : (
                          <span className="text-muted-foreground text-[10px]">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="p-2.5">
                        <div className="space-y-1">
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-secondary text-foreground">
                            {day.status}
                          </span>
                          {day.note && (
                            <div
                              className="flex items-center gap-1 text-[11px] text-primary font-medium bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5 max-w-[200px]"
                              title={day.note}
                            >
                              <FileText className="h-3 w-3 shrink-0 text-primary" />
                              <span className="truncate">{day.note}</span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}

                  {selectedIntervalEmployee.dailyIntervals.length === 0 && (
                    <tr>
                      <td colSpan={9} className="p-8 text-center text-muted-foreground">
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
      {/* ADD CUSTOM DAY RECORD & INFORMATION MODAL                                  */}
      {/* ========================================================================= */}
      {showAddDayModal && selectedIntervalEmployee && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-md rounded-2xl border bg-card p-5 sm:p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between border-b pb-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold">
                  <Plus className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">Record Custom Information</h3>
                  <p className="text-xs text-muted-foreground">
                    For {selectedIntervalEmployee.employeeName}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAddDayModal(false)}
                className="rounded-lg border p-1.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              {/* Date */}
              <div>
                <label className="block font-bold text-foreground mb-1">Select Date</label>
                <input
                  type="date"
                  value={customDayDate}
                  onChange={(e) => setCustomDayDate(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-medium"
                />
              </div>

              {/* Custom Info / Reason */}
              <div>
                <label className="block font-bold text-foreground mb-1">
                  Custom Information / Reason / Incident
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Typhoon delay, Client meeting offsite, Power outage, Manager approved half-day..."
                  value={customDayNote}
                  onChange={(e) => setCustomDayNote(e.target.value)}
                  className="w-full rounded-lg border bg-background px-3 py-2 font-medium"
                />
              </div>

              {/* Quick Reason Presets */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Typhoon / Bad Weather",
                  "Power / Internet Outage",
                  "Client Meeting Offsite",
                  "Manager Approved Exception",
                  "System Clock Issue",
                  "Shift Swap",
                ].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() =>
                      setCustomDayNote((prev) => (prev ? `${prev} · ${preset}` : preset))
                    }
                    className="rounded-md border bg-secondary/50 px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                  >
                    + {preset}
                  </button>
                ))}
              </div>

              {/* Regular Hours & Status */}
              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <div>
                  <label className="block font-bold text-foreground mb-1">Regular Hours (h)</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="24"
                    value={customDayRegularHours}
                    onChange={(e) => setCustomDayRegularHours(parseFloat(e.target.value) || 0)}
                    className="w-full rounded-lg border bg-background px-3 py-2 font-bold text-sky-700"
                  />
                </div>
                <div>
                  <label className="block font-bold text-foreground mb-1">Status Label</label>
                  <input
                    type="text"
                    value={customDayStatus}
                    onChange={(e) => setCustomDayStatus(e.target.value)}
                    placeholder="Custom Entry"
                    className="w-full rounded-lg border bg-background px-3 py-2 font-medium"
                  />
                </div>
              </div>

              {/* Punch In / Out Times */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-bold text-foreground mb-1">Clock In Time</label>
                  <input
                    type="time"
                    value={customDayPunchIn}
                    onChange={(e) => setCustomDayPunchIn(e.target.value)}
                    className="w-full rounded-lg border bg-background px-3 py-1.5 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-bold text-foreground mb-1">Clock Out Time</label>
                  <input
                    type="time"
                    value={customDayPunchOut}
                    onChange={(e) => setCustomDayPunchOut(e.target.value)}
                    className="w-full rounded-lg border bg-background px-3 py-1.5 font-mono"
                  />
                </div>
              </div>

              {/* Sync to punches database checkbox */}
              <label className="flex items-start gap-2 pt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={syncToPunches}
                  onChange={(e) => setSyncToPunches(e.target.checked)}
                  className="rounded border mt-0.5"
                />
                <div className="text-[11px] text-muted-foreground">
                  <span className="font-bold text-foreground">Synchronize across entire system</span>
                  <p>
                    Creates official database punch records so this date updates Dashboard,
                    Employee Profile, and Attendance Logs.
                  </p>
                </div>
              </label>
            </div>

            <div className="flex items-center justify-end gap-2 border-t pt-3">
              <button
                type="button"
                onClick={() => setShowAddDayModal(false)}
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSavingCustomDay}
                onClick={handleAddCustomDay}
                className="btn-lift rounded-lg bg-primary px-4 py-1.5 text-xs font-bold text-primary-foreground hover:opacity-90 transition-all shadow-xs disabled:opacity-50"
              >
                {isSavingCustomDay ? "Synchronizing..." : "Save & Synchronize ✓"}
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
                              <th className="p-2 text-center">Available Leave Credit</th>
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
                                <td className="p-2 text-center text-muted-foreground whitespace-nowrap">
                                  {row.availableLeaveCredit.trim() || "—"}
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
