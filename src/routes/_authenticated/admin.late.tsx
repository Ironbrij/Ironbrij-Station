import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, doc, onSnapshot, Timestamp, updateDoc } from "firebase/firestore";
import { AlertTriangle, CheckCircle2, Clock3, Plus, UserCheck, UserX, X } from "lucide-react";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type Department,
  type Employee,
  type LeaveRequest,
  type Punch,
} from "@/lib/types";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getEffectiveLateGraceMinutes,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getShiftTimezone,
  zonedDateKey,
  zonedDateTimeToDate,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import { toDate, toMillis } from "@/lib/time";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/admin/late")({
  head: () => ({ meta: [{ title: "Late Logs — SavyTimes Admin" }] }),
  component: LateArrivalsPage,
});

type LateRecord = {
  id: string;
  employee: Employee;
  dateKey: string;
  scheduledAt: Date;
  punchedAt?: Date;
  minutesLate: number;
  kind: "arrival" | "missing";
  isExcused?: boolean;
  punch?: Punch;
  isEarly?: boolean;
  minutesEarly?: number;
};

function LateArrivalsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [filterDept, setFilterDept] = useState("");
  const [filterCompany, setFilterCompany] = useState("all");
  const [filterPeriod, setFilterPeriod] = useState<"today" | "week" | "month" | "all">("today");
  const [now, setNow] = useState(() => new Date());
  const { company, user } = useAuth();
  const graceMinutes = getEffectiveLateGraceMinutes(company?.lateGraceMinutes);

  // Manual Clock-In Modal States
  const [showManualModal, setShowManualModal] = useState(false);
  const [selectedEmpId, setSelectedEmpId] = useState("");
  const [manualTimezone, setManualTimezone] = useState("Australia/Sydney");
  const [manualDate, setManualDate] = useState(() => zonedDateKey(new Date(), "Asia/Manila"));
  const [manualTime, setManualTime] = useState("09:00");
  const [manualNotes, setManualNotes] = useState("");
  const [submittingManual, setSubmittingManual] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
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
      onSnapshot(collection(db(), "punches"), (snapshot) =>
        setPunches(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) })),
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
    ];
    return () => {
      window.clearInterval(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const employeePunches = useMemo(() => {
    const map = new Map<string, Punch[]>();
    for (const employee of employees) {
      const ids = new Set([employee.id, employee.authUid].filter(Boolean));
      map.set(
        employee.id,
        punches.filter((punch) => ids.has(punch.employeeId)),
      );
    }
    return map;
  }, [employees, punches]);

  const records = useMemo(() => {
    const result: LateRecord[] = [];
    const today = new Date();

    for (const employee of employees.filter((item) => item.status === "active")) {
      const list = employeePunches.get(employee.id) || [];
      const firstByShiftDate = new Map<string, Punch>();
      const shiftTimezone = getShiftTimezone(employee);
      const todayKey = zonedDateKey(today, shiftTimezone);

      for (const punch of list) {
        if (punch.type !== "in" || !punch.timestamp) continue;
        const punchedAt = toDate(punch.timestamp);
        if (!punchedAt) continue;
        const dateKey = zonedDateKey(punchedAt, shiftTimezone);
        const current = firstByShiftDate.get(dateKey);
        if (!current || toMillis(punch.timestamp) < toMillis(current.timestamp))
          firstByShiftDate.set(dateKey, punch);
      }

      for (const [dateKey, punch] of firstByShiftDate) {
        // Only show today's logs, not from the past
        if (dateKey !== todayKey) continue;

        const approvedLeave = getEmployeeApprovedLeaveForDate(employee, leaves, dateKey);
        if (approvedLeave) continue;
        if (getEmployeeHoliday(company, employee, dateKey)) continue;

        const punchedAt = toDate(punch.timestamp);
        if (!punchedAt) continue;
        const late = computeEmployeeLateness(punchedAt, employee, graceMinutes);
        const differenceSeconds = Math.floor(
          (punchedAt.getTime() - late.scheduledAt.getTime()) / 1000,
        );
        const isEarly = differenceSeconds < 0;
        const minutesEarly = isEarly ? Math.floor(Math.abs(differenceSeconds) / 60) : 0;

        result.push({
          id: punch.id,
          employee,
          dateKey,
          scheduledAt: late.scheduledAt,
          punchedAt,
          minutesLate: late.minutes,
          minutesEarly,
          isEarly,
          kind: "arrival",
          isExcused: Boolean(punch.isExcused),
          punch,
        });
      }

      const status = getLiveAttendanceStatus(
        employee,
        list,
        today,
        graceMinutes,
        company?.workingDays,
        getEmployeeHolidayDates(company, employee),
      );
      const approvedLeaveToday = getEmployeeApprovedLeaveForDate(
        employee,
        leaves,
        status.shift.dateKey,
      );

      // Only show today's missing
      if (status.shift.dateKey === todayKey && !approvedLeaveToday && status.isMissingLate) {
        result.push({
          id: `missing-${employee.id}-${status.shift.dateKey}`,
          employee,
          dateKey: status.shift.dateKey,
          scheduledAt: status.shift.start,
          minutesLate: status.minutesLate,
          kind: "missing",
        });
      }
    }
    return result.sort(
      (a, b) => (b.punchedAt || today).getTime() - (a.punchedAt || today).getTime(),
    );
  }, [employees, employeePunches, leaves, graceMinutes, company]);

  const filtered = useMemo(
    () =>
      records.filter((record) => {
        if (filterDept && record.employee.deptId !== filterDept) return false;
        if (filterCompany !== "all") {
          const matchCompany =
            record.employee.companyId === filterCompany ||
            record.employee.companyIds?.includes(filterCompany) ||
            (!record.employee.companyId && filterCompany === COMPANY_ID);
          if (!matchCompany) return false;
        }
        return true;
      }),
    [records, filterDept, filterCompany],
  );

  const missingCount = filtered.filter((record) => record.kind === "missing").length;
  const arrivalCount = filtered.filter(
    (record) =>
      record.kind === "arrival" && !record.isExcused && !record.isEarly && record.minutesLate > 0,
  ).length;
  const totalMinutes = filtered
    .filter((record) => !record.isExcused && !record.isEarly)
    .reduce((sum, record) => sum + record.minutesLate, 0);

  async function toggleExcuse(punchId?: string, currentExcused?: boolean) {
    if (!punchId) return;
    try {
      await updateDoc(doc(db(), "punches", punchId), {
        isExcused: !currentExcused,
        excusedBy: user?.email || "admin",
        excusedAt: new Date().toISOString(),
      });
      toast.success(
        !currentExcused ? "Lateness marked as Not Late (Excused)! ✓" : "Lateness flag restored.",
      );
    } catch (err) {
      toast.error("Could not update punch status: " + (err as Error).message);
    }
  }

  async function saveManualClockIn() {
    if (!selectedEmpId || !manualDate || !manualTime) {
      toast.error("Please fill in employee, date, and clock-in time.");
      return;
    }
    const targetEmp = employees.find((e) => e.id === selectedEmpId);
    if (!targetEmp) return;

    setSubmittingManual(true);
    try {
      const shiftTz = getShiftTimezone(targetEmp);
      const punchDateObj = zonedDateTimeToDate(manualDate, manualTime, manualTimezone);
      const dateKey = zonedDateKey(punchDateObj, shiftTz);

      await addDoc(collection(db(), "punches"), {
        employeeId: targetEmp.id,
        employeeName: targetEmp.name,
        companyId: targetEmp.companyId || targetEmp.companyIds?.[0] || COMPANY_ID,
        date: dateKey,
        attendanceDate: dateKey,
        type: "in",
        timestamp: Timestamp.fromDate(punchDateObj),
        source: "app",
        attendanceStatus: "in_progress",
        shiftTimezone: shiftTz,
        manualTimezoneUsed: manualTimezone,
        manualNote: manualNotes.trim() || `Manual clock-in (${manualTimezone}) by admin`,
        addedByAdmin: user?.email || "admin",
        createdAt: new Date().toISOString(),
      });

      toast.success(`Manual clock-in logged for ${targetEmp.name}!`);
      setShowManualModal(false);
      setManualNotes("");
    } catch (err) {
      toast.error("Failed to add manual clock-in: " + (err as Error).message);
    } finally {
      setSubmittingManual(false);
    }
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            <Clock3 className="h-6 w-6" /> Late Logs & Punctuality Dashboard
          </h1>
          <p className="text-sm text-muted-foreground font-medium mt-0.5">
            Review missing punches, late arrivals, and excuse lateness across companies.
          </p>
        </div>

        <button
          onClick={() => {
            if (employees.length > 0) setSelectedEmpId(employees[0].id);
            setShowManualModal(true);
          }}
          className="btn-lift inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground shadow-md shrink-0"
        >
          <Plus className="h-4 w-4" /> Fix Missed Clock-In
        </button>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <Stat label="Not punched in" value={missingCount} tone="rose" />
        <Stat label="Late arrivals" value={arrivalCount} tone="amber" />
        <Stat label="Total late minutes" value={totalMinutes} tone="primary" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 w-full">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-extrabold text-emerald-700">
          ● Today's Punctuality Dashboard
        </span>

        <div className="flex items-center gap-2">
          <select
            value={filterCompany}
            onChange={(event) => setFilterCompany(event.target.value)}
            className="rounded-md border bg-card px-3 py-1.5 text-xs font-semibold"
          >
            <option value="all">All companies ({companies.length})</option>
            {companies.map((c) => (
              <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                {c.name} {c.isMain ? "(Main)" : ""}
              </option>
            ))}
          </select>

          <select
            value={filterDept}
            onChange={(event) => setFilterDept(event.target.value)}
            className="rounded-md border bg-card px-3 py-1.5 text-xs font-semibold"
          >
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto shadow-lift">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-secondary text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="p-3.5">Employee</th>
              <th className="p-3.5">Shift date</th>
              <th className="p-3.5">Scheduled</th>
              <th className="p-3.5">Actual punch</th>
              <th className="p-3.5">Lateness / Early</th>
              <th className="p-3.5">Status</th>
              <th className="p-3.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filtered.map((record) => {
              const employeeTimezone = getEmployeeTimezone(record.employee);
              const shiftTimezone = getShiftTimezone(record.employee);
              return (
                <tr key={record.id} className="hover:bg-secondary/30">
                  <td className="p-3.5">
                    <Link
                      to="/admin/employees/$id"
                      params={{ id: record.employee.id }}
                      className="font-bold text-primary hover:underline"
                    >
                      {record.employee.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {departments.find((item) => item.id === record.employee.deptId)?.name ||
                        "No department"}
                    </div>
                  </td>
                  <td className="p-3.5 font-mono text-xs">{record.dateKey}</td>
                  <td className="p-3.5">
                    <div className="font-semibold text-primary">
                      {formatInTimezone(record.scheduledAt, shiftTimezone)}
                      <span className="text-[10px] font-normal text-muted-foreground ml-1">
                        ({shiftTimezone.split("/")[1] || "Shift"})
                      </span>
                    </div>
                    {shiftTimezone !== employeeTimezone && (
                      <div className="text-[11px] font-extrabold text-amber-600 dark:text-amber-400">
                        ➔ {formatInTimezone(record.scheduledAt, employeeTimezone)} (
                        {employeeTimezone.split("/")[1] || "Local"})
                      </div>
                    )}
                  </td>
                  <td className="p-3.5">
                    <div className="font-semibold">
                      {record.punchedAt
                        ? formatInTimezone(record.punchedAt, employeeTimezone)
                        : "Waiting for punch"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {employeeTimezone.split("/")[1] || "Local"}
                    </div>
                  </td>
                  <td className="p-3.5 font-bold">
                    {record.kind === "missing" ? (
                      <span className="text-rose-600">—</span>
                    ) : record.isEarly ? (
                      <span className="text-emerald-600 font-extrabold">
                        +{record.minutesEarly} min
                      </span>
                    ) : record.isExcused ? (
                      <span className="text-emerald-600 line-through">
                        {record.minutesLate} min
                      </span>
                    ) : record.minutesLate === 0 ? (
                      <span className="text-emerald-600 font-extrabold">On time</span>
                    ) : (
                      <span className="text-rose-600 font-extrabold">{record.minutesLate} min</span>
                    )}
                  </td>
                  <td className="p-3.5">
                    {record.kind === "missing" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-1 text-xs font-bold text-rose-600">
                        <UserX className="h-3.5 w-3.5" /> Missing
                      </span>
                    ) : record.isEarly ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Arrived early
                      </span>
                    ) : record.isExcused ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Excused (Not Late)
                      </span>
                    ) : record.minutesLate === 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" /> On time
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 px-2.5 py-1 text-xs font-bold text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5" /> Arrived late
                      </span>
                    )}
                  </td>
                  <td className="p-3.5 text-right">
                    {record.kind === "arrival" && record.punch ? (
                      !record.isEarly && record.minutesLate > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleExcuse(record.punch?.id, record.isExcused)}
                          className={`rounded-lg px-3 py-1 text-xs font-bold transition-all border ${
                            record.isExcused
                              ? "bg-secondary text-muted-foreground hover:bg-muted"
                              : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                          }`}
                        >
                          {record.isExcused ? "Un-excuse" : "Mark Not Late"}
                        </button>
                      ) : (
                        <span className="text-xs text-muted-foreground font-semibold">
                          No action needed
                        </span>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedEmpId(record.employee.id);
                          setManualDate(record.dateKey);
                          setShowManualModal(true);
                        }}
                        className="rounded-lg border bg-primary/5 px-2.5 py-1 text-xs font-bold text-primary hover:bg-primary/10"
                      >
                        Fix Punch
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="p-10 text-center text-muted-foreground">
                  No late records for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ----- Fix Missed Clock-In Modal ----- */}
      {showManualModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-in fade-in duration-150">
          <div className="w-full max-w-lg rounded-2xl border bg-card p-6 shadow-2xl space-y-5">
            <div className="flex items-start justify-between border-b pb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold">
                  <UserCheck className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-foreground">Fix Missed Clock-In</h3>
                  <p className="text-xs text-muted-foreground">
                    Retroactively add or adjust clock-in time for an employee when a mistake
                    happens.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowManualModal(false)}
                className="rounded-lg border p-1.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Employee <span className="text-rose-500">*</span>
                </label>
                <select
                  value={selectedEmpId}
                  onChange={(e) => {
                    setSelectedEmpId(e.target.value);
                    const emp = employees.find((x) => x.id === e.target.value);
                    if (emp) setManualTimezone(getShiftTimezone(emp));
                  }}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-xs font-medium"
                >
                  {employees.map((emp) => (
                    <option key={emp.id} value={emp.id}>
                      {emp.name} ({emp.email})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div>
                  <label className="block text-xs font-bold text-foreground mb-1">
                    Shift Date <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="date"
                    value={manualDate}
                    onChange={(e) => setManualDate(e.target.value)}
                    className="w-full rounded-lg border bg-background px-2.5 py-2 text-xs font-medium"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-foreground mb-1">
                    Clock-In Time <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="time"
                    value={manualTime}
                    onChange={(e) => setManualTime(e.target.value)}
                    className="w-full rounded-lg border bg-background px-2.5 py-2 text-xs font-medium font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-foreground mb-1">
                    Timezone <span className="text-rose-500">*</span>
                  </label>
                  <select
                    value={manualTimezone}
                    onChange={(e) => setManualTimezone(e.target.value)}
                    className="w-full rounded-lg border bg-background px-2 py-2 text-xs font-medium"
                  >
                    <option value="Australia/Sydney">🇦🇺 Sydney (AU)</option>
                    <option value="Asia/Manila">🇵🇭 Philippines (PHT)</option>
                    <option value="Asia/Kathmandu">🇳🇵 Nepal (NPT)</option>
                  </select>
                </div>
              </div>

              {/* Live 3-Country Time Comparison Helper */}
              {manualTime && manualDate && (
                <div className="rounded-xl bg-secondary/60 border p-3 text-xs space-y-1.5 animate-in fade-in">
                  <div className="font-bold text-foreground flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground uppercase tracking-wider">
                      <Clock3 className="h-3.5 w-3.5 text-primary" /> Timezone Conversion Preview
                    </span>
                    <span className="text-[10px] font-semibold text-primary px-1.5 py-0.5 rounded bg-primary/10">
                      Input Time: {manualTime} in {manualTimezone.split("/")[1]}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 font-mono text-[11px] pt-1">
                    <div className="p-2 rounded-lg border bg-card/60">
                      <span className="text-[10px] text-muted-foreground block font-sans font-bold">
                        🇦🇺 Sydney (AU)
                      </span>
                      <span className="font-bold text-foreground">
                        {formatInTimezone(
                          zonedDateTimeToDate(manualDate, manualTime, manualTimezone),
                          "Australia/Sydney",
                          { hour: "numeric", minute: "2-digit", hour12: true },
                        )}
                      </span>
                    </div>
                    <div className="p-2 rounded-lg border bg-card/60">
                      <span className="text-[10px] text-muted-foreground block font-sans font-bold">
                        🇵🇭 Philippines (PHT)
                      </span>
                      <span className="font-bold text-foreground">
                        {formatInTimezone(
                          zonedDateTimeToDate(manualDate, manualTime, manualTimezone),
                          "Asia/Manila",
                          { hour: "numeric", minute: "2-digit", hour12: true },
                        )}
                      </span>
                    </div>
                    <div className="p-2 rounded-lg border bg-card/60">
                      <span className="text-[10px] text-muted-foreground block font-sans font-bold">
                        🇳🇵 Nepal (NPT)
                      </span>
                      <span className="font-bold text-foreground">
                        {formatInTimezone(
                          zonedDateTimeToDate(manualDate, manualTime, manualTimezone),
                          "Asia/Kathmandu",
                          { hour: "numeric", minute: "2-digit", hour12: true },
                        )}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Reason / Notes
                </label>
                <textarea
                  rows={2}
                  value={manualNotes}
                  onChange={(e) => setManualNotes(e.target.value)}
                  placeholder="e.g. Forgot to login at start of shift..."
                  className="w-full rounded-lg border bg-background px-3 py-2 text-xs font-medium"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={() => setShowManualModal(false)}
                className="rounded-lg border px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={submittingManual}
                onClick={saveManualClockIn}
                className="btn-lift rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
              >
                {submittingManual ? "Saving..." : "Save Manual Clock-In"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "rose" | "amber" | "primary";
}) {
  const color =
    tone === "rose" ? "text-rose-600" : tone === "amber" ? "text-amber-600" : "text-primary";
  return (
    <div className="rounded-xl border bg-card p-5 shadow-lift">
      <div className="text-xs font-bold uppercase text-muted-foreground">{label}</div>
      <div className={`mt-2 text-3xl font-black ${color}`}>{value}</div>
    </div>
  );
}
