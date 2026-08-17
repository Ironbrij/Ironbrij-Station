import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
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
} from "lucide-react";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import type { Company, Department, Employee, LeaveRequest, Punch } from "@/lib/types";
import { computeDay, COUNTRY_TIMEZONES } from "@/lib/time";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getActiveEmployeeLeave,
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
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "@/lib/company-context";
import { calculateAttendanceSession, formatWorkMinutes } from "@/lib/attendance-calculation";

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
};

function EmployeeDetail() {
  const { id } = Route.useParams();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesLoaded, setEmployeesLoaded] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [users, setUsers] = useState<UserAccount[]>([]);
  const [historyScope, setHistoryScope] = useState<HistoryScope>("all");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [now, setNow] = useState(() => new Date());
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const { company, activeCompanyId } = useAuth();
  const graceMinutes = getEffectiveLateGraceMinutes(company?.lateGraceMinutes);

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
      .sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
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
      const date = zonedDateKey(punch.timestamp.toDate(), timezone);
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
      const sorted = [...dayPunches].sort(
        (a, b) => a.timestamp.toMillis() - b.timestamp.toMillis(),
      );
      const firstIn = sorted.find((punch) => punch.type === "in");
      const lastOut = [...sorted].reverse().find((punch) => punch.type === "out");
      const rawCalculation = computeDay(sorted);
      const approvedLeave = getEmployeeApprovedLeaveForDate(employee, companyLeaves, date);
      const holiday = getEmployeeHoliday(company, employee, date);
      const lateness = firstIn
        ? computeEmployeeLateness(firstIn.timestamp.toDate(), employee, graceMinutes)
        : null;
      const isAutoPunchOut = Boolean(lastOut?.isAuto);
      const attendanceCalculation = firstIn
        ? calculateAttendanceSession({
            employee,
            company,
            punchIn: firstIn.timestamp.toDate(),
            punchOut: lastOut?.timestamp?.toDate() || null,
            now,
            requiredWorkMinutes: getRequiredWorkMinutes(employee, company),
          })
        : null;
      const extraOvertimeMinutes = Math.round(rawCalculation.overtimeHours * 60);
      const normalMinutes = attendanceCalculation?.normalWorkMinutes || 0;
      const overtimeMinutes = (attendanceCalculation?.overtimeMinutes || 0) + extraOvertimeMinutes;
      const requiredMinutes =
        attendanceCalculation?.requiredWorkMinutes || getRequiredWorkMinutes(employee, company);

      output.push({
        date,
        punches: sorted,
        firstIn,
        lastOut,
        hours: (normalMinutes + overtimeMinutes) / 60,
        normalMinutes,
        overtimeMinutes,
        requiredMinutes,
        minutesLate: !holiday && !approvedLeave && lateness?.isLate ? lateness.minutes : 0,
        scheduledAt: lateness?.scheduledAt,
        isAutoPunchOut,
        status: holiday
          ? holiday.name || "Holiday"
          : approvedLeave
            ? getLeaveLabel(approvedLeave)
            : !firstIn
              ? sorted.length
                ? "Extra time only"
                : "No punch in"
              : !lastOut
                ? attendanceCalculation?.missingPunchOut
                  ? "Missing punch out"
                  : "Still punched in"
                : isAutoPunchOut
                  ? lateness?.isLate
                    ? "Auto punched out · Late"
                    : "Auto punched out"
                  : lateness?.isLate
                    ? "Late"
                    : "On time",
      });
    }
    return output.sort((a, b) => b.date.localeCompare(a.date));
  }, [employee, punches, companyLeaves, company, graceMinutes, now]);

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
  const firstActivity = punches.at(0)?.timestamp.toDate();
  const lastActivity = punches.at(-1)?.timestamp.toDate();

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
        ? formatInTimezone(row.firstIn.timestamp.toDate(), timezone, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
        : "",
      PunchOut: row.lastOut
        ? formatInTimezone(row.lastOut.timestamp.toDate(), timezone, {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          })
        : "",
      Hours: row.hours.toFixed(2),
      RequiredMinutes: row.requiredMinutes,
      NormalWorkMinutes: row.normalMinutes,
      OvertimeMinutes: row.overtimeMinutes,
      Status: row.status,
      MinutesLate: row.minutesLate,
      AllEvents: row.punches
        .map(
          (punch) =>
            `${formatPunchType(punch.type)} ${formatInTimezone(punch.timestamp.toDate(), timezone)}`,
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
        row.firstIn ? formatInTimezone(row.firstIn.timestamp.toDate(), timezone) : "—",
        48,
        y,
      );
      pdf.text(
        row.lastOut ? formatInTimezone(row.lastOut.timestamp.toDate(), timezone) : "—",
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
                  {employee.name}
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
                    {row.firstIn ? formatInTimezone(row.firstIn.timestamp.toDate(), timezone) : "—"}
                  </td>
                  <td className="p-3.5 font-black text-amber-700">{row.minutesLate} min</td>
                  <td className="p-3.5">
                    <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-700">
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
                    {row.firstIn ? formatInTimezone(row.firstIn.timestamp.toDate(), timezone) : "—"}
                  </td>
                  <td className="p-3.5 font-mono text-xs">
                    {row.lastOut
                      ? formatInTimezone(row.lastOut.timestamp.toDate(), timezone)
                      : row.firstIn
                        ? row.status === "Missing punch out"
                          ? "Missing"
                          : "Still in"
                        : "—"}
                  </td>
                  <td className="p-3.5 font-semibold">{formatWorkMinutes(row.requiredMinutes)}</td>
                  <td className="p-3.5 font-semibold">{formatWorkMinutes(row.normalMinutes)}</td>
                  <td className="p-3.5 font-semibold">{formatWorkMinutes(row.overtimeMinutes)}</td>
                  <td className="p-3.5">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                        row.status === "Missing punch out"
                          ? "bg-rose-500/10 text-rose-700"
                          : row.minutesLate
                            ? "bg-amber-500/10 text-amber-700"
                            : row.isAutoPunchOut
                              ? "bg-sky-500/10 text-sky-700"
                              : "bg-emerald-500/10 text-emerald-700"
                      }`}
                    >
                      {row.minutesLate ? `Late ${row.minutesLate} min` : row.status}
                    </span>
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
                          {formatInTimezone(punch.timestamp.toDate(), timezone)}
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
