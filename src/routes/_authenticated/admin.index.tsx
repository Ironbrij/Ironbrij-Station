import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, orderBy, query, limit, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type DailyReport,
  type Department,
  type Employee,
  type LeaveRequest,
  type Punch,
  type ReportingSettings,
} from "@/lib/types";
import {
  DEFAULT_REPORTING_SETTINGS,
  isReportDeadlinePassed,
  reportDocumentId,
} from "@/lib/daily-reports";
import { StatusDot } from "@/components/StatusDot";
import { FormattedAnswerText } from "@/components/FormattedAnswerText";
import { COUNTRY_TIMEZONES, toDate, toMillis } from "@/lib/time";
import {
  formatInTimezone,
  formatEmployeeShiftSummary,
  getActiveEmployeeLeave,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getLeaveLabel,
  getShiftTimezone,
  zonedDateKey,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import { getEmployeeCompanyIds, getPunchCompanyId } from "@/lib/company-context";
import { CompanySelector } from "@/components/CompanySelector";
import {
  Users,
  Clock,
  ChevronDown,
  ChevronUp,
  Filter,
  AlertTriangle,
  ShieldCheck,
  Building2,
  Globe,
  X,
} from "lucide-react";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({
    meta: [
      { title: "Dashboard — SavyTimes Admin" },
      {
        name: "description",
        content: "Live team status, department cards, and today's activity feed.",
      },
      { property: "og:title", content: "Dashboard — SavyTimes Admin" },
      {
        property: "og:description",
        content: "Live team status, department cards, and today's activity feed.",
      },
    ],
  }),
  component: AdminHome,
});

