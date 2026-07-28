import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query, limit, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Department, Employee, LeaveRequest, Punch } from "@/lib/types";
import { StatusDot } from "@/components/StatusDot";
import { COUNTRY_TIMEZONES } from "@/lib/time";
import {
  formatInTimezone,
  getActiveEmployeeLeave,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getLeaveLabel,
  getShiftTimezone,
  zonedDateKey,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import {
  Users,
  Clock,
  ChevronDown,
  ChevronUp,
  Filter,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { format } from "date-fns";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Time Station Admin" },
      {
        name: "description",
        content: "Live team status, department cards, and today's activity feed.",
      },
      { property: "og:title", content: "Dashboard — Time Station Admin" },
      {
        property: "og:description",
        content: "Live team status, department cards, and today's activity feed.",
      },
    ],
  }),
  component: AdminHome,
});

function AdminHome() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [todayPunches, setTodayPunches] = useState<Punch[]>([]);
  const [historicalRecent, setHistoricalRecent] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);

  // Dashboard UI States
  const [filterDeptId, setFilterDeptId] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [expandedDeptMap, setExpandedDeptMap] = useState<Record<string, boolean>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [historyLimit, setHistoryLimit] = useState(15);

  const [now, setNow] = useState(() => new Date());
  const { company } = useAuth();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const un1 = onSnapshot(collection(db(), "employees"), (s) =>
      setEmployees(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) }))),
    );

    const un2 = onSnapshot(collection(db(), "departments"), (s) =>
      setDepartments(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Department, "id">) }))),
    );

    const un3 = onSnapshot(collection(db(), "punches"), (s) =>
      setTodayPunches(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }))),
    );

    const un4 = onSnapshot(
      query(collection(db(), "leaveRequests"), where("status", "==", "approved")),
      (s) =>
        setLeaves(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<LeaveRequest, "id">) }))),
    );

    return () => {
      un1();
      un2();
      un3();
      un4();
    };
  }, []);

  // Load historical recent punches only when "Load History" is requested
  useEffect(() => {
    if (!showHistory) return;
    const unsub = onSnapshot(
      query(collection(db(), "punches"), orderBy("timestamp", "desc"), limit(historyLimit)),
      (s) =>
        setHistoricalRecent(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) }))),
    );
    return () => unsub();
  }, [showHistory, historyLimit]);

  const empById = useMemo(() => {
    const map = new Map<string, Employee>();
    employees.forEach((employee) => {
      map.set(employee.id, employee);
      if (employee.authUid) map.set(employee.authUid, employee);
    });
    return map;
  }, [employees]);

  // Group punches by employee for fast today lookup
  const empTodayPunches = useMemo(() => {
    const map = new Map<string, Punch[]>();
    for (const p of todayPunches) {
      if (!map.has(p.employeeId)) map.set(p.employeeId, []);
      map.get(p.employeeId)!.push(p);
    }
    // Sort each employee's list by time
    for (const list of map.values()) {
      list.sort((a, b) => (a.timestamp?.toMillis() || 0) - (b.timestamp?.toMillis() || 0));
    }
    return map;
  }, [todayPunches]);

  function getEmpTodayStatus(emp: Employee) {
    const employeeToday = zonedDateKey(now, getEmployeeTimezone(emp));
    const holiday = getEmployeeHoliday(company, emp, employeeToday);
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
    if (activeLeave) {
      return {
        type: "leave" as const,
        label: getLeaveLabel(activeLeave),
        isLate: false,
        minutesLate: 0,
        punchTimeStr: "",
        isAutoPunchOut: false,
      };
    }

    const list = [
      ...(empTodayPunches.get(emp.id) || []),
      ...(emp.authUid ? empTodayPunches.get(emp.authUid) || [] : []),
    ];
    const status = getLiveAttendanceStatus(
      emp,
      list,
      now,
      company?.lateGraceMinutes ?? 1,
      company?.workingDays,
      getEmployeeHolidayDates(company, emp),
    );
    const localTimezone = getEmployeeTimezone(emp);
    const latestDate = status.latest?.timestamp?.toDate();
    const timeStr = latestDate ? formatInTimezone(latestDate, localTimezone) : "";
    const statusTimeStr =
      latestDate && zonedDateKey(latestDate, localTimezone) !== employeeToday
        ? formatInTimezone(latestDate, localTimezone, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : timeStr;

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
  // Filtered department list based on user selection
  const filteredDepartments = useMemo(() => {
    if (filterDeptId === "all") return departments;
    return departments.filter((d) => d.id === filterDeptId);
  }, [departments, filterDeptId]);

  const todayActivityFeed = useMemo(() => {
    return todayPunches
      .filter((punch) => {
        if (!punch.timestamp) return false;
        const employee = empById.get(punch.employeeId);
        const timezone = getShiftTimezone(employee);
        return zonedDateKey(punch.timestamp.toDate(), timezone) === zonedDateKey(now, timezone);
      })
      .sort((a, b) => (b.timestamp?.toMillis() || 0) - (a.timestamp?.toMillis() || 0));
  }, [todayPunches, empById, now]);

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Top Header & Quick Filter Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" /> Live Team Dashboard
          </h1>
          <p className="text-sm text-muted-foreground font-medium mt-0.5">
            Real-time department status and today's activity feed for{" "}
            {format(new Date(), "EEEE, MMMM d, yyyy")}.
          </p>
        </div>

        {/* Global Filters */}
        <div className="flex items-center gap-2 flex-wrap">
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
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="bg-transparent outline-none font-bold text-primary cursor-pointer"
            >
              <option value="all">All Statuses</option>
              <option value="holiday">Holiday</option>
              <option value="leave">Leave / Half-day / Break</option>
              <option value="in">🟢 Punched In Today</option>
              <option value="out">🔴 Punched Out Today</option>
              <option value="late">⚠️ Late Arrivals Today</option>
            </select>
          </div>
        </div>
      </div>

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
            <div className="col-span-full rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground font-medium">
              No departments found.{" "}
              <Link to="/admin/departments" className="text-primary underline font-bold">
                Create Departments
              </Link>
              .
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
              if (filterStatus === "out") return status.type === "out";
              if (filterStatus === "holiday") return status.type === "holiday";
              if (filterStatus === "leave") return status.type === "leave";
              if (filterStatus === "late") return status.isLate;
              return true;
            });

            const punchedInCount = allMembers.filter(
              (m) => getEmpTodayStatus(m).type === "in",
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
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">
                      {punchedInCount} Active In
                    </span>
                    {lateCount > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20">
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
                        COUNTRY_TIMEZONES[m.country ?? "NP"] || COUNTRY_TIMEZONES.NP;

                      return (
                        <div
                          key={m.id}
                          className="flex items-center justify-between p-2.5 rounded-lg border bg-secondary/20 hover:bg-secondary/40 transition-colors text-xs"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <StatusDot status={status.type} />
                            <div className="truncate">
                              <Link
                                to="/admin/employees/$id"
                                params={{ id: m.id }}
                                className="font-bold text-foreground hover:underline truncate block"
                              >
                                {m.name}
                              </Link>
                              <span className="text-[11px] text-muted-foreground">
                                {m.jobTitle || "Member"} · {countryData.flag}
                              </span>
                            </div>
                          </div>

                          <div className="text-right shrink-0">
                            <span className="font-medium text-xs block text-slate-700 dark:text-slate-300">
                              {status.label}
                            </span>
                            {status.isAutoPunchOut && (
                              <span className="inline-flex items-center gap-1 text-[10px] font-extrabold text-sky-700 bg-sky-500/10 border border-sky-500/20 px-1.5 py-0.5 rounded">
                                <Clock className="h-3 w-3" /> Automatic
                              </span>
                            )}
                            {status.isLate && (
                              <span className="inline-flex items-center gap-0.5 text-[10px] font-extrabold text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
                                <AlertTriangle className="h-3 w-3" /> {status.minutesLate}m Late
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
            <span className="text-xs font-bold text-emerald-600 bg-emerald-500/10 px-2.5 py-1 rounded border border-emerald-500/20">
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
            const timeFormatted = p.timestamp
              ? formatInTimezone(p.timestamp.toDate(), getEmployeeTimezone(emp))
              : "—";
            const dateFormatted = p.timestamp
              ? new Intl.DateTimeFormat("en-US", {
                  timeZone: getEmployeeTimezone(emp),
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).format(p.timestamp.toDate())
              : "";
            const isPunchIn = p.type === "in" || p.type === "extra_in";

            return (
              <li
                key={p.id}
                className="p-3.5 flex items-center justify-between hover:bg-secondary/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <StatusDot status={isPunchIn ? "in" : "out"} />
                  <div>
                    <div className="font-bold text-sm text-foreground flex items-center gap-1.5">
                      <span>{emp?.name ?? p.employeeName ?? p.employeeId}</span>
                      <span className="text-[10px] text-muted-foreground font-normal">
                        ({countryData.flag} {countryData.name})
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-semibold text-muted-foreground">
                        {isPunchIn ? "Punched IN" : p.isAuto ? "AUTO PUNCHED OUT" : "Punched OUT"}
                      </span>
                      {p.isAuto && !isPunchIn && (
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
    </div>
  );
}
