import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, setDoc, Timestamp } from "firebase/firestore";
import {
  ArrowLeft,
  BriefcaseBusiness,
  CalendarDays,
  Clock3,
  Download,
  FileText,
  Globe2,
  History,
  LogIn,
  Mail,
  MapPin,
  TrendingUp,
  UserRound,
  Wrench,
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
  type OvertimeStatus,
  type Punch,
} from "@/lib/types";
import { computeDay, COUNTRY_TIMEZONES, toDate, toMillis } from "@/lib/time";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getActiveEmployeeLeave,
  getEffectiveEmployeeWorkingDays,
  getEffectiveLateGraceMinutes,
  getEmployeeApprovedLeaveForDate,
  getEmployeeApprovedLeaveDates,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getLeaveLabel,
  getShiftTimezone,
  zonedDateKey,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import { normalizeState } from "@/lib/states";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { resolveProfilePhoto } from "@/lib/profile-photo";
import { formatShiftRange, formatWorkingDaysSummary, PromoteModal } from "./admin.employees";
import {
  calculateShiftMinutes,
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "@/lib/company-context";
import { calculateAttendanceSession, formatWorkMinutes } from "@/lib/attendance-calculation";
import { getEmployeeAllShiftDefinitions, findShiftConflicts } from "@/lib/shift-conflict";
import { ShiftConflictAlert } from "@/components/ShiftConflictAlert";

export const Route = createFileRoute("/_authenticated/admin/employees/$id")({
  head: () => ({ meta: [{ title: "Employee Profile — SavyTimes Admin" }] }),
  component: EmployeeDetail,
});

type HistoryScope = "all" | "month";

type UserAccount = {
  uid: string;
  email?: string;
  name?: string;
  photoUrl?: string;
  photoURL?: string;
  picture?: string;
  lastLogin?: string;
};

type DayRow = {
  date: string;
  punches: Punch[];
  firstIn?: Punch;
  lastOut?: Punch;
  hours: number;
  normalMinutes: number;
  overtimeMinutes: number;
  requiredMinutes: number;
  minutesLate: number;
  status: string;
  isAutoPunchOut: boolean;
  scheduledAt?: Date;
  isOvertimeApproved: boolean;
  isOvertimePending: boolean;
  otStatus?: OvertimeStatus;
  otRequestId?: string;
};

function EmployeeDetail() {
  const { id } = Route.useParams();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoaded, setEmployeesLoaded] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [overtimeRequests, setOvertimeRequests] = useState<OvertimeRequest[]>([]);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [historyScope, setHistoryScope] = useState<HistoryScope>("all");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [now, setNow] = useState(() => new Date());
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const { company, activeCompanyId, user } = useAuth();
  const graceMinutes = getEffectiveLateGraceMinutes(company?.lateGraceMinutes);

  // Fix missing punch state
  const [fixingRow, setFixingRow] = useState<DayRow | null>(null);
  const [fixTime, setFixTime] = useState("");
  const [fixBusy, setFixBusy] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    const unsubscribers = [
      onSnapshot(collection(db(), "companies"), (snapshot) =>
        setCompanies(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Company, "id">) })),
        ),
      ),
      onSnapshot(collection(db(), "employees"), (snapshot) => {
        setEmployees(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Employee, "id">),
          })),
        );
        setEmployeesLoaded(true);
      }),
      onSnapshot(collection(db(), "departments"), (snapshot) =>
        setDepartments(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Department, "id">),
          })),
        ),
      ),
      onSnapshot(collection(db(), "punches"), (snapshot) =>
        setAllPunches(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Punch, "id">),
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
      onSnapshot(collection(db(), "overtimeRequests"), (snapshot) =>
        setOvertimeRequests(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<OvertimeRequest, "id">),
          })),
        ),
      ),
      onSnapshot(collection(db(), "users"), (snapshot) =>
        setUsers(
          snapshot.docs.map((item) => ({
            uid: item.id,
            ...(item.data() as Omit<UserAccount, "uid">),
          })),
        ),
      ),
    ];
    return () => {
      window.clearInterval(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const rawEmployee = useMemo(
    () => employees.find((item) => item.id === id || item.authUid === id),
    [employees, id],
  );
  const employee = useMemo(
    () => (rawEmployee ? getEmployeeForCompany(rawEmployee, activeCompanyId) : undefined),
    [activeCompanyId, rawEmployee],
  );

  const punches = useMemo(() => {
    if (!employee) return [];
    const ids = new Set([employee.id, employee.authUid].filter(Boolean));
    return allPunches
      .filter(
        (punch) =>
          ids.has(punch.employeeId) &&
          punch.timestamp &&
          getPunchCompanyId(punch, rawEmployee) === activeCompanyId,
      )
      .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
  }, [activeCompanyId, allPunches, employee, rawEmployee]);

  const companyLeaves = useMemo(() => {
    if (!employee) return [];
    return leaves.filter(
      (leave) =>
        (leave.companyId || rawEmployee?.companyIds?.[0] || rawEmployee?.companyId) ===
        activeCompanyId,
    );
  }, [activeCompanyId, employee, leaves, rawEmployee]);

  const rows = useMemo(() => {
    if (!employee) return [];
    const groups = new Map<string, Punch[]>();
    const timezone = getShiftTimezone(employee);
    const today = zonedDateKey(now, timezone);

    for (const punch of punches) {
      const punchedAt = toDate(punch.timestamp);
      if (!punchedAt) continue;
      const date = punch.attendanceDate || punch.date || zonedDateKey(punchedAt, timezone);
      if (date > today) continue;
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(punch);
    }
    for (const date of getEmployeeHolidayDates(company, employee)) {
      if (date <= today && !groups.has(date)) groups.set(date, []);
    }
    for (const date of getEmployeeApprovedLeaveDates(employee, companyLeaves)) {
      if (date <= today && !groups.has(date)) groups.set(date, []);
    }

    const output: DayRow[] = [];
    for (const [date, dayPunches] of groups) {
      const sorted = [...dayPunches].sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
      const firstIn = sorted.find((punch) => punch.type === "in");
      const lastOut = [...sorted].reverse().find((punch) => punch.type === "out");
      const rawCalculation = computeDay(sorted);
      const approvedLeave = getEmployeeApprovedLeaveForDate(employee, companyLeaves, date);
      const holiday = getEmployeeHoliday(company, employee, date);
      const [shiftYear, shiftMonth, shiftDay] = date.split("-").map(Number);
      const shiftWeekday = new Date(Date.UTC(shiftYear, shiftMonth - 1, shiftDay)).getUTCDay();
      const effectiveWorkingDays = getEffectiveEmployeeWorkingDays(employee, company?.workingDays);
      const isScheduledDay = effectiveWorkingDays.includes(shiftWeekday) && !holiday;
      const isOffShiftDay = !isScheduledDay;

      const isExcused = Boolean(firstIn?.isExcused);
      const lateness =
        firstIn && isScheduledDay
          ? computeEmployeeLateness(
              toDate(firstIn.timestamp) ?? new Date(),
              employee,
              graceMinutes,
              isExcused,
            )
          : null;
      const isAutoPunchOut = Boolean(lastOut?.isAuto);
      const attendanceCalculation = firstIn
        ? calculateAttendanceSession({
            employee,
            company,
            punchIn: toDate(firstIn.timestamp) ?? new Date(),
            punchOut: toDate(lastOut?.timestamp) || null,
            now,
            requiredWorkMinutes: getRequiredWorkMinutes(employee, company),
            isOffShiftDay,
          })
        : null;
      const extraOvertimeMinutes = Math.round(rawCalculation.overtimeHours * 60);
      const normalMinutes = attendanceCalculation?.normalWorkMinutes || 0;
      const overtimeMinutes = (attendanceCalculation?.overtimeMinutes || 0) + extraOvertimeMinutes;
      const requiredMinutes =
        attendanceCalculation?.requiredWorkMinutes || getRequiredWorkMinutes(employee, company);

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

      const isOvertimeApproved = approvedDayOtMinutes > 0;
      const isOvertimePending =
        pendingDayOtMinutes > 0 || (dayOtRequests.length === 0 && overtimeMinutes > 0);
      const otStatus =
        dayOtRequests.length > 0
          ? approvedDayOtMinutes > 0
            ? "approved"
            : pendingDayOtMinutes > 0
              ? "pending"
              : "rejected"
          : undefined;
      const otRequestId = dayOtRequests[0]?.id;

      output.push({
        date,
        punches: sorted,
        firstIn,
        lastOut,
        hours: (normalMinutes + (approvedDayOtMinutes > 0 ? approvedDayOtMinutes : 0)) / 60,
        normalMinutes,
        overtimeMinutes,
        requiredMinutes,
        minutesLate: !holiday && !approvedLeave && lateness?.isLate ? lateness.minutes : 0,
        scheduledAt: lateness?.scheduledAt,
        isAutoPunchOut,
        isOvertimeApproved,
        isOvertimePending,
        otStatus,
        otRequestId,
        status: holiday
          ? holiday.name || "Holiday"
          : approvedLeave
            ? getLeaveLabel(approvedLeave)
            : !firstIn
              ? sorted.length
                ? "Extra time only"
                : isOffShiftDay
                  ? "Off day"
                  : "No punch in"
              : !lastOut
                ? attendanceCalculation?.missingPunchOut
                  ? "Missing punch out"
                  : "Still punched in"
                : isAutoPunchOut
                  ? lateness?.isLate
                    ? "Auto punched out · Late"
                    : "Auto punched out"
                  : isExcused
                    ? "Excused (Not Late)"
                    : lateness?.isLate
                      ? "Late"
                      : "On time",
      });
    }
    return output.sort((a, b) => b.date.localeCompare(a.date));
  }, [employee, punches, companyLeaves, company, graceMinutes, now, overtimeRequests]);

  const visibleRows = useMemo(
    () => (historyScope === "all" ? rows : rows.filter((row) => row.date.startsWith(month))),
    [rows, historyScope, month],
  );

  const liveStatus = useMemo(
    () =>
      employee
        ? getLiveAttendanceStatus(
            employee,
            punches,
            now,
            graceMinutes,
            company?.workingDays,
            getEmployeeHolidayDates(company, employee),
          )
        : null,
    [employee, punches, now, company, graceMinutes],
  );

  const profileShiftConflicts = useMemo(() => {
    if (!employee) return [];
    const allDefs = getEmployeeAllShiftDefinitions(employee, companies);
    return findShiftConflicts(allDefs);
  }, [employee, companies]);

  const activeLeave = useMemo(
    () => (employee ? getActiveEmployeeLeave(employee, companyLeaves, now) : null),
    [employee, companyLeaves, now],
  );

  const approvedLeaveToday = useMemo(
    () =>
      employee
        ? getEmployeeApprovedLeaveForDate(
            employee,
            companyLeaves,
            zonedDateKey(now, getShiftTimezone(employee)),
          )
        : null,
    [employee, companyLeaves, now],
  );

  const onHolidayToday = useMemo(
    () =>
      employee
        ? Boolean(
            getEmployeeHoliday(company, employee, zonedDateKey(now, getShiftTimezone(employee))),
          )
        : false,
    [company, employee, now],
  );

  const employeeLeaves = useMemo(() => {
    if (!employee) return [];
    return companyLeaves
      .filter((leave) => leave.employeeId === employee.id || leave.employeeId === employee.authUid)
      .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom));
  }, [companyLeaves, employee]);

  const matchedUser = useMemo(() => {
    if (!employee) return undefined;
    const email = employee.email?.toLowerCase();
    return users.find(
      (item) =>
        item.uid === employee.authUid ||
        item.uid === employee.id ||
        Boolean(email && item.email?.toLowerCase() === email),
    );
  }, [employee, users]);

  const attendanceDays = rows.filter((row) => row.firstIn).length;
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0);
  const lateRows = rows.filter((row) => row.minutesLate > 0);
  const totalLateMinutes = lateRows.reduce((sum, row) => sum + row.minutesLate, 0);
  const averageLateMinutes = lateRows.length ? totalLateMinutes / lateRows.length : 0;
  const lateRate = attendanceDays ? (lateRows.length / attendanceDays) * 100 : 0;
  const firstActivity = toDate(punches.at(0)?.timestamp) ?? new Date();
  const lastActivity = toDate(punches.at(-1)?.timestamp);

  function exportRows() {
    if (!employee) return [];
    const timezone = getEmployeeTimezone(employee);
    return visibleRows.map((row) => ({
      Employee: employee.name,
      Email: employee.email,
      ShiftDate: row.date,
      EmployeeTimezone: timezone,
      ShiftTimezone: getShiftTimezone(employee),
      PunchIn: row.firstIn
        ? formatInTimezone(toDate(row.firstIn.timestamp) ?? new Date(), timezone, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
        : "",
      PunchOut: row.lastOut
        ? formatInTimezone(toDate(row.lastOut.timestamp) ?? new Date(), timezone, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
        : "",
      Hours: row.hours.toFixed(2),
      RequiredMinutes: row.requiredMinutes,
      NormalWorkMinutes: row.normalMinutes,
      OvertimeMinutes: row.overtimeMinutes,
      OvertimeStatus:
        row.overtimeMinutes > 0
          ? row.isOvertimeApproved
            ? "Approved"
            : row.otStatus === "rejected"
              ? "Rejected"
              : "Pending"
          : "N/A",
      Status: row.status,
      MinutesLate: row.minutesLate,
      AllEvents: row.punches
        .map(
          (punch) =>
            `${formatPunchType(punch.type)} ${formatInTimezone(toDate(punch.timestamp) ?? new Date(), timezone)}`,
        )
        .join(" | "),
    }));
  }

  function fileSuffix() {
    return historyScope === "all" ? "all_time" : month;
  }

  function downloadCsv() {
    if (!employee || !visibleRows.length)
      return toast.error("No attendance records for this period.");
    const blob = new Blob([Papa.unparse(exportRows())], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${employee.name.replace(/\s+/g, "_")}_${fileSuffix()}_attendance.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Employee CSV downloaded");
  }

  function downloadPdf() {
    if (!employee || !visibleRows.length)
      return toast.error("No attendance records for this period.");
    const timezone = getEmployeeTimezone(employee);
    const pdf = new jsPDF();
    pdf.setFontSize(16);
    pdf.text(`${employee.name} — Attendance`, 14, 17);
    pdf.setFontSize(9);
    pdf.text(
      `${historyScope === "all" ? "All history" : month} · ${timezone} · ${visibleRows.length} records`,
      14,
      24,
    );
    let y = 36;
    pdf.setFont("helvetica", "bold");
    pdf.text("Date", 14, y);
    pdf.text("In", 48, y);
    pdf.text("Out", 80, y);
    pdf.text("Hours", 112, y);
    pdf.text("Status", 140, y);
    pdf.setFont("helvetica", "normal");
    for (const row of visibleRows) {
      y += 7;
      if (y > 280) {
        pdf.addPage();
        y = 20;
      }
      pdf.text(row.date, 14, y);
      pdf.text(
        row.firstIn ? formatInTimezone(toDate(row.firstIn.timestamp) ?? new Date(), timezone) : "—",
        48,
        y,
      );
      pdf.text(
        row.lastOut ? formatInTimezone(toDate(row.lastOut.timestamp) ?? new Date(), timezone) : "—",
        80,
        y,
      );
      pdf.text(row.hours.toFixed(2), 112, y);
      pdf.text(row.minutesLate ? `Late ${row.minutesLate}m` : row.status.slice(0, 28), 140, y);
    }
    pdf.save(`${employee.name.replace(/\s+/g, "_")}_${fileSuffix()}_attendance.pdf`);
    toast.success("Employee PDF downloaded");
  }

  if (!employee) {
    return (
      <div className="rounded-2xl border bg-card p-12 text-center shadow-lift">
        <UserRound className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="mt-3 text-lg font-bold text-primary">
          {employeesLoaded ? "Employee profile not found" : "Loading employee profile…"}
        </h1>
        {employeesLoaded && (
          <Link
            to="/admin/employees"
            className="mt-4 inline-flex items-center gap-1 rounded-md border px-3 py-2 text-sm font-bold text-primary"
          >
            <ArrowLeft className="h-4 w-4" /> Back to employees
          </Link>
        )}
      </div>
    );
  }

  const timezone = getEmployeeTimezone(employee);
  const shiftTimezone = getShiftTimezone(employee);
  const department =
    departments.find((item) => item.id === employee.deptId)?.name || "No department";
  const country = COUNTRY_TIMEZONES[employee.country ?? "NP"] || COUNTRY_TIMEZONES.NP;
  const photoUrl = resolveProfilePhoto(matchedUser, employee);
  const lastLogin = formatOptionalDate(matchedUser?.lastLogin, timezone);
  const historyStart = firstActivity
    ? formatInTimezone(firstActivity, timezone, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "No activity yet";
  const liveLabel = onHolidayToday
    ? "Holiday"
    : approvedLeaveToday || activeLeave
      ? getLeaveLabel(approvedLeaveToday || activeLeave!)
      : liveStatus?.isPunchedIn
        ? "Punched in"
        : "Punched out";

  async function handleFixMissingPunch() {
    if (!fixingRow || !fixTime || !employee) return;
    setFixBusy(true);
    try {
      // Parse the time input and combine with the row date
      const [hours, minutes] = fixTime.split(":").map(Number);
      const punchOutDate = new Date(`${fixingRow.date}T${fixTime}:00`);
      if (Number.isNaN(punchOutDate.getTime())) {
        toast.error("Invalid time entered.");
        return;
      }

      const punchInPunch = fixingRow.firstIn;
      const empCompanyId = punchInPunch?.companyId || activeCompanyId;
      const requiredWorkMinutes = getRequiredWorkMinutes(
        employee,
        companies.find((c) => c.id === empCompanyId),
      );

      // Calculate session stats
      const calculation = punchInPunch?.timestamp
        ? calculateAttendanceSession({
            employee,
            company: companies.find((c) => c.id === empCompanyId),
            punchIn: toDate(punchInPunch.timestamp) ?? new Date(),
            punchOut: punchOutDate,
            requiredWorkMinutes,
            isOffShiftDay: Boolean(punchInPunch.isOffShiftDay),
          })
        : null;

      const punchRef = await addDoc(collection(db(), "punches"), {
        employeeId: employee.id,
        employeeName: employee.name,
        companyId: empCompanyId,
        companyName: punchInPunch?.companyName || company?.name || "Company",
        date: fixingRow.date,
        attendanceDate: fixingRow.date,
        type: "out" as const,
        timestamp: Timestamp.fromDate(punchOutDate),
        source: "app" as const,
        isAuto: false,
        isAdminFix: true,
        adminFixedBy: user?.email || "admin",
        adminFixedAt: new Date().toISOString(),
        scheduledShiftStart: punchInPunch?.scheduledShiftStart || "",
        scheduledShiftEnd: punchInPunch?.scheduledShiftEnd || "",
        shiftTimezone: punchInPunch?.shiftTimezone || timezone,
        requiredWorkMinutes,
        isOffShiftDay: Boolean(punchInPunch?.isOffShiftDay),
        ...(calculation
          ? {
              normalWorkMinutes: calculation.normalWorkMinutes,
              overtimeMinutes: calculation.overtimeMinutes,
              totalEligibleMinutes: calculation.totalEligibleMinutes,
              attendanceStatus: calculation.status,
            }
          : { attendanceStatus: "complete" }),
      });

      // If there was overtime, create a pending overtime request
      if (calculation && calculation.overtimeMinutes > 0) {
        const isOffShift = Boolean(punchInPunch?.isOffShiftDay);
        const reason = isOffShift
          ? `Worked ${formatWorkMinutes(calculation.overtimeMinutes)} on off-shift day (admin fix)`
          : `Worked ${formatWorkMinutes(calculation.overtimeMinutes)} past shift (admin fix)`;
        await addDoc(collection(db(), "overtimeRequests"), {
          employeeId: employee.id,
          employeeName: employee.name,
          companyId: empCompanyId,
          date: fixingRow.date,
          requestType: isOffShift ? "off_shift_work" : "overtime",
          punchOutId: punchRef.id,
          punchInId: punchInPunch?.id || "",
          overtimeMinutes: calculation.overtimeMinutes,
          normalWorkMinutes: calculation.normalWorkMinutes,
          isOffShiftDay: isOffShift,
          reason,
          status: "pending",
          createdAt: new Date().toISOString(),
        });
      }

      toast.success(
        `Missing punch-out fixed for ${fixingRow.date} at ${fixTime}. ${
          calculation
            ? `Normal: ${formatWorkMinutes(calculation.normalWorkMinutes)}, OT: ${formatWorkMinutes(calculation.overtimeMinutes)}`
            : ""
        }`,
      );
      setFixingRow(null);
      setFixTime("");
    } catch (err) {
      console.error("Fix missing punch error:", err);
      toast.error("Failed to fix punch: " + (err as Error).message);
    } finally {
      setFixBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Link
        to="/admin/employees"
        className="inline-flex items-center gap-1.5 text-sm font-bold text-muted-foreground transition-colors hover:text-primary"
      >
        <ArrowLeft className="h-4 w-4" /> Employees
      </Link>

      <section className="rounded-xl border bg-card p-5 shadow-sm sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <ProfileAvatar
            name={employee.name}
            photoUrl={photoUrl}
            className="h-24 w-24 text-2xl ring-1 ring-border"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
                  {employee.name?.trim() || employee.email?.trim() || "Unnamed Employee"}
                </h1>
                <span
                  className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                    employee.status === "inactive"
                      ? "bg-rose-500/10 text-rose-700"
                      : "bg-emerald-500/10 text-emerald-700"
                  }`}
                >
                  {employee.status === "inactive" ? "Suspended" : liveLabel}
                </span>
                {!onHolidayToday && !approvedLeaveToday && !activeLeave && liveStatus?.isLate && (
                  <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-700">
                    {liveStatus.isMissingLate ? "Not punched in · " : ""}
                    {liveStatus.minutesLate} min late
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setEditingEmployee(employee)}
                className="shrink-0 rounded-md border bg-background px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Edit profile and shift
              </button>
            </div>
            <p className="mt-1 text-sm font-semibold text-foreground/80">
              {employee.jobTitle || "Team member"} · {department}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Attendance history from {historyStart} through today · {graceMinutes}-minute grace
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-x-10 gap-y-1 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailRow
            icon={<Mail className="h-4 w-4" />}
            label="Email"
            value={employee.email || "Not provided"}
          />
          <DetailRow
            icon={<BriefcaseBusiness className="h-4 w-4" />}
            label="Role"
            value={employee.jobTitle || "Team member"}
          />
          <DetailRow icon={<MapPin className="h-4 w-4" />} label="Department" value={department} />
          <DetailRow
            icon={<Globe2 className="h-4 w-4" />}
            label="Country"
            value={`${country.flag} ${country.name}`}
          />
          <DetailRow
            icon={<MapPin className="h-4 w-4" />}
            label="Region"
            value={normalizeState(employee.state)}
          />
          <DetailRow
            icon={<Clock3 className="h-4 w-4" />}
            label="Shift"
            value={formatShiftRange(
              employee.shiftStartTime,
              employee.shiftEndTime,
              employee.isMultipleShift,
              employee.shifts,
            )}
          />
          <DetailRow
            icon={<CalendarDays className="h-4 w-4" />}
            label="Working days"
            value={formatWorkingDaysSummary(employee.workingDays)}
          />
          <DetailRow label="Local timezone" value={timezone} />
          <DetailRow label="Shift timezone" value={shiftTimezone} />
          <DetailRow label="Last app login" value={lastLogin || "Not recorded"} />
          <DetailRow
            label="Last attendance activity"
            value={
              lastActivity
                ? formatInTimezone(lastActivity, timezone, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })
                : "Not recorded"
            }
          />
          <DetailRow label="Employee ID" value={employee.id} />
        </div>

        {/* Company-specific shift & working days breakdown */}
        {employee.companyMemberships && Object.keys(employee.companyMemberships).length > 0 && (
          <div className="mt-4 border-t pt-4 space-y-2">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
              Company-Specific Shifts & Working Days
            </h3>
            {profileShiftConflicts.length > 0 && (
              <ShiftConflictAlert conflicts={profileShiftConflicts} className="mb-2" />
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(employee.companyMemberships).map(([cId, m]) => {
                const comp = companies.find((c) => (c.id || COMPANY_ID) === cId);
                const compName = comp?.name || (cId === COMPANY_ID ? "Main Company" : cId);
                const isMulti = Boolean(m.isMultipleShift);
                const shiftText = formatShiftRange(
                  m.shiftStartTime,
                  m.shiftEndTime,
                  isMulti,
                  m.shifts,
                );
                const daysText = formatWorkingDaysSummary(m.workingDays);

                return (
                  <div
                    key={cId}
                    className="rounded-lg border bg-secondary/30 p-2.5 text-xs space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-bold text-primary">{compName}</span>
                      <div className="flex items-center gap-1">
                        {m.departmentId && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-muted text-foreground border border-border">
                            {departments.find((d) => d.id === m.departmentId)?.name || "General"}
                          </span>
                        )}
                        {isMulti && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
                            Multi-Shift ({m.shifts?.length || 0})
                          </span>
                        )}
                      </div>
                    </div>
                    {isMulti && m.shifts && m.shifts.length > 0 ? (
                      <div className="space-y-1 pt-0.5">
                        {m.shifts.map((s, idx) => {
                          const sDaysText = formatWorkingDaysSummary(
                            s.workingDays || m.workingDays,
                          );
                          return (
                            <div
                              key={idx}
                              className="rounded bg-background/60 p-1.5 border border-border/40 text-[11px] space-y-0.5"
                            >
                              <div className="flex items-center justify-between font-semibold">
                                <span className="text-foreground">
                                  Shift #{idx + 1}: {formatShiftRange(s.startTime, s.endTime)}
                                </span>
                                <span className="font-mono text-primary font-bold">
                                  {Number(
                                    (calculateShiftMinutes(s.startTime, s.endTime) / 60).toFixed(1),
                                  )}
                                  h
                                </span>
                              </div>
                              <div className="text-muted-foreground flex items-center gap-1 text-[10px]">
                                <CalendarDays className="h-3 w-3" />
                                <span>{sDaysText}</span>
                              </div>
                            </div>
                          );
                        })}
                        <div className="text-muted-foreground font-semibold flex items-center gap-1.5 pt-0.5 text-[11px]">
                          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>Overall: {daysText}</span>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-foreground font-medium flex items-center gap-1.5">
                          <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>{shiftText}</span>
                        </div>
                        <div className="text-muted-foreground font-semibold flex items-center gap-1.5">
                          <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                          <span>{daysText}</span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-primary">All-time performance</h2>
            <p className="text-xs text-muted-foreground">
              Calculated from every recorded regular attendance day.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <MetricCard
            label="Attendance days"
            value={attendanceDays.toLocaleString()}
            note="Punch-in days"
          />
          <MetricCard label="Hours recorded" value={totalHours.toFixed(1)} note="Regular + extra" />
          <MetricCard
            label="Late arrivals"
            value={lateRows.length.toLocaleString()}
            note={`Over ${graceMinutes} minutes`}
            tone="amber"
          />
          <MetricCard
            label="Average late"
            value={`${formatDecimal(averageLateMinutes)} min`}
            note="On late days"
            tone="amber"
          />
          <MetricCard
            label="Late rate"
            value={`${formatDecimal(lateRate)}%`}
            note="Late ÷ attended"
            tone={lateRate > 0 ? "amber" : "green"}
          />
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border bg-card shadow-lift">
        <div className="flex flex-col gap-3 border-b p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-black text-primary">
              <TrendingUp className="h-4 w-4" /> Late arrival history
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Every late arrival on record. Punches 5 minutes late or less are excluded.
            </p>
          </div>
          <span className="w-fit rounded-full bg-amber-500/10 px-3 py-1 text-xs font-black text-amber-700">
            {lateRows.length} {lateRows.length === 1 ? "late arrival" : "late arrivals"}
          </span>
        </div>
        <div className="max-h-[360px] overflow-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead className="sticky top-0 bg-secondary text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3.5">Shift date</th>
                <th className="p-3.5">Scheduled</th>
                <th className="p-3.5">Arrived</th>
                <th className="p-3.5">Late by</th>
                <th className="p-3.5">Outcome</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lateRows.map((row) => (
                <tr key={`late-${row.date}`} className="hover:bg-secondary/30">
                  <td className="p-3.5 font-mono text-xs">{row.date}</td>
                  <td className="p-3.5 font-mono text-xs">
                    {row.scheduledAt ? formatInTimezone(row.scheduledAt, timezone) : "—"}
                  </td>
                  <td className="p-3.5 font-mono text-xs">
                    {row.firstIn
                      ? formatInTimezone(toDate(row.firstIn.timestamp) ?? new Date(), timezone)
                      : "—"}
                  </td>
                  <td className="p-3.5 font-black text-rose-600 dark:text-rose-400">
                    {row.minutesLate} min
                  </td>
                  <td className="p-3.5">
                    <span className="rounded-full bg-rose-500/10 border border-rose-500/20 px-2.5 py-1 text-xs font-bold text-rose-700 dark:text-rose-300">
                      {row.isAutoPunchOut ? "Late · auto out" : "Late arrival"}
                    </span>
                  </td>
                </tr>
              ))}
              {lateRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-10 text-center text-sm text-muted-foreground">
                    No late arrivals recorded. Up to 5 minutes after shift start is counted as on
                    time.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border bg-card shadow-lift">
        <div className="flex flex-col gap-4 border-b p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="flex items-center gap-2 font-black text-primary">
              <History className="h-4 w-4" /> Complete attendance timeline
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Every punch-in, punch-out, automatic event, leave, and holiday from the earliest
              record to now.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border bg-secondary/40 p-1">
              <button
                type="button"
                onClick={() => setHistoryScope("all")}
                className={`rounded-md px-3 py-1.5 text-xs font-bold ${
                  historyScope === "all"
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                All history
              </button>
              <button
                type="button"
                onClick={() => setHistoryScope("month")}
                className={`rounded-md px-3 py-1.5 text-xs font-bold ${
                  historyScope === "month"
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground"
                }`}
              >
                One month
              </button>
            </div>
            {historyScope === "month" && (
              <input
                type="month"
                value={month}
                onChange={(event) => setMonth(event.target.value)}
                className="rounded-md border bg-background px-3 py-2 text-sm"
              />
            )}
            <button
              type="button"
              onClick={downloadCsv}
              className="flex items-center gap-1 rounded-md border px-3 py-2 text-xs font-bold text-primary"
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
            <button
              type="button"
              onClick={downloadPdf}
              className="flex items-center gap-1 rounded-md bg-primary px-3 py-2 text-xs font-bold text-primary-foreground"
            >
              <FileText className="h-3.5 w-3.5" /> PDF
            </button>
          </div>
        </div>

        <div className="max-h-[680px] overflow-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="sticky top-0 bg-secondary text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3.5">Date</th>
                <th className="p-3.5">Punch in</th>
                <th className="p-3.5">Punch out</th>
                <th className="p-3.5">Required</th>
                <th className="p-3.5">Normal</th>
                <th className="p-3.5">Overtime</th>
                <th className="p-3.5">Status</th>
                <th className="p-3.5">All events</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visibleRows.map((row) => (
                <tr key={row.date} className="align-top hover:bg-secondary/30">
                  <td className="p-3.5 font-mono text-xs">{row.date}</td>
                  <td className="p-3.5 font-mono text-xs">
                    {row.firstIn
                      ? formatInTimezone(toDate(row.firstIn.timestamp) ?? new Date(), timezone)
                      : "—"}
                  </td>
                  <td className="p-3.5 font-mono text-xs">
                    {row.lastOut
                      ? formatInTimezone(toDate(row.lastOut.timestamp) ?? new Date(), timezone)
                      : row.firstIn
                        ? row.status === "Missing punch out"
                          ? "Missing"
                          : "Still in"
                        : "—"}
                  </td>
                  <td className="p-3.5 font-semibold">{formatWorkMinutes(row.requiredMinutes)}</td>
                  <td className="p-3.5 font-semibold">{formatWorkMinutes(row.normalMinutes)}</td>
                  <td className="p-3.5 font-semibold">
                    {row.overtimeMinutes > 0 ? (
                      row.isOvertimeApproved ? (
                        <span className="inline-flex items-center gap-1 font-mono text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 text-xs">
                          {formatWorkMinutes(row.overtimeMinutes)} ✓ Approved
                        </span>
                      ) : row.otStatus === "rejected" ? (
                        <span
                          className="inline-flex items-center gap-1 font-mono text-rose-700 dark:text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20 text-xs line-through"
                          title="Overtime rejected by admin"
                        >
                          {formatWorkMinutes(row.overtimeMinutes)} ✗ Rejected
                        </span>
                      ) : (
                        <Link
                          to="/admin/overtime"
                          className="inline-flex items-center gap-1 font-mono text-amber-700 dark:text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 px-2 py-0.5 rounded border border-amber-500/20 text-xs transition-colors"
                          title="Click to review in Overtime Approvals"
                        >
                          {formatWorkMinutes(row.overtimeMinutes)} ⏳ Pending
                        </Link>
                      )
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="p-3.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs font-bold shadow-2xs ${
                          row.status === "Missing punch out"
                            ? "bg-rose-600 text-white"
                            : row.minutesLate
                              ? "bg-rose-600 text-white"
                              : row.isAutoPunchOut
                                ? "bg-sky-600 text-white"
                                : "bg-emerald-600 text-white"
                        }`}
                      >
                        {row.minutesLate ? `Late ${row.minutesLate} min` : row.status}
                      </span>
                      {row.status === "Missing punch out" && (
                        <button
                          type="button"
                          onClick={() => {
                            setFixingRow(row);
                            // Pre-fill with shift end time if available
                            const shiftEnd = row.firstIn?.scheduledShiftEnd;
                            if (shiftEnd) {
                              try {
                                const d = new Date(shiftEnd);
                                setFixTime(
                                  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
                                );
                              } catch {
                                setFixTime("17:00");
                              }
                            } else {
                              setFixTime("17:00");
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-2 py-1 text-[10px] font-bold text-primary hover:bg-primary/10 transition-colors"
                          title="Fix this missing punch-out"
                        >
                          <Wrench className="h-3 w-3" /> Fix
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="p-3.5">
                    <div className="flex max-w-lg flex-wrap gap-1.5">
                      {row.punches.map((punch) => (
                        <span
                          key={punch.id}
                          className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] font-semibold text-muted-foreground"
                        >
                          {punch.type === "in" || punch.type === "extra_in" ? (
                            <LogIn className="h-3 w-3 text-emerald-600" />
                          ) : (
                            <LogIn className="h-3 w-3 rotate-180 text-slate-500" />
                          )}
                          {formatPunchType(punch.type)}{" "}
                          {formatInTimezone(toDate(punch.timestamp) ?? new Date(), timezone)}
                          {punch.isAuto ? " · auto" : ""}
                        </span>
                      ))}
                      {row.punches.length === 0 && (
                        <span className="text-xs text-muted-foreground">No punch events</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-12 text-center text-muted-foreground">
                    No attendance records for this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t bg-secondary/20 px-5 py-3 text-xs font-semibold text-muted-foreground">
          Showing {visibleRows.length} daily {visibleRows.length === 1 ? "record" : "records"} and{" "}
          {visibleRows.reduce((sum, row) => sum + row.punches.length, 0)} punch events.
        </div>
      </section>

      <section className="rounded-2xl border bg-card p-5 shadow-lift">
        <h2 className="flex items-center gap-2 font-black text-primary">
          <CalendarDays className="h-4 w-4" /> Leave history
        </h2>
        <div className="mt-4 space-y-2">
          {employeeLeaves.map((leave) => (
            <div
              key={leave.id}
              className="flex flex-col gap-2 rounded-xl border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <div className="font-bold">
                  {leave.dateFrom}
                  {leave.dateFrom !== leave.dateTo ? ` to ${leave.dateTo}` : ""}
                </div>
                <div className="text-xs text-muted-foreground">
                  {getLeaveLabel(leave)} · {leave.reason}
                </div>
              </div>
              <span
                className={`w-fit rounded-full px-2.5 py-1 text-xs font-bold capitalize ${
                  leave.status === "approved"
                    ? "bg-emerald-500/10 text-emerald-700"
                    : leave.status === "rejected"
                      ? "bg-rose-500/10 text-rose-700"
                      : "bg-amber-500/10 text-amber-700"
                }`}
              >
                {leave.status}
              </span>
            </div>
          ))}
          {employeeLeaves.length === 0 && (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              No leave requests recorded.
            </p>
          )}
        </div>
      </section>
      {editingEmployee && (
        <PromoteModal
          emp={editingEmployee}
          depts={departments}
          companies={companies}
          onClose={() => setEditingEmployee(null)}
        />
      )}

      {/* Fix Missing Punch-Out Modal */}
      {fixingRow && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl bg-card p-6 shadow-2xl space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-black text-foreground flex items-center gap-2">
                  <Wrench className="h-5 w-5 text-primary" /> Fix Missing Punch-Out
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Add the punch-out time for <strong>{employee?.name}</strong> on{" "}
                  <strong>{fixingRow.date}</strong>
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFixingRow(null);
                  setFixTime("");
                }}
                className="rounded-lg border p-1.5 hover:bg-muted text-muted-foreground"
              >
                ✕
              </button>
            </div>

            {fixingRow.firstIn && (
              <div className="rounded-lg border bg-secondary/30 p-3 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="font-medium text-muted-foreground">Punched in at:</span>
                  <span className="font-bold text-foreground">
                    {formatInTimezone(toDate(fixingRow.firstIn.timestamp) ?? new Date(), timezone)}
                  </span>
                </div>
                {fixingRow.firstIn.scheduledShiftEnd && (
                  <div className="flex justify-between">
                    <span className="font-medium text-muted-foreground">Shift end:</span>
                    <span className="font-bold text-foreground">
                      {formatInTimezone(new Date(fixingRow.firstIn.scheduledShiftEnd), timezone)}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-bold text-muted-foreground mb-1.5">
                Punch-Out Time
              </label>
              <input
                type="time"
                value={fixTime}
                onChange={(e) => setFixTime(e.target.value)}
                className="w-full rounded-lg border bg-background px-3 py-2.5 text-sm font-mono font-bold focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Enter the actual time the employee stopped working on {fixingRow.date}.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setFixingRow(null);
                  setFixTime("");
                }}
                className="rounded-lg border px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleFixMissingPunch}
                disabled={fixBusy || !fixTime}
                className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {fixBusy ? "Fixing…" : "Fix Punch-Out"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 border-b py-3 last:border-b-0">
      {icon && (
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="mt-0.5 break-words text-sm font-semibold text-foreground" title={value}>
          {value}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  tone = "primary",
}: {
  label: string;
  value: string;
  note: string;
  tone?: "primary" | "amber" | "green";
}) {
  const toneClass =
    tone === "amber"
      ? "border-amber-500/20 bg-amber-500/5 text-amber-800"
      : tone === "green"
        ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-800"
        : "bg-card text-primary";
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${toneClass}`}>
      <div className="text-[11px] font-black uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-black">{value}</div>
      <div className="mt-0.5 text-[11px] font-semibold opacity-70">{note}</div>
    </div>
  );
}

function formatDecimal(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatPunchType(type: Punch["type"]): string {
  if (type === "extra_in") return "Extra in";
  if (type === "extra_out") return "Extra out";
  return type === "in" ? "In" : "Out";
}

function formatOptionalDate(value: string | undefined, timezone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatInTimezone(date, timezone, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
