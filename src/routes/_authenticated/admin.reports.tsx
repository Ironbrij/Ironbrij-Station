import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
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
import { calculateAttendanceSession } from "@/lib/attendance-calculation";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getEffectiveLateGraceMinutes,
  getEmployeeApprovedLeaveForDate,
  getEmployeeApprovedLeaveDates,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getShiftTimezone,
  getLeaveLabel,
  zonedDateKey,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import {
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "@/lib/company-context";
import { companyEmailBranding } from "@/lib/email-branding";

export interface DailyIntervalRecord {
  date: string;
  dayOfWeek: string;
  scheduledShift: string;
  punchInTime?: string; // HH:mm
  punchOutTime?: string; // HH:mm
  firstInPunchId?: string;
  lastOutPunchId?: string;
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
  worked: boolean; // toggle if the person worked or not
  employeeId?: string;
  employeeName: string;
  employeeEmail?: string;
  department: string;
  role: string;
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
        const date = zonedDateKey(punchedAt, shiftTimezone);
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
        const late = firstIn
          ? computeEmployeeLateness(
              toDate(firstIn.timestamp) ?? new Date(),
              employee,
              getEffectiveLateGraceMinutes(reportCompany?.lateGraceMinutes),
            )
          : null;
        const isAutoPunchOut = Boolean(lastOut?.isAuto);
        output.push({
          key: `${employee.id}-${date}`,
          employee,
          department: departments.find((item) => item.id === employee.deptId)?.name || "General",
          date,
          firstIn,
          lastOut,
          hours: calculation.regularHours + calculation.overtimeHours,
          status: holiday
            ? "Holiday"
            : approvedLeave
              ? getLeaveLabel(approvedLeave)
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
        const date = zonedDateKey(punchedAt, shiftTimezone);
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

      const dailyIntervals: DailyIntervalRecord[] = [];

      const sortedDates = Array.from(dayPunchGroups.keys()).sort();

      for (const date of sortedDates) {
        const dayPunches = dayPunchGroups.get(date) || [];
        const sorted = [...dayPunches].sort(
          (a, b) => toMillis(a.timestamp) - toMillis(b.timestamp),
        );

        const firstIn = sorted.find((punch) => punch.type === "in");
        const lastOut = [...sorted].reverse().find((punch) => punch.type === "out");

        const sessionCalc = firstIn
          ? calculateAttendanceSession({
              employee,
              company: reportCompany,
              punchIn: toDate(firstIn.timestamp) ?? new Date(),
              punchOut: lastOut ? toDate(lastOut.timestamp) ?? new Date() : null,
              requiredWorkMinutes: getRequiredWorkMinutes(employee, reportCompany),
            })
          : null;

        const approvedLeave = getEmployeeApprovedLeaveForDate(employee, employeeLeaves, date);
        const holiday = getEmployeeHoliday(reportCompany, employee, date);

        const lateness = firstIn
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

        // Check if there is an overtime request record for this day
        const otReq = overtimeRequests.find(
          (r) => r.employeeId === employee.id && r.date === date,
        );
        const isOvertimeApproved = otReq ? otReq.status === "approved" : false;

        totalRegularHours += regHours;
        if (otHours > 0) {
          if (isOvertimeApproved) {
            totalApprovedOvertimeHours += otHours;
            approvedOvertimeDatesList.push(`${date} (+${otHours.toFixed(1)}h)`);
          } else {
            totalPendingOvertimeHours += otHours;
          }
        }

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
          isMissingPunchOut,
          isAutoPunchOut,
          minutesLate: lateness?.isLate ? lateness.minutes : 0,
          regularHours: Math.round(regHours * 10) / 10,
          rawOvertimeHours: Math.round(otHours * 10) / 10,
          isOvertimeApproved,
          status: holiday
            ? "Holiday"
            : approvedLeave
              ? getLeaveLabel(approvedLeave)
              : isMissingPunchOut
                ? "Missing Punch Out"
                : isAutoPunchOut
                  ? "Auto Punched Out"
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
      const hasWork = reg > 0 || ot > 0;

      rows.push({
        id: employee.id,
        isCustom: false,
        worked: hasWork,
        employeeId: employee.id,
        employeeName: employee.name,
        employeeEmail: employee.email,
        department: departments.find((d) => d.id === employee.deptId)?.name || "General",
        role: employee.jobTitle || "V.A.",
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

  // Fix Missed Punch Out on a day (sets standard shift end time e.g. 17:00)
  function handleFixMissedPunchOut(employeeRowId: string, date: string, defaultEndTime = "17:00") {
    handleUpdateDayInterval(employeeRowId, date, {
      punchOutTime: defaultEndTime,
      isMissingPunchOut: false,
      status: "Punch Out Added by Admin",
      regularHours: 8, // standard full day
    });
    toast.success(`Fixed punch out for ${date} (set to ${defaultEndTime}, 8.0h)`);
  }

  // Toggle Overtime Approval for a specific day
  function handleToggleOvertimeApproval(employeeRowId: string, date: string) {
    const currentDay = selectedIntervalEmployee?.dailyIntervals.find((d) => d.date === date);
    if (!currentDay) return;
    const nextApproved = !currentDay.isOvertimeApproved;
    handleUpdateDayInterval(employeeRowId, date, {
      isOvertimeApproved: nextApproved,
    });

    const empId = selectedIntervalEmployee?.employeeId || employeeRowId;
    const otReq = overtimeRequests.find((r) => r.employeeId === empId && r.date === date);
    if (otReq) {
      updateDoc(doc(db(), "overtimeRequests", otReq.id), {
        status: nextApproved ? "approved" : "rejected",
        decidedBy: user?.email || "Admin",
        decidedAt: new Date().toISOString(),
      }).catch((err) => console.warn("Could not sync overtime request status:", err));
    }

    toast.success(
      nextApproved
        ? `Accepted overtime for ${date} (+${currentDay.rawOvertimeHours.toFixed(1)}h added to report)`
        : `Unaccepted overtime for ${date}`,
    );
  }

  // Approve ALL overtime sessions for an employee
  function handleApproveAllOvertime(employeeRowId: string) {
    setHasCustomEdits(true);
    const empId = selectedIntervalEmployee?.employeeId || employeeRowId;

    // Sync all matching overtimeRequests
    overtimeRequests
      .filter((r) => r.employeeId === empId && r.status !== "approved")
      .forEach((req) => {
        updateDoc(doc(db(), "overtimeRequests", req.id), {
          status: "approved",
          decidedBy: user?.email || "Admin",
          decidedAt: new Date().toISOString(),
        }).catch((err) => console.warn("Could not sync overtime request status:", err));
      });

    setReportRows((prev) =>
      prev.map((row) => {
        if (row.id !== employeeRowId) return row;

        const updatedIntervals = row.dailyIntervals.map((day) => ({
          ...day,
          isOvertimeApproved: day.rawOvertimeHours > 0 ? true : day.isOvertimeApproved,
        }));

        let newApprovedOt = 0;
        const newOtDates: string[] = [];
        for (const day of updatedIntervals) {
          if (day.rawOvertimeHours > 0) {
            newApprovedOt += day.rawOvertimeHours;
            newOtDates.push(`${day.date} (+${day.rawOvertimeHours.toFixed(1)}h)`);
          }
        }

        const updatedRow: ReportRow = {
          ...row,
          dailyIntervals: updatedIntervals,
          overtimeHours: Math.round(newApprovedOt * 10) / 10,
          pendingOvertimeHours: 0,
          overtimeDates: newOtDates,
        };

        if (selectedIntervalEmployee?.id === employeeRowId) {
          setSelectedIntervalEmployee(updatedRow);
        }

        return updatedRow;
      }),
    );
    toast.success("Approved all overtime sessions for this report.");
  }

  // Approve ALL overtime across the ENTIRE company report
  function handleApproveAllOvertimeGlobal() {
    setHasCustomEdits(true);
    setReportRows((prev) =>
      prev.map((row) => {
        const updatedIntervals = row.dailyIntervals.map((day) => ({
          ...day,
          isOvertimeApproved: day.rawOvertimeHours > 0 ? true : day.isOvertimeApproved,
        }));

        let newApprovedOt = 0;
        const newOtDates: string[] = [];
        for (const day of updatedIntervals) {
          if (day.rawOvertimeHours > 0) {
            newApprovedOt += day.rawOvertimeHours;
            newOtDates.push(`${day.date} (+${day.rawOvertimeHours.toFixed(1)}h)`);
          }
        }

        const fallbackOt =
          newApprovedOt > 0 ? newApprovedOt : row.overtimeHours + row.pendingOvertimeHours;

        return {
          ...row,
          dailyIntervals: updatedIntervals,
          overtimeHours: Math.round(fallbackOt * 10) / 10,
          pendingOvertimeHours: 0,
          overtimeDates: newOtDates.length ? newOtDates : row.overtimeDates,
        };
      }),
    );
    toast.success("Accepted and approved all overtime across all employees!");
  }

  // Toggle Overtime Approval directly from table row
  function handleToggleRowOvertimeApproval(employeeRowId: string) {
    const row = reportRows.find((r) => r.id === employeeRowId);
    if (!row) return;
    if (row.overtimeHours > 0) {
      // Unaccept
      handleUpdateRowField(employeeRowId, "overtimeHours", 0);
      handleUpdateRowField(employeeRowId, "overtimeDates", []);
      toast.success(`Marked ${row.employeeName}'s overtime as unaccepted`);
    } else {
      // Accept
      handleApproveAllOvertime(employeeRowId);
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
          rows: reportRows.map((r) => ({
            employeeName: r.employeeName,
            employeeEmail: r.employeeEmail,
            role: r.role,
            department: r.department,
            regularHours: Number(r.regularHours) || 0,
            overtimeHours: Number(r.overtimeHours) || 0,
            overtimeDates: r.overtimeDates,
            paidLeaveDays: Number(r.paidLeaveDays) || 0,
            unpaidLeaveDays: Number(r.unpaidLeaveDays) || 0,
            remarks: r.remarks,
          })),
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
      "Regular Hours": Number(row.regularHours).toFixed(1),
      "Accepted Overtime Hours": Number(row.overtimeHours).toFixed(1),
      "Overtime Dates": row.overtimeDates.join("; "),
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
      const otText =
        row.overtimeHours > 0
          ? `+${Number(row.overtimeHours).toFixed(1)}h ${row.overtimeDates.length ? `(${row.overtimeDates.length} dates)` : ""}`
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
                  onClick={handleApproveAllOvertimeGlobal}
                  className="rounded-md bg-amber-500/10 hover:bg-amber-500/20 text-amber-900 border border-amber-500/30 px-3.5 py-2 text-xs font-bold flex items-center justify-center gap-1.5 transition"
                  title="Approve all calculated overtime for all employees"
                >
                  <ShieldCheck className="h-4 w-4 text-amber-700" /> Accept All Overtime
                </button>

                <button
                  onClick={openSendEmailModal}
                  className="rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 text-xs font-bold flex items-center justify-center gap-2 shadow-sm transition"
                >
                  <Mail className="h-4 w-4" /> Send Report to Them
                </button>
              </>
            )}

            <button
              onClick={viewMode === "summary" ? exportSummaryCsv : () => {}}
              className="rounded-md border px-3.5 py-2 text-xs font-bold text-foreground hover:bg-secondary flex items-center justify-center gap-1.5"
            >
              <Download className="h-4 w-4 text-muted-foreground" /> CSV
            </button>
            <button
              onClick={viewMode === "summary" ? exportSummaryPdf : () => {}}
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
          <div className="px-4 py-3 bg-blue-50/70 border-b border-blue-100 flex items-center justify-between text-xs text-blue-900 gap-2">
            <div className="flex items-center gap-2 font-medium">
              <Info className="h-4 w-4 text-blue-600 shrink-0" />
              <span>
                <strong>Spreadsheet & Interval Inspection:</strong> Click on{" "}
                <span className="font-bold text-primary underline">Inspect Daily Intervals</span> on
                any employee to see day-by-day hours, fix missed punch-outs, and accept/approve
                overtimes.
              </span>
            </div>
            {hasCustomEdits && (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
                Custom Edits Active
              </span>
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
                  <th className="p-3 font-bold min-w-[130px] text-right">Overtime & Approval</th>
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

                    {/* Employee Name & Email */}
                    <td className="p-3">
                      <input
                        type="text"
                        value={row.employeeName}
                        onChange={(e) =>
                          handleUpdateRowField(row.id, "employeeName", e.target.value)
                        }
                        placeholder="Employee Name"
                        className="w-full font-bold text-foreground text-xs px-2 py-1.5 rounded border border-transparent hover:border-border focus:border-primary bg-transparent focus:bg-background outline-none transition"
                      />
                      {row.employeeEmail && (
                        <div className="text-[11px] text-muted-foreground px-2">
                          {row.employeeEmail}
                        </div>
                      )}
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

                    {/* Accepted Overtime Hours Input & 1-Click Acceptance Button */}
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

                      {/* 1-Click Accept Overtime button for this employee */}
                      {(row.overtimeHours > 0 ||
                        row.pendingOvertimeHours > 0 ||
                        (row.dailyIntervals &&
                          row.dailyIntervals.some((d) => d.rawOvertimeHours > 0))) && (
                        <button
                          type="button"
                          onClick={() => handleToggleRowOvertimeApproval(row.id)}
                          className={`mt-1.5 w-full text-[10px] font-bold py-1 px-2 rounded-md flex items-center justify-center gap-1 transition shadow-xs ${
                            row.overtimeHours > 0
                              ? "bg-emerald-600 text-white hover:bg-emerald-700"
                              : "bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200"
                          }`}
                          title="Click to toggle acceptance of this employee's overtime"
                        >
                          {row.overtimeHours > 0 ? (
                            <>
                              <Check className="h-3 w-3" /> Accepted
                            </>
                          ) : (
                            <>
                              <ClockAlert className="h-3 w-3 text-amber-700" /> Accept OT (+
                              {row.pendingOvertimeHours.toFixed(1)}h)
                            </>
                          )}
                        </button>
                      )}
                    </td>

                    {/* Overtime Dates Input */}
                    <td className="p-3">
                      <input
                        type="text"
                        value={row.overtimeDates.join(", ")}
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
                  type="button"
                  onClick={() => handleApproveAllOvertime(selectedIntervalEmployee.id)}
                  className="rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-800 border border-amber-500/30 px-3 py-1.5 text-xs font-bold flex items-center gap-1.5"
                >
                  <CheckCheck className="h-3.5 w-3.5" /> Accept All Overtime
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
                    <th className="p-2.5 text-right">Regular (h)</th>
                    <th className="p-2.5 text-right">Overtime (h)</th>
                    <th className="p-2.5 text-center">Overtime Approval</th>
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
                              className="px-2 py-0.5 rounded bg-amber-500 text-white font-bold text-[10px] hover:bg-amber-600 shadow-sm"
                            >
                              Fix End (17:00)
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

                      {/* Overtime Acceptance Toggle */}
                      <td className="p-2.5 text-center">
                        {day.rawOvertimeHours > 0 ? (
                          <button
                            type="button"
                            onClick={() =>
                              handleToggleOvertimeApproval(selectedIntervalEmployee.id, day.date)
                            }
                            className={`px-2.5 py-1 rounded-md text-[11px] font-bold flex items-center justify-center gap-1 mx-auto transition ${
                              day.isOvertimeApproved
                                ? "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
                                : "bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-200"
                            }`}
                          >
                            {day.isOvertimeApproved ? (
                              <>
                                <ShieldCheck className="h-3.5 w-3.5" /> Accepted
                              </>
                            ) : (
                              <>
                                <ClockAlert className="h-3.5 w-3.5" /> Accept OT
                              </>
                            )}
                          </button>
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
          <div className="rounded-2xl border bg-card max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
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
                    <div className="text-muted-foreground text-[11px]">
                      + Full table of {reportRows.length} team member
                      {reportRows.length === 1 ? "" : "s"} with live edited hours and remarks.
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
                  value={newRowData.overtimeDates.join(", ")}
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
