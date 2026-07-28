import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { AlertTriangle, Clock3, UserX } from "lucide-react";
import { db } from "@/lib/firebase";
import type { Department, Employee, LeaveRequest, Punch } from "@/lib/types";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getActiveEmployeeLeave,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getShiftTimezone,
  zonedDateKey,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/_authenticated/admin/late")({
  head: () => ({ meta: [{ title: "Late Logs — Time Station Admin" }] }),
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
};

function LateArrivalsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [filterDept, setFilterDept] = useState("");
  const [filterPeriod, setFilterPeriod] = useState<"today" | "week" | "month" | "all">("today");
  const [now, setNow] = useState(() => new Date());
  const { company } = useAuth();
  const graceMinutes = company?.lateGraceMinutes ?? 1;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    const unsubscribers = [
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
    for (const employee of employees.filter((item) => item.status === "active")) {
      const list = employeePunches.get(employee.id) || [];
      const firstByShiftDate = new Map<string, Punch>();
      const shiftTimezone = getShiftTimezone(employee);
      for (const punch of list) {
        if (punch.type !== "in" || !punch.timestamp) continue;
        const dateKey = zonedDateKey(punch.timestamp.toDate(), shiftTimezone);
        const current = firstByShiftDate.get(dateKey);
        if (!current || punch.timestamp.toMillis() < current.timestamp.toMillis())
          firstByShiftDate.set(dateKey, punch);
      }
      for (const [dateKey, punch] of firstByShiftDate) {
        const approvedLeave = getEmployeeApprovedLeaveForDate(employee, leaves, dateKey);
        if (approvedLeave?.leaveType !== "timed_break") continue;
        if (getEmployeeHoliday(company, employee, dateKey)) continue;
        const late = computeEmployeeLateness(punch.timestamp.toDate(), employee, graceMinutes);
        if (!late.isLate) continue;
        result.push({
          id: punch.id,
          employee,
          dateKey,
          scheduledAt: late.scheduledAt,
          punchedAt: punch.timestamp.toDate(),
          minutesLate: late.minutes,
          kind: "arrival",
        });
      }

      const onLeave = Boolean(getActiveEmployeeLeave(employee, leaves, now));

      const status = getLiveAttendanceStatus(
        employee,
        list,
        now,
        graceMinutes,
        company?.workingDays,
        getEmployeeHolidayDates(company, employee),
      );
      if (!onLeave && status.isMissingLate) {
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
    return result.sort((a, b) => (b.punchedAt || now).getTime() - (a.punchedAt || now).getTime());
  }, [employees, employeePunches, leaves, now, graceMinutes, company]);

  const filtered = useMemo(
    () =>
      records.filter((record) => {
        if (filterDept && record.employee.deptId !== filterDept) return false;
        const age = now.getTime() - record.scheduledAt.getTime();
        if (filterPeriod === "today")
          return record.dateKey === zonedDateKey(now, getShiftTimezone(record.employee));
        if (filterPeriod === "week") return age <= 7 * 86400000;
        if (filterPeriod === "month") return age <= 31 * 86400000;
        return true;
      }),
    [records, filterDept, filterPeriod, now],
  );

  const missingCount = filtered.filter((record) => record.kind === "missing").length;
  const arrivalCount = filtered.filter((record) => record.kind === "arrival").length;
  const totalMinutes = filtered.reduce((sum, record) => sum + record.minutesLate, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <Clock3 className="h-6 w-6" /> Late Logs
        </h1>
        <p className="text-sm text-muted-foreground">
          Live late alerts and arrival history calculated against each shift’s reference timezone.
          Grace period: {graceMinutes} minute(s).
        </p>
      </div>

      <div className="grid sm:grid-cols-3 gap-4">
        <Stat label="Not punched in" value={missingCount} tone="rose" />
        <Stat label="Late arrivals" value={arrivalCount} tone="amber" />
        <Stat label="Total late minutes" value={totalMinutes} tone="primary" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(["today", "week", "month", "all"] as const).map((period) => (
          <button
            key={period}
            onClick={() => setFilterPeriod(period)}
            className={`rounded-md px-3 py-1.5 text-xs font-bold capitalize ${filterPeriod === period ? "bg-primary text-primary-foreground" : "border bg-card"}`}
          >
            {period}
          </button>
        ))}
        <select
          value={filterDept}
          onChange={(event) => setFilterDept(event.target.value)}
          className="ml-auto rounded-md border bg-card px-3 py-1.5 text-xs"
        >
          <option value="">All departments</option>
          {departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </select>
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
                    <div className="font-semibold">
                      {formatInTimezone(record.scheduledAt, shiftTimezone)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{shiftTimezone}</div>
                  </td>
                  <td className="p-3.5">
                    <div className="font-semibold">
                      {record.punchedAt
                        ? formatInTimezone(record.punchedAt, employeeTimezone)
                        : "Waiting for punch"}
                    </div>
                    <div className="text-[10px] text-muted-foreground">{employeeTimezone}</div>
                  </td>
                  <td className="p-3.5 font-bold text-amber-600">{record.minutesLate} min</td>
                  <td className="p-3.5">
                    {record.kind === "missing" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-1 text-xs font-bold text-rose-600">
                        <UserX className="h-3.5 w-3.5" /> Missing
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-700">
                        <AlertTriangle className="h-3.5 w-3.5" /> Arrived late
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="p-10 text-center text-muted-foreground">
                  No late records for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
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
