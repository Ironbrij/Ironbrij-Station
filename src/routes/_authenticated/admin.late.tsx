import { buildLateRecords, lateRecordInPeriod } from "@/lib/late-records";
import { resolveManualClockOut } from "@/lib/manual-clock-in";
import { applyPunchCorrection } from "@/lib/punch-corrections";
import { formatWorkMinutes } from "@/lib/attendance-calculation";
import { useAppRuntime } from "@/lib/app-runtime";
import { attendanceNow } from "@/lib/attendance-clock";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import {
  isSettled,
  listOf,
  liveError,
  RECENT_PUNCH_DAYS,
  useCollectionLive,
  useCompaniesLive,
  useDepartmentsLive,
  useEmployeesLive,
  useLeaveRequestsLive,
  useRecentPunchesLive,
} from "@/lib/live-data";
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
  getActiveWorkingSession,
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
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getEmployeePunchesForCompany,
  normalizeCompanyId,
} from "@/lib/company-context";
import { formatShiftRange } from "./admin.employees";

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
  excuseReason?: string;
  punch?: Punch;
  isEarly?: boolean;
  minutesEarly?: number;
  companyId: string;
  companyName: string;
  shiftLabel?: string;
};

function LateArrivalsPage() {
  const runtime = useAppRuntime();
  const [reopenShift, setReopenShift] = useState(true);
  const { company, user, activeCompanyId } = useAuth();
  const [filterDept, setFilterDept] = useState("");
  const [filterCompany, setFilterCompany] = useState(activeCompanyId);
  const [filterPeriod, setFilterPeriod] = useState<"today" | "week" | "month" | "all">("today");
  // The records the dashboard reads too, so a fix here shows there at once.
  const employees = listOf(useEmployeesLive());
  const departments = listOf(useDepartmentsLive());
  const companies = listOf(useCompaniesLive());
  const leaves = listOf(useLeaveRequestsLive());
  // Load only as far back as the chosen period; "all" still reads the full history.
  const periodDays =
    filterPeriod === "all"
      ? null
      : filterPeriod === "month"
        ? 32
        : filterPeriod === "week"
          ? 8
          : RECENT_PUNCH_DAYS;
  const recentPunches = useRecentPunchesLive(periodDays ?? RECENT_PUNCH_DAYS, periodDays !== null);
  const everyPunch = useCollectionLive<Punch>("punches", periodDays === null);
  const punchesLive = periodDays === null ? everyPunch : recentPunches;
  const punchesReady = isSettled(punchesLive);
  const punchesError = liveError(punchesLive);
  const punchesData = punchesLive.data;
  const punches = useMemo(
    () => (punchesData ?? []).filter((punch) => !punch.voidedAt),
    [punchesData],
  );
  const [now, setNow] = useState(() => attendanceNow());
  useEffect(() => { if (runtime.ready) setNow(attendanceNow()); }, [runtime.ready]);
  const graceMinutes = getEffectiveLateGraceMinutes(company?.lateGraceMinutes);

  useEffect(() => {
    setFilterCompany(activeCompanyId);
  }, [activeCompanyId]);

  // Manual Clock-In Modal States
  const [showManualModal, setShowManualModal] = useState(false);
  const [selectedEmpId, setSelectedEmpId] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [manualTimezone, setManualTimezone] = useState("Australia/Sydney");
  const [manualDate, setManualDate] = useState(() => zonedDateKey(attendanceNow(), "Asia/Manila"));
  const [manualTime, setManualTime] = useState("09:00");
  const [manualOutTime, setManualOutTime] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [submittingManual, setSubmittingManual] = useState(false);

  // Excuse Reason Modal States
  const [excuseModal, setExcuseModal] = useState<{
    punchId: string;
    employeeName: string;
    minutesLate: number;
    reason: string;
  } | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(attendanceNow()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const records = useMemo(() => buildLateRecords(employees, punches, leaves, companies, now, { period: filterPeriod }),
    [employees, punches, leaves, companies, now, filterPeriod]);

  const filtered = useMemo(
    () =>
      records.filter((record) => {
        if (!lateRecordInPeriod(record, filterPeriod, now)) return false;
        if (filterDept && record.employee.deptId !== filterDept) return false;
        if (filterCompany !== "all") {
          if (normalizeCompanyId(record.companyId) !== normalizeCompanyId(filterCompany)) return false;
        }
        return true;
      }),
    [records, filterDept, filterCompany, filterPeriod, now],
  );

  const missingCount = filtered.filter((record) => record.kind === "missing").length;
  const arrivalCount = filtered.filter(
    (record) =>
      record.kind === "arrival" && !record.isExcused && !record.isEarly && record.minutesLate > 0,
  ).length;
  const totalMinutes = filtered
    .filter((record) => !record.isExcused && !record.isEarly)
    .reduce((sum, record) => sum + record.minutesLate, 0);

  async function toggleExcuse(punchId?: string, currentExcused?: boolean, reason?: string) {
    if (!punchId) return;
    try {
      await updateDoc(doc(db(), "punches", punchId), {
        isExcused: !currentExcused,
        excusedBy: user?.email || "admin",
        excusedAt: attendanceNow().toISOString(),
        ...(currentExcused
          ? { excuseReason: null }
          : { excuseReason: (reason || "").trim() || "Excused by admin" }),
      });
      toast.success(
        !currentExcused ? "Lateness marked as Not Late (Excused)! ✓" : "Lateness flag restored.",
      );
      setExcuseModal(null);
    } catch (err) {
      toast.error("Could not update punch status: " + (err as Error).message);
    }
  }

  // The modal's clock-out helper offers the scheduled end of the shift being fixed.
  const shiftEndSuggestion = (() => {
    const targetEmp = employees.find((e) => e.id === selectedEmpId);
    if (!targetEmp) return "";
    const ids = getEmployeeCompanyIds(targetEmp);
    const scoped = getEmployeeForCompany(
      targetEmp,
      selectedCompanyId && ids.includes(selectedCompanyId) ? selectedCompanyId : ids[0] || COMPANY_ID,
    );
    const slot = scoped.shifts?.find((shift) => shift.startTime === manualTime);
    return slot?.endTime || scoped.shiftEndTime || "";
  })();

  // Both a late arrival and a missing punch are corrected in the same modal, so
  // the row hands it the shift it belongs to instead of asking the admin to retype it.
  function openFixPunch(record: LateRecord) {
    setManualOutTime("");
    setSelectedEmpId(record.employee.id);
    setSelectedCompanyId(record.companyId);
    setManualDate(record.dateKey);
    const shiftTz = getShiftTimezone(record.employee);
    setManualTimezone(shiftTz);
    if (record.scheduledAt) {
      setManualTime(
        formatInTimezone(record.scheduledAt, shiftTz, {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );
    }
    setShowManualModal(true);
  }

  async function saveManualClockIn() {
    if (!runtime.ready || !punchesReady || submittingManual) {
      toast.error(
        runtime.message ||
          (punchesError
            ? "Late logs are reconnecting. Try again in a moment."
            : "Wait for attendance records to finish syncing."),
      );
      return;
    }
    if (!selectedEmpId || !manualDate || !manualTime) {
      toast.error("Please fill in employee, date, and clock-in time.");
      return;
    }
    const targetEmp = employees.find((e) => e.id === selectedEmpId);
    if (!targetEmp) return;

    const targetCompanyIds = getEmployeeCompanyIds(targetEmp);
    const effectiveCompanyId =
      selectedCompanyId && targetCompanyIds.includes(selectedCompanyId)
        ? selectedCompanyId
        : targetCompanyIds[0] || COMPANY_ID;
    const targetEmpForCompany = getEmployeeForCompany(targetEmp, effectiveCompanyId);

    setSubmittingManual(true);
    try {
      const punchDateObj = zonedDateTimeToDate(manualDate, manualTime, manualTimezone);
      const outDateObj = manualOutTime
        ? resolveManualClockOut(manualDate, manualOutTime, manualTimezone, punchDateObj)
        : null;
      // The same writer backs the report's punch corrections, so a fix made in
      // either place records the shift the same way.
      const { calculation, voidedCount } = await applyPunchCorrection({
        employee: targetEmpForCompany,
        profile: targetEmp,
        companyId: effectiveCompanyId,
        company: companies.find(
          (c) => normalizeCompanyId(c.id) === normalizeCompanyId(effectiveCompanyId),
        ),
        punches,
        punchIn: punchDateObj,
        punchOut: outDateObj,
        now: attendanceNow(),
        reopen: reopenShift,
        actor: user?.email || "admin",
        note: manualNotes.trim() || `Manual punch (${manualTimezone}) by admin`,
        timezoneUsed: manualTimezone,
      });
      toast.success(
        calculation
          ? `${targetEmp.name}: ${manualTime} – ${manualOutTime} saved. Worked ${formatWorkMinutes(calculation.normalWorkMinutes)}${calculation.overtimeMinutes > 0 ? ` plus ${formatWorkMinutes(calculation.overtimeMinutes)} overtime` : ""}.`
          : voidedCount
            ? `Clock-in corrected and automatic clock-out removed for ${targetEmp.name}.`
            : `Manual clock-in logged for ${targetEmp.name}!`,
      );
      setShowManualModal(false);
      setManualNotes("");
      setManualOutTime("");
    } catch (err) {
      toast.error("Failed to save punch times: " + (err as Error).message);
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
            setManualOutTime("");
            if (employees.length > 0) {
              const firstEmp = employees[0];
              setSelectedEmpId(firstEmp.id);
              const compIds = getEmployeeCompanyIds(firstEmp);
              const cId = compIds[0] || COMPANY_ID;
              setSelectedCompanyId(cId);
              const cEmp = getEmployeeForCompany(firstEmp, cId);
              setManualTimezone(getShiftTimezone(cEmp));
              if (cEmp.shiftStartTime) setManualTime(cEmp.shiftStartTime);
            }
            setShowManualModal(true);
          }}
          className="btn-lift inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-extrabold text-primary-foreground shadow-md shrink-0"
        >
          <Plus className="h-4 w-4" /> Fix Punch Times
        </button>
      </div>

      {(punchesError || !punchesReady) && (
        <p role="status" className="rounded-lg border bg-amber-50 px-4 py-2 text-xs text-amber-900">
          {punchesError
            ? "Late logs lost their connection and are reconnecting. Figures may be out of date."
            : "Syncing attendance…"}
        </p>
      )}
      <div className="grid sm:grid-cols-3 gap-4">
        <Stat label="Not punched in" value={missingCount} tone="rose" />
        <Stat label="Late arrivals" value={arrivalCount} tone="amber" />
        <Stat label="Total late minutes" value={totalMinutes} tone="primary" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 w-full">
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-3 py-1.5 text-xs font-extrabold text-emerald-700">
          Punctuality Dashboard
        </span>

        <div className="flex items-center gap-2">
          <select aria-label="Late log period" value={filterPeriod} onChange={(e) => setFilterPeriod(e.target.value as typeof filterPeriod)} className="rounded-md border bg-card px-3 py-1.5 text-xs font-semibold">
            <option value="today">Today</option><option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option><option value="all">All dates</option>
          </select>
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
              <th className="p-3.5">Lateness</th>
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
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Link
                        to="/admin/employees/$id"
                        params={{ id: record.employee.id }}
                        className="font-bold text-primary hover:underline"
                      >
                        {record.employee.name}
                      </Link>
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-primary/10 text-primary border border-primary/20">
                        {record.companyName}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {departments.find((item) => item.id === record.employee.deptId)?.name ||
                        "No department"}
                    </div>
                    {record.shiftLabel && (
                      <div className="text-[11px] font-mono text-muted-foreground flex items-center gap-1 pt-0.5">
                        <Clock3 className="h-3 w-3 text-muted-foreground/70" />
                        <span>{record.shiftLabel}</span>
                      </div>
                    )}
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
                      <span className="text-rose-600 font-extrabold">
                        {record.minutesLate}m overdue
                      </span>
                    ) : record.isExcused ? (
                      <span className="text-emerald-600 line-through font-extrabold">
                        {record.minutesLate} min
                      </span>
                    ) : (
                      <span className="text-rose-600 font-extrabold">{record.minutesLate} min</span>
                    )}
                  </td>
                  <td className="p-3.5">
                    {record.kind === "missing" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-bold text-white shadow-2xs">
                        <UserX className="h-3.5 w-3.5" /> Missing Punch-In
                      </span>
                    ) : record.isExcused ? (
                      <div>
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-0.5 text-xs font-bold text-white shadow-2xs">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Excused (Not Late)
                        </span>
                        {record.excuseReason && (
                          <div
                            className="text-[11px] text-muted-foreground font-medium mt-0.5 max-w-[220px] truncate"
                            title={record.excuseReason}
                          >
                            Reason: {record.excuseReason}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2.5 py-0.5 text-xs font-bold text-white shadow-2xs">
                        <AlertTriangle className="h-3.5 w-3.5" /> Arrived late
                      </span>
                    )}
                  </td>
                  <td className="p-3.5 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      {record.kind === "arrival" && record.punch && (
                        <button
                          type="button"
                          onClick={() => {
                            if (record.isExcused) {
                              toggleExcuse(record.punch?.id, true);
                            } else {
                              setExcuseModal({
                                punchId: record.punch!.id,
                                employeeName: record.employee.name,
                                minutesLate: record.minutesLate,
                                reason: "",
                              });
                            }
                          }}
                          className={`rounded-lg px-3 py-1 text-xs font-bold transition-all border ${
                            record.isExcused
                              ? "bg-secondary text-muted-foreground hover:bg-muted"
                              : "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100"
                          }`}
                        >
                          {record.isExcused ? "Un-excuse" : "Mark Not Late"}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => openFixPunch(record)}
                        title="Correct the recorded clock-in time for this shift"
                        className="rounded-lg border bg-primary/5 px-2.5 py-1 text-xs font-bold text-primary hover:bg-primary/10"
                      >
                        {record.kind === "arrival" ? "Fix Time" : "Fix Punch"}
                      </button>
                    </div>
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

      {/* ----- Fix Punch Times Modal ----- */}
      {showManualModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-in fade-in duration-150 overflow-y-auto">
          <div className="w-full max-w-lg max-h-[90vh] flex flex-col rounded-2xl border bg-card p-5 sm:p-6 shadow-2xl space-y-4 my-auto overflow-hidden">
            <div className="flex items-start justify-between border-b pb-3 shrink-0">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold">
                  <UserCheck className="h-4 w-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">Fix Punch Times</h3>
                  <p className="text-xs text-muted-foreground">
                    Retroactively add or adjust an employee's clock-in and clock-out when a
                    mistake happens. Leave clock-out blank to keep the shift open.
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

            <div className="space-y-3.5 overflow-y-auto pr-1 flex-1 min-h-0">
              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Employee <span className="text-rose-500">*</span>
                </label>
                <select
                  value={selectedEmpId}
                  onChange={(e) => {
                    setSelectedEmpId(e.target.value);
                    const emp = employees.find((x) => x.id === e.target.value);
                    if (emp) {
                      const compIds = getEmployeeCompanyIds(emp);
                      const cId = compIds[0] || COMPANY_ID;
                      setSelectedCompanyId(cId);
                      const cEmp = getEmployeeForCompany(emp, cId);
                      setManualTimezone(getShiftTimezone(cEmp));
                      if (cEmp.shiftStartTime) setManualTime(cEmp.shiftStartTime);
                    }
                  }}
                  className="w-full rounded-lg border bg-background px-3 py-2 text-xs font-medium"
                >
                  {employees
                    .slice()
                    .sort((a, b) =>
                      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
                    )
                    .map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name} ({emp.email})
                      </option>
                    ))}
                </select>
              </div>

              {(() => {
                const targetEmp = employees.find((e) => e.id === selectedEmpId);
                const targetCompanyIds = targetEmp ? getEmployeeCompanyIds(targetEmp) : [];
                const effectiveCompanyId =
                  selectedCompanyId && targetCompanyIds.includes(selectedCompanyId)
                    ? selectedCompanyId
                    : targetCompanyIds[0] || COMPANY_ID;
                const targetEmpForCompany = targetEmp
                  ? getEmployeeForCompany(targetEmp, effectiveCompanyId)
                  : null;

                return (
                  <>
                    {targetCompanyIds.length > 0 && (
                      <div>
                        <label className="block text-xs font-bold text-foreground mb-1">
                          Target Company <span className="text-rose-500">*</span>
                        </label>
                        <select
                          value={effectiveCompanyId}
                          onChange={(e) => {
                            setSelectedCompanyId(e.target.value);
                            if (targetEmp) {
                              const cEmp = getEmployeeForCompany(targetEmp, e.target.value);
                              setManualTimezone(getShiftTimezone(cEmp));
                              if (cEmp.shiftStartTime) setManualTime(cEmp.shiftStartTime);
                            }
                          }}
                          className="w-full rounded-lg border bg-background px-3 py-2 text-xs font-medium"
                        >
                          {targetCompanyIds.map((cId) => {
                            const comp = companies.find((c) => (c.id || COMPANY_ID) === cId);
                            const compName =
                              comp?.name || (cId === COMPANY_ID ? "Main Company" : cId);
                            return (
                              <option key={cId} value={cId}>
                                {compName} {cId === COMPANY_ID ? "(Main)" : ""}
                              </option>
                            );
                          })}
                        </select>
                      </div>
                    )}

                    {targetEmpForCompany && (
                      <div className="rounded-xl bg-secondary/60 border p-3 text-xs space-y-2">
                        <div className="flex items-center justify-between text-[11px] font-bold text-foreground">
                          <span className="flex items-center gap-1.5 text-muted-foreground uppercase tracking-wider">
                            <Clock3 className="h-3.5 w-3.5 text-primary" /> Shift Schedule (
                            {companies.find((c) => (c.id || COMPANY_ID) === effectiveCompanyId)
                              ?.name || effectiveCompanyId}
                            )
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            Click a shift to auto-fill
                          </span>
                        </div>

                        <div className="grid sm:grid-cols-2 gap-2 pt-1">
                          {targetEmpForCompany.isMultipleShift &&
                          targetEmpForCompany.shifts &&
                          targetEmpForCompany.shifts.length > 0 ? (
                            targetEmpForCompany.shifts.map((s, idx) => {
                              const isActive = manualTime === s.startTime;
                              return (
                                <button
                                  key={idx}
                                  type="button"
                                  onClick={() => {
                                    setManualTime(s.startTime);
                                    setManualTimezone(getShiftTimezone(targetEmpForCompany));
                                  }}
                                  className={`flex items-center justify-between p-2 rounded-lg border text-left text-xs transition-all ${
                                    isActive
                                      ? "bg-primary/10 border-primary text-primary font-bold shadow-2xs ring-1 ring-primary/30"
                                      : "bg-background hover:bg-muted text-foreground"
                                  }`}
                                >
                                  <div>
                                    <div className="font-bold">Shift #{idx + 1}</div>
                                    <div className="text-[11px] text-muted-foreground font-mono">
                                      {s.startTime} – {s.endTime}
                                    </div>
                                  </div>
                                  <span className="text-[10px] rounded bg-primary/10 text-primary font-extrabold px-1.5 py-0.5">
                                    ⚡ Set {s.startTime}
                                  </span>
                                </button>
                              );
                            })
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setManualTime(targetEmpForCompany.shiftStartTime || "09:00");
                                setManualTimezone(getShiftTimezone(targetEmpForCompany));
                              }}
                              className={`flex items-center justify-between p-2 rounded-lg border text-left text-xs transition-all col-span-2 ${
                                manualTime === (targetEmpForCompany.shiftStartTime || "09:00")
                                  ? "bg-primary/10 border-primary text-primary font-bold shadow-2xs ring-1 ring-primary/30"
                                  : "bg-background hover:bg-muted text-foreground"
                              }`}
                            >
                              <div>
                                <div className="font-bold">Standard Shift</div>
                                <div className="text-[11px] text-muted-foreground font-mono">
                                  {targetEmpForCompany.shiftStartTime || "09:00"} –{" "}
                                  {targetEmpForCompany.shiftEndTime || "17:00"}
                                </div>
                              </div>
                              <span className="text-[10px] rounded bg-primary/10 text-primary font-extrabold px-1.5 py-0.5">
                                ⚡ Set {targetEmpForCompany.shiftStartTime || "09:00"}
                              </span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                );
              })()}

              <label
                className={`flex items-start gap-2 text-sm ${manualOutTime ? "opacity-50" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={reopenShift && !manualOutTime}
                  disabled={Boolean(manualOutTime)}
                  onChange={(e) => setReopenShift(e.target.checked)}
                />
                {manualOutTime
                  ? "Not used: the clock-out time below closes this shift instead of reopening it."
                  : "Employee is currently working: reopen today's shift by voiding incorrect automatic clock-outs. Past shifts stay historical."}
              </label>
              <div className="grid grid-cols-2 gap-2.5">
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
                  <div className="flex items-baseline justify-between mb-1 gap-2">
                    <label className="block text-xs font-bold text-foreground">
                      Clock-Out Time
                    </label>
                    {manualOutTime ? (
                      <button
                        type="button"
                        onClick={() => setManualOutTime("")}
                        className="text-[10px] font-bold text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </button>
                    ) : (
                      shiftEndSuggestion && (
                        <button
                          type="button"
                          onClick={() => setManualOutTime(shiftEndSuggestion)}
                          className="text-[10px] font-bold text-primary hover:underline"
                        >
                          Use {shiftEndSuggestion}
                        </button>
                      )
                    )}
                  </div>
                  <input
                    type="time"
                    value={manualOutTime}
                    onChange={(e) => setManualOutTime(e.target.value)}
                    className="w-full rounded-lg border bg-background px-2.5 py-2 text-xs font-medium font-mono"
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {manualOutTime && manualOutTime <= manualTime
                      ? "Ends next day (overnight shift)."
                      : "Optional. Leave blank to keep the shift open."}
                  </p>
                </div>
              </div>

              {/* Live 3-Country Time Comparison Helper */}
              {manualTime && manualDate && (
                <div className="rounded-xl bg-secondary/60 border p-2.5 text-xs space-y-1 animate-in fade-in">
                  <div className="font-bold text-foreground flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground uppercase tracking-wider">
                      <Clock3 className="h-3 w-3 text-primary" /> Timezone Conversion Preview
                    </span>
                    <span className="text-[10px] font-semibold text-primary px-1.5 py-0.5 rounded bg-primary/10">
                      {manualTime} ({manualTimezone.split("/")[1]})
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px] pt-1">
                    <div className="p-1.5 rounded-lg border bg-card/60">
                      <span className="text-[10px] text-muted-foreground block font-sans font-bold">
                        🇦🇺 Sydney
                      </span>
                      <span className="font-bold text-foreground text-[11px]">
                        {formatInTimezone(
                          zonedDateTimeToDate(manualDate, manualTime, manualTimezone),
                          "Australia/Sydney",
                          { hour: "numeric", minute: "2-digit", hour12: true },
                        )}
                      </span>
                    </div>
                    <div className="p-1.5 rounded-lg border bg-card/60">
                      <span className="text-[10px] text-muted-foreground block font-sans font-bold">
                        🇵🇭 Manila
                      </span>
                      <span className="font-bold text-foreground text-[11px]">
                        {formatInTimezone(
                          zonedDateTimeToDate(manualDate, manualTime, manualTimezone),
                          "Asia/Manila",
                          { hour: "numeric", minute: "2-digit", hour12: true },
                        )}
                      </span>
                    </div>
                    <div className="p-1.5 rounded-lg border bg-card/60">
                      <span className="text-[10px] text-muted-foreground block font-sans font-bold">
                        🇳🇵 Kathmandu
                      </span>
                      <span className="font-bold text-foreground text-[11px]">
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

            <div className="flex justify-end gap-2 pt-3 border-t shrink-0">
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
                {submittingManual
                  ? "Saving..."
                  : manualOutTime
                    ? "Save Clock-In & Clock-Out"
                    : "Save Manual Clock-In"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ----- Excuse Reason Modal ----- */}
      {excuseModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl border bg-card p-5 sm:p-6 shadow-2xl space-y-4">
            <div className="flex items-start justify-between border-b pb-3">
              <div className="flex items-center gap-2.5">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 font-bold">
                  <CheckCircle2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-foreground">Mark Not Late (Excuse)</h3>
                  <p className="text-xs text-muted-foreground">
                    {excuseModal.employeeName} · {excuseModal.minutesLate}m late
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExcuseModal(null)}
                className="rounded-lg border p-1.5 text-muted-foreground hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-foreground mb-1">
                  Reason for Excusing (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Traffic, Doctor's appointment, Approved by manager"
                  value={excuseModal.reason}
                  onChange={(e) =>
                    setExcuseModal((prev) => (prev ? { ...prev, reason: e.target.value } : null))
                  }
                  className="w-full rounded-lg border bg-background px-3 py-2 text-xs font-medium"
                />
              </div>

              {/* Presets */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  "Traffic / Transit",
                  "Medical / Doctor",
                  "Manager Approved",
                  "System / Network Issue",
                  "Bad Weather",
                ].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() =>
                      setExcuseModal((prev) => (prev ? { ...prev, reason: preset } : null))
                    }
                    className="rounded-md border bg-secondary/50 px-2 py-1 text-[10px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
                  >
                    + {preset}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t pt-3">
              <button
                type="button"
                onClick={() => setExcuseModal(null)}
                className="rounded-lg border px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  toggleExcuse(excuseModal.punchId, false, excuseModal.reason)
                }
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 transition-colors shadow-xs"
              >
                Save as Not Late ✓
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