function AdminHome() {
  const { company, companies, activeCompanyId, setActiveCompanyId } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [todayPunches, setTodayPunches] = useState<Punch[]>([]);
  const [historicalRecent, setHistoricalRecent] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [dailyReports, setDailyReports] = useState<DailyReport[]>([]);
  const [reportingSettings, setReportingSettings] = useState<ReportingSettings>(
    DEFAULT_REPORTING_SETTINGS,
  );

  // Dashboard UI States
  const [filterDeptId, setFilterDeptId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [timezoneMode, setTimezoneMode] = useState<"country" | "PH" | "NP" | "AU" | "viewer">("country");
  const [expandedDeptMap, setExpandedDeptMap] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(15);
  const [viewingReport, setViewingReport] = useState<{
    report?: DailyReport;
    employee: Employee;
    reportType: "sod" | "eod";
    isMissed: boolean;
    dateKey: string;
  } | null>(null);

  const [now, setNow] = useState(() => new Date());
  const [pendingOvertimeCount, setPendingOvertimeCount] = useState(0);

  const handleBadgeClick = (emp: Employee, type: "sod" | "eod", e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const tz = getEmployeeTimezone(emp);
    const todayKey = zonedDateKey(now, tz);
    const reportId = reportDocumentId(emp.authUid || emp.id, todayKey, type);
    const foundReport = dailyReports.find(
      (r) =>
        r.id === reportId ||
        (r.userId === (emp.authUid || emp.id) &&
          r.reportDate === todayKey &&
          r.reportType === type),
    );

    const isMissed = isReportDeadlinePassed(emp, type, todayKey, reportingSettings, now);

    setViewingReport({
      report: foundReport,
      employee: emp,
      reportType: type,
      isMissed: !foundReport && isMissed,
      dateKey: todayKey,
    });
  };

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const un1 = onSnapshot(collection(db(), "employees"), (s) =>
      setEmployees(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) }))),
    );

    const un2 = onSnapshot(
      query(collection(db(), "departments"), where("companyId", "==", activeCompanyId)),
      (s) =>
        setDepartments(
          s.docs
            .map((d) => ({ id: d.id, ...(d.data() as Omit<Department, "id">) }))
            .filter((d) => (d.companyId || COMPANY_ID) === activeCompanyId),
        ),
    );

    const un3 = onSnapshot(collection(db(), "punches"), (s) =>
      setTodayPunches(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }))),
    );

    const un4 = onSnapshot(
      query(collection(db(), "leaveRequests"), where("status", "==", "approved")),
      (s) =>
        setLeaves(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LeaveRequest, "id">) }))),
    );

    const un5 = onSnapshot(collection(db(), "dailyReports"), (s) =>
      setDailyReports(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<DailyReport, "id">) }))),
    );

    const un6 = onSnapshot(doc(db(), "reportingSettings", "default"), (s) => {
      if (s.exists()) {
        setReportingSettings({ ...DEFAULT_REPORTING_SETTINGS, ...(s.data() as ReportingSettings) });
      }
    });

    const un7 = onSnapshot(
      query(
        collection(db(), "overtimeRequests"),
        where("companyId", "==", activeCompanyId),
        where("status", "==", "pending"),
      ),
      (s) => setPendingOvertimeCount(s.docs.length),
    );

    return () => {
      un1();
      un2();
      un3();
      un4();
      un5();
      un6();
      un7();
    };
  }, [activeCompanyId]);

  // Load historical recent punches only when "Load History" is requested
  useEffect(() => {
    if (!showHistory) return;
    const unsub = onSnapshot(
      query(
        collection(db(), "punches"),
        where("companyId", "==", activeCompanyId),
        orderBy("timestamp", "desc"),
        limit(historyLimit),
      ),
      (s) =>
        setHistoricalRecent(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }))),
    );
    return () => unsub();
  }, [showHistory, historyLimit, activeCompanyId]);

  const empById = useMemo(() => {
    const map = new Map<string, Employee>();
    employees.forEach((employee) => {
      map.set(employee.id, employee);
      if (employee.authUid) map.set(employee.authUid, employee);
    });
    return map;
  }, [employees]);

  // Filter employees belonging to activeCompanyId
  const scopedEmployees = useMemo(() => {
    return employees.filter((e) => getEmployeeCompanyIds(e).includes(activeCompanyId));
  }, [employees, activeCompanyId]);

  // Group punches by employee for fast today lookup
  const empTodayPunches = useMemo(() => {
    const map = new Map<string, Punch[]>();
    for (const p of todayPunches) {
      if (getPunchCompanyId(p, empById.get(p.employeeId)) !== activeCompanyId) continue;
      if (!map.has(p.employeeId)) map.set(p.employeeId, []);
      map.get(p.employeeId)!.push(p);
    }
    // Sort each employee's list by time
    for (const list of map.values()) {
      list.sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
    }
    return map;
  }, [todayPunches, activeCompanyId, empById]);

  function getEmpTodayStatus(emp: Employee) {
    const employeeToday = zonedDateKey(now, getEmployeeTimezone(emp));
    const shiftToday = zonedDateKey(now, getShiftTimezone(emp));
    const holiday = getEmployeeHoliday(company, emp, shiftToday);
    if (holiday) {
      return {
        type: "holiday" as const,
        label: holiday.name || "Holiday",
        isLate: false,
        minutesLate: 0,
        punchTimeStr: "",
        isAutoPunchOut: false,
      };
    }
    const activeLeave = getActiveEmployeeLeave(emp, leaves, now);
    const approvedLeaveToday =
      getEmployeeApprovedLeaveForDate(emp, leaves, shiftToday) || activeLeave;
    if (approvedLeaveToday) {
      return {
        type: "leave" as const,
        label: getLeaveLabel(approvedLeaveToday),
        isLate: false,
        minutesLate: 0,
        punchTimeStr: "",
        isAutoPunchOut: false,
      };
    }

    const getDisplayTimezone = (employee?: Employee) => {
      if (timezoneMode === "PH") return { tz: "Asia/Manila", code: "PH", flag: "🇵🇭" };
      if (timezoneMode === "NP") return { tz: "Asia/Kathmandu", code: "NP", flag: "🇳🇵" };
      if (timezoneMode === "AU") return { tz: "Australia/Sydney", code: "AU", flag: "🇦🇺" };
      if (timezoneMode === "viewer") {
        const vTz =
          typeof Intl !== "undefined"
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : "Asia/Manila";
        return { tz: vTz, code: "Local", flag: "💻" };
      }
      const empTz = getEmployeeTimezone(employee);
      const countryCode =
        employee?.country ||
        (empTz.includes("Manila") ? "PH" : empTz.includes("Sydney") ? "AU" : "NP");
      const flag = COUNTRY_TIMEZONES[countryCode as keyof typeof COUNTRY_TIMEZONES]?.flag || "🌐";
      return { tz: empTz, code: countryCode, flag };
    };

    const list = [
      ...(empTodayPunches.get(emp.id) || []),
      ...(emp.authUid ? empTodayPunches.get(emp.authUid) || [] : []),
    ];
    const status = getLiveAttendanceStatus(
      emp,
      list,
      now,
      company?.lateGraceMinutes ?? 5,
      company?.workingDays,
      getEmployeeHolidayDates(company, emp),
    );
    const targetTz = getDisplayTimezone(emp);
    const latestDate = toDate(status.latest?.timestamp);
    const timeStr = latestDate ? `${formatInTimezone(latestDate, targetTz.tz)} (${targetTz.code})` : "";
    const statusTimeStr =
      latestDate && zonedDateKey(latestDate, targetTz.tz) !== employeeToday
        ? `${formatInTimezone(latestDate, targetTz.tz, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })} (${targetTz.code})`
        : timeStr;

    if (status.isOnLunch) {
      const elapsedBreakMinutes = latestDate
        ? Math.max(0, Math.floor((now.getTime() - latestDate.getTime()) / 60000))
        : 0;
      return {
        type: "break" as const,
        label: elapsedBreakMinutes > 0 ? `On break (${elapsedBreakMinutes}m)` : "On break (1m)",
        isLate: false,
        minutesLate: 0,
        punchTimeStr: timeStr,
        isAutoPunchOut: false,
      };
    }

    if (status.isPunchedIn) {
      return {
        type: "in" as const,
        label: `Punched in at ${statusTimeStr}`,
        isLate: status.isLate,
        minutesLate: status.minutesLate,
        punchTimeStr: timeStr,
        isAutoPunchOut: false,
      };
    }

    const isAutoPunchOut = Boolean(status.latest?.isAuto);
    return {
      type: "out" as const,
      label: status.isMissingLate
        ? "Not punched in"
        : status.latest
          ? `${isAutoPunchOut ? "Auto punched out" : "Punched out"} at ${statusTimeStr}`
          : "Not on shift",
      isLate: status.isLate,
      minutesLate: status.minutesLate,
      punchTimeStr: timeStr,
      isAutoPunchOut,
    };
  }

  // Filtered department list based on user selection and activeCompanyId
  const filteredDepartments = useMemo(() => {
    return departments.filter((d) => {
      if (filterDeptId !== "all" && d.id !== filterDeptId) return false;
      const matchesComp =
        (d.companyId || COMPANY_ID) === activeCompanyId ||
        (!d.companyId && activeCompanyId === COMPANY_ID);
      if (!matchesComp) return false;

      if (filterStatus !== "all") {
        const allMembers = scopedEmployees.filter(
          (e) => e.deptId === d.id && e.status === "active" && e.inviteStatus === "accepted",
        );
        const matchingMembers = allMembers.filter((m) => {
          const status = getEmpTodayStatus(m);
          if (filterStatus === "in") return status.type === "in";
          if (filterStatus === "break") return status.type === "break";
          if (filterStatus === "out") return status.type === "out";
          if (filterStatus === "holiday") return status.type === "holiday";
          if (filterStatus === "leave") return status.type === "leave";
          if (filterStatus === "late") return status.isLate;
          return true;
        });
        if (matchingMembers.length === 0) return false;
      }
      return true;
    });
  }, [
    departments,
    filterDeptId,
    activeCompanyId,
    filterStatus,
    scopedEmployees,
    empTodayPunches,
    now,
    leaves,
    company,
    timezoneMode,
  ]);

  const todayActivityFeed = useMemo(() => {
    return todayPunches
      .filter((punch) => {
        if (!punch.timestamp) return false;
        const employee = empById.get(punch.employeeId);
        if (getPunchCompanyId(punch, employee) !== activeCompanyId) return false;
        const timezone = getShiftTimezone(employee);
        const punchedAt = toDate(punch.timestamp);
        if (!punchedAt) return false;
        return zonedDateKey(punchedAt, timezone) === zonedDateKey(now, timezone);
      })
      .sort((a, b) => toMillis(b.timestamp) - toMillis(a.timestamp));
  }, [todayPunches, empById, now, activeCompanyId]);

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Top Header & Quick Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" /> Live Team Dashboard
          </h1>
          <p className="text-sm font-medium text-muted-foreground mt-0.5">
            {format(new Date(), "EEEE d MMMM")} — real-time status for <strong>{company?.name || "Company"}</strong>.
          </p>
        </div>

        {/* Global Filters & Company Selector */}
        <div className="flex items-center gap-2 flex-wrap">
          <CompanySelector variant="dashboard" />

          <div className="flex items-center gap-1.5 bg-card border px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm">
            <Filter className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={filterDeptId}
              onChange={(e) => setFilterDeptId(e.target.value)}
              className="bg-transparent outline-none font-bold text-primary cursor-pointer"
            >
              <option value="all">All Departments ({departments.length})</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5 bg-card border px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm">
            <Globe className="h-3.5 w-3.5 text-muted-foreground" />
            <select
              value={timezoneMode}
              onChange={(e) => setTimezoneMode(e.target.value as any)}
              className="bg-transparent outline-none font-bold text-primary cursor-pointer"
            >
              <option value="country">🌍 Respective Country Time (PH / NP / AU)</option>
              <option value="PH">🇵🇭 Philippines Time (PHT)</option>
              <option value="NP">🇳🇵 Nepal Time (NPT)</option>
              <option value="AU">🇦🇺 Australia Time (AEST)</option>
              <option value="viewer">💻 My Browser Time</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 bg-card border px-3 py-1.5 rounded-lg text-xs font-semibold shadow-sm">
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-transparent outline-none font-bold text-primary cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="in">🟢 Punched In / Working</option>
              <option value="break">🟡 On Break / Lunch</option>
              <option value="out">🔴 Punched Out / Off</option>
              <option value="holiday">Holiday</option>
              <option value="leave">On Leave</option>
              <option value="late">⚠️ Late Arrivals Today</option>
            </select>
          </div>
        </div>
      </div>

      {/* Pending Overtime Alert Banner */}
      {pendingOvertimeCount > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 p-4 rounded-2xl border bg-card shadow-xs">
          <div className="flex items-center gap-3.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary shrink-0">
              <Clock className="h-5 w-5" />
            </div>
            <div>
              <span className="font-extrabold text-sm text-foreground block tracking-tight">
                {pendingOvertimeCount} Pending Overtime Request{pendingOvertimeCount > 1 ? "s" : ""}
              </span>
              <p className="text-xs text-muted-foreground font-medium mt-0.5">
                Team members have logged overtime that requires admin review before payroll calculation.
              </p>
            </div>
          </div>
          <Link
            to="/admin/overtime"
            className="btn-lift inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 text-xs font-bold shadow-xs transition-all whitespace-nowrap"
          >
            Review Overtime &rarr;
          </Link>
        </div>
      )}

      {/* Department Cards Section */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-extrabold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Users className="h-4 w-4" /> Department Cards & Today's Member Status
          </h2>
          <span className="text-xs font-semibold text-muted-foreground">
            Showing {filteredDepartments.length} of {departments.length} Departments
          </span>
        </div>

        <div className="grid gap-5 grid-cols-1 md:grid-cols-2 lg:grid-cols-2">
          {filteredDepartments.length === 0 && (
            <div className="col-span-full rounded-2xl border border-dashed bg-card/60 p-10 text-center text-sm text-muted-foreground font-medium">
              No departments or team members match the selected filter.
            </div>
          )}

          {filteredDepartments.map((dept) => {
            const allMembers = employees.filter(
              (e) => e.deptId === dept.id && e.status === "active" && e.inviteStatus === "accepted",
            );

            // Filter members inside card based on status filter
            const filteredMembers = allMembers.filter((m) => {
              const status = getEmpTodayStatus(m);
              if (filterStatus === "in") return status.type === "in";
              if (filterStatus === "break") return status.type === "break";
              if (filterStatus === "out") return status.type === "out";
              if (filterStatus === "holiday") return status.type === "holiday";
              if (filterStatus === "leave") return status.type === "leave";
              if (filterStatus === "late") return status.isLate;
              return true;
            });

            const punchedInCount = allMembers.filter(
              (m) => getEmpTodayStatus(m).type === "in",
            ).length;
            const onBreakCount = allMembers.filter(
              (m) => getEmpTodayStatus(m).type === "break",
            ).length;
            const lateCount = allMembers.filter((m) => getEmpTodayStatus(m).isLate).length;
            const isExpanded = expandedDeptMap[dept.id] ?? false;
            const visibleMembers = isExpanded ? filteredMembers : filteredMembers.slice(0, 4);

            return (
              <div
                key={dept.id}
                className="rounded-xl border bg-card shadow-lift p-5 space-y-4 transition-all"
              >
                {/* Department Card Header */}
                <div className="flex items-center justify-between border-b pb-3">
                  <div>
                    <h3 className="font-extrabold text-base text-primary flex items-center gap-2">
                      {dept.name}
                    </h3>
                    <span className="text-xs text-muted-foreground font-medium">
                      {allMembers.length} Assigned Members
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {punchedInCount > 0 && (
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-600 text-white shadow-2xs">
                        {punchedInCount} Active In
                      </span>
                    )}
                    {onBreakCount > 0 && (
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500 text-slate-950 shadow-2xs">
                        {onBreakCount} On Break
                      </span>
                    )}
                    {lateCount > 0 && (
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-600 text-white shadow-2xs">
                        {lateCount} Late
                      </span>
                    )}
                  </div>
                </div>

                {/* Team Members List inside Department Card */}
                <div className="space-y-2">
                  {visibleMembers.length === 0 ? (
                    <div className="text-xs text-muted-foreground italic py-3 text-center border border-dashed rounded-lg">
                      No members matching selected filter.
                    </div>
                  ) : (
                    visibleMembers.map((m) => {
                      const status = getEmpTodayStatus(m);
                      const countryData =
                        COUNTRY_TIMEZONES[m.country ?? "PH"] || COUNTRY_TIMEZONES.PH;
                      const shiftSummary = formatEmployeeShiftSummary(m, now);

                      const getReportBadgeStatus = (emp: Employee, type: "sod" | "eod") => {
                        const req = emp.reportingRequirement || "sod_eod";
                        const isRequired =
                          req === "sod_eod" ||
                          (type === "sod" && req === "sod_only") ||
                          (type === "eod" && req === "eod_only");

                        if (!isRequired) return "none";

                        const tz = getEmployeeTimezone(emp);
                        const todayKey = zonedDateKey(now, tz);
                        const reportId = reportDocumentId(emp.authUid || emp.id, todayKey, type);
                        const isSubmitted = dailyReports.some(
                          (r) =>
                            r.id === reportId ||
                            (r.userId === (emp.authUid || emp.id) &&
                              r.reportDate === todayKey &&
                              r.reportType === type),
                        );

                        if (isSubmitted) return "submitted";

                        const isMissed = isReportDeadlinePassed(
                          emp,
                          type,
                          todayKey,
                          reportingSettings,
                          now,
                        );
                        return isMissed ? "missed" : "awaiting";
                      };

                      const sodStatus = getReportBadgeStatus(m, "sod");
                      const eodStatus = getReportBadgeStatus(m, "eod");

                      return (
                        <div
                          key={m.id}
                          className="flex items-center justify-between p-2.5 rounded-lg border bg-secondary/20 hover:bg-secondary/40 transition-colors text-xs gap-3"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <StatusDot status={status.type} />
                            <div className="truncate">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Link
                                  to="/admin/employees/$id"
                                  params={{ id: m.id }}
                                  className="font-bold text-foreground hover:underline truncate block"
                                >
                                  {m.name}
                                </Link>

                                <div className="flex items-center gap-1 shrink-0">
                                  {sodStatus === "submitted" && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleBadgeClick(m, "sod", e)}
                                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-emerald-200 bg-emerald-50 text-[10px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
                                      aria-label={`View ${m.name} SOD report`}
                                      title="Click to view SOD report answers"
                                    >
                                      S
                                    </button>
                                  )}
                                  {sodStatus === "missed" && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleBadgeClick(m, "sod", e)}
                                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-rose-200 bg-rose-50 text-[10px] font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                                      aria-label={`View ${m.name} missed SOD report`}
                                      title="Click to view missed SOD report info"
                                    >
                                      S
                                    </button>
                                  )}
                                  {eodStatus === "submitted" && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleBadgeClick(m, "eod", e)}
                                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-emerald-200 bg-emerald-50 text-[10px] font-semibold text-emerald-700 transition-colors hover:bg-emerald-100"
                                      aria-label={`View ${m.name} EOD report`}
                                      title="Click to view EOD report answers"
                                    >
                                      E
                                    </button>
                                  )}
                                  {eodStatus === "missed" && (
                                    <button
                                      type="button"
                                      onClick={(e) => handleBadgeClick(m, "eod", e)}
                                      className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded border border-rose-200 bg-rose-50 text-[10px] font-semibold text-rose-700 transition-colors hover:bg-rose-100"
                                      aria-label={`View ${m.name} missed EOD report`}
                                      title="Click to view missed EOD report info"
                                    >
                                      E
                                    </button>
                                  )}
                                </div>
                              </div>

                              <div className="text-[11px] text-muted-foreground truncate">
                                {m.jobTitle || "Member"} · {countryData.name} (
                                {shiftSummary.localCode})
                              </div>
                              <div
                                className="flex items-center gap-1 font-mono text-[11px] font-semibold text-primary mt-0.5"
                                title={shiftSummary.fullSummary}
                              >
                                <Clock className="h-3 w-3 shrink-0" aria-hidden="true" />
                                <span>
                                  {shiftSummary.shiftLabel}
                                  {shiftSummary.isCrossTimezone && (
                                    <span className="text-amber-600 dark:text-amber-400 font-bold ml-1.5">
                                      ({shiftSummary.localLabel})
                                    </span>
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>

                          <div className="text-right shrink-0">
                            <span
                              className={`text-xs block ${
                                status.type === "break"
                                  ? "font-bold text-amber-600 dark:text-amber-400"
                                  : "font-medium text-slate-700 dark:text-slate-300"
                              }`}
                            >
                              {status.label}
                            </span>
                            {status.isAutoPunchOut && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-extrabold text-sky-700 dark:text-sky-300 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded mt-0.5">
                                <Clock className="h-3 w-3" /> Automatic
                              </span>
                            )}
                            {status.isLate && (
                              <span
                                className="inline-flex items-center gap-1 text-[10px] font-bold text-white bg-rose-600 px-2 py-0.5 rounded-full shadow-2xs mt-0.5"
                                title={`Shift started at ${shiftSummary.localStart} ${shiftSummary.localCode}`}
                              >
                                <AlertTriangle className="h-3 w-3 text-white" /> {status.minutesLate}m Late
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {/* See More Option on Department Card */}
                {filteredMembers.length > 4 && (
                  <button
                    onClick={() =>
                      setExpandedDeptMap((prev) => ({ ...prev, [dept.id]: !isExpanded }))
                    }
                    className="w-full py-2 text-xs font-bold text-primary hover:bg-sky-soft rounded-lg transition-colors flex items-center justify-center gap-1 border border-primary/20"
                  >
                    {isExpanded ? (
                      <>
                        <ChevronUp className="h-3.5 w-3.5" /> Show Less
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-3.5 w-3.5" /> See More (
                        {filteredMembers.length - 4} More Members)
                      </>
                    )}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Today's Recent Activity Card (Fast-Loading Today Only) */}
      <section className="rounded-xl border bg-card p-6 shadow-lift space-y-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h2 className="text-lg font-bold text-primary flex items-center gap-2">
              <Clock className="h-5 w-5 text-primary" /> Today's Activity Log
            </h2>
            <p className="text-xs text-muted-foreground font-medium">
              Real-time punches recorded today ({todayActivityFeed.length} punches).
            </p>
          </div>

          {!showHistory ? (
            <button
              onClick={() => setShowHistory(true)}
              className="btn-lift rounded-md border border-primary/30 px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary hover:text-primary-foreground transition-colors"
            >
              Load Historical Punches
            </button>
          ) : (
            <span className="text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 px-2.5 py-1 rounded border border-emerald-200 dark:border-emerald-800">
              Showing All History ({historicalRecent.length} logs)
            </span>
          )}
        </div>

        {/* Punch Activity List */}
        <ul className="divide-y rounded-lg border bg-background overflow-hidden text-xs">
          {(!showHistory ? todayActivityFeed : historicalRecent).length === 0 && (
            <li className="p-6 text-center text-muted-foreground font-medium">
              No punch activity recorded for today yet.
            </li>
          )}

          {(!showHistory ? todayActivityFeed : historicalRecent).map((p) => {
            const emp = empById.get(p.employeeId);
            const countryData = COUNTRY_TIMEZONES[emp?.country ?? "NP"] || COUNTRY_TIMEZONES.NP;
            const targetTz =
              timezoneMode === "PH"
                ? { tz: "Asia/Manila", code: "PH" }
                : timezoneMode === "NP"
                  ? { tz: "Asia/Kathmandu", code: "NP" }
                  : timezoneMode === "AU"
                    ? { tz: "Australia/Sydney", code: "AU" }
                    : timezoneMode === "viewer"
                      ? {
                          tz:
                            typeof Intl !== "undefined"
                              ? Intl.DateTimeFormat().resolvedOptions().timeZone
                              : "Asia/Manila",
                          code: "Local",
                        }
                      : {
                          tz: getEmployeeTimezone(emp),
                          code:
                            emp?.country ||
                            (getEmployeeTimezone(emp).includes("Manila")
                              ? "PH"
                              : getEmployeeTimezone(emp).includes("Sydney")
                                ? "AU"
                                : "NP"),
                        };

            const timeFormatted = p.timestamp
              ? `${formatInTimezone(toDate(p.timestamp) ?? new Date(), targetTz.tz)} (${targetTz.code})`
              : "—";
            const dateFormatted = p.timestamp
              ? new Intl.DateTimeFormat("en-US", {
                  timeZone: targetTz.tz,
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).format(toDate(p.timestamp) ?? new Date())
              : "";
            const isLunchStart = p.type === "lunch_start";
            const isLunchEnd = p.type === "lunch_end";
            const isPunchIn = p.type === "in" || p.type === "extra_in";
            const dotStatus: "in" | "out" | "leave" | "holiday" | "break" = isLunchStart
              ? "break"
              : isLunchEnd
                ? "in"
                : isPunchIn
                  ? "in"
                  : "out";

            const punchTypeLabel = isLunchStart
              ? "Started Break"
              : isLunchEnd
                ? "Returned from Break"
                : isPunchIn
                  ? "Punched IN"
                  : p.isAuto
                    ? "AUTO PUNCHED OUT"
                    : "Punched OUT";

            return (
              <li
                key={p.id}
                className="p-3.5 flex items-center justify-between hover:bg-secondary/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusDot status={dotStatus} />
                  <div>
                    <div className="font-bold text-sm text-foreground flex items-center gap-1.5">
                      {emp ? (
                        <Link
                          to="/admin/employees/$id"
                          params={{ id: emp.id }}
                          className="text-primary hover:underline"
                        >
                          {emp.name}
                        </Link>
                      ) : (
                        <span>{p.employeeName ?? p.employeeId}</span>
                      )}
                      <span className="text-[10px] text-muted-foreground font-normal">
                        ({countryData.flag} {countryData.name})
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-xs font-semibold ${
                          isLunchStart
                            ? "text-amber-700 dark:text-amber-300 font-bold"
                            : isLunchEnd
                              ? "text-emerald-700 dark:text-emerald-300 font-bold"
                              : "text-muted-foreground"
                        }`}
                      >
                        {punchTypeLabel}
                      </span>
                      {p.isAuto && !isPunchIn && !isLunchStart && !isLunchEnd && (
                        <span className="rounded border border-sky-500/20 bg-sky-500/10 px-1.5 py-0.5 text-[9px] font-extrabold uppercase text-sky-700">
                          Automatic
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="text-right font-mono">
                  <div className="font-bold text-xs text-primary">{timeFormatted}</div>
                  <div className="text-[10px] text-muted-foreground">{dateFormatted}</div>
                </div>
              </li>
            );
          })}
        </ul>

        {showHistory && (
          <div className="flex justify-center pt-2">
            <button
              onClick={() => setHistoryLimit((prev) => prev + 25)}
              className="btn-lift rounded-md border px-4 py-2 text-xs font-bold text-primary hover:bg-secondary"
            >
              Load 25 More Historical Logs
            </button>
          </div>
        )}
      </section>

      {viewingReport && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
          role="dialog"
          aria-modal="true"
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-card p-5 shadow-2xl sm:p-6 space-y-4">
            <div className="flex items-start justify-between border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-foreground uppercase">
                  {viewingReport.reportType} Report — {viewingReport.employee.name}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {viewingReport.employee.email} · Date: {viewingReport.dateKey}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setViewingReport(null)}
                className="rounded-lg border p-1.5 hover:bg-muted text-muted-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {viewingReport.report ? (
              <>
                <dl className="grid gap-3 rounded-lg border p-4 text-xs sm:grid-cols-2 bg-secondary/20">
                  <div>
                    <dt className="text-xs text-muted-foreground font-medium">Submitted At</dt>
                    <dd className="font-bold text-foreground">
                      {toDate(viewingReport.report.submittedAt)
                        ? toDate(viewingReport.report.submittedAt)!.toLocaleString([], {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })
                        : "N/A"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground font-medium">Timing Status</dt>
                    <dd className="font-bold">
                      {viewingReport.report.submittedLate ? (
                        <span className="text-rose-600 font-extrabold">Submitted Late</span>
                      ) : (
                        <span className="text-emerald-600 font-extrabold">On Time</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground font-medium">Timezone</dt>
                    <dd className="font-bold text-foreground">{viewingReport.report.timezone}</dd>
                  </div>
                </dl>

                <div className="space-y-3 pt-2">
                  <h4 className="text-xs uppercase font-extrabold text-muted-foreground tracking-wider">
                    Submitted Answers
                  </h4>
                  {viewingReport.report.answers?.map((answer, index) => (
                    <div
                      key={`${answer.questionId}-${index}`}
                      className="rounded-lg border p-3.5 bg-background"
                    >
                      <div className="text-xs font-bold text-foreground">{answer.question}</div>
                      <FormattedAnswerText
                        text={answer.answer}
                        mentions={answer.mentions}
                        className="mt-1.5 text-xs text-muted-foreground font-medium"
                      />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-center space-y-2">
                <div className="text-rose-600 font-extrabold text-base">
                  ⚠️ Report Missed (Not Submitted)
                </div>
                <p className="text-xs text-muted-foreground font-medium">
                  {viewingReport.employee.name} did not submit their{" "}
                  {viewingReport.reportType.toUpperCase()} report for {viewingReport.dateKey} before
                  the deadline passed.
                </p>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t">
              <button
                type="button"
                onClick={() => setViewingReport(null)}
                className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground hover:bg-primary/90"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
