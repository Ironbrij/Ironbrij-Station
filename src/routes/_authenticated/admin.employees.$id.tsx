import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { Calendar, Download, FileText, Timer } from "lucide-react";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import type { Department, Employee, LeaveRequest, Punch } from "@/lib/types";
import { computeDay } from "@/lib/time";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getActiveEmployeeLeave,
  getEmployeeApprovedLeaveForDate,
  getEmployeeApprovedLeaveDates,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getLeaveLabel,
  getShiftConversions,
  getShiftTimezone,
  zonedDateKey,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import { normalizeState } from "@/lib/states";

export const Route = createFileRoute("/_authenticated/admin/employees/$id")({
  head: () => ({ meta: [{ title: "Employee Attendance — Time Station Admin" }] }),
  component: EmployeeDetail,
});

type DayRow = {
  date: string;
  punches: Punch[];
  firstIn?: Punch;
  lastOut?: Punch;
  hours: number;
  minutesLate: number;
  status: string;
  isAutoPunchOut: boolean;
};

function EmployeeDetail() {
  const { id } = Route.useParams();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [allPunches, setAllPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [now, setNow] = useState(() => new Date());
  const { company } = useAuth();

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
        setAllPunches(
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

  const employee = useMemo(
    () => employees.find((item) => item.id === id || item.authUid === id),
    [employees, id],
  );
  const punches = useMemo(() => {
    if (!employee) return [];
    const ids = new Set([employee.id, employee.authUid].filter(Boolean));
    return allPunches.filter((punch) => ids.has(punch.employeeId));
  }, [allPunches, employee]);

  const rows = useMemo(() => {
    if (!employee) return [];
    const groups = new Map<string, Punch[]>();
    const timezone = getShiftTimezone(employee);
    for (const punch of punches) {
      if (!punch.timestamp) continue;
      const date = zonedDateKey(punch.timestamp.toDate(), timezone);
      if (!date.startsWith(month)) continue;
      if (!groups.has(date)) groups.set(date, []);
      groups.get(date)!.push(punch);
    }
    for (const date of getEmployeeHolidayDates(company, employee)) {
      if (date.startsWith(month) && !groups.has(date)) groups.set(date, []);
    }
    for (const date of getEmployeeApprovedLeaveDates(employee, leaves)) {
      if (date.startsWith(month) && !groups.has(date)) groups.set(date, []);
    }
    const output: DayRow[] = [];
    for (const [date, dayPunches] of groups) {
      const sorted = [...dayPunches].sort(
        (a, b) => a.timestamp.toMillis() - b.timestamp.toMillis(),
      );
      const firstIn = sorted.find((punch) => punch.type === "in");
      const lastOut = [...sorted].reverse().find((punch) => punch.type === "out");
      const isAutoPunchOut = Boolean(lastOut?.isAuto);
      const hours = computeDay(sorted).regularHours + computeDay(sorted).overtimeHours;
      const approvedLeave = getEmployeeApprovedLeaveForDate(employee, leaves, date);
      const holiday = getEmployeeHoliday(company, employee, date);
      const lateness = firstIn
        ? computeEmployeeLateness(
            firstIn.timestamp.toDate(),
            employee,
            company?.lateGraceMinutes ?? 1,
          )
        : null;
      output.push({
        date,
        punches: sorted,
        firstIn,
        lastOut,
        hours,
        minutesLate: !holiday && !approvedLeave && lateness?.isLate ? lateness.minutes : 0,
        isAutoPunchOut,
        status: holiday
          ? "Holiday"
          : approvedLeave
            ? getLeaveLabel(approvedLeave)
            : !firstIn
              ? "No punch in"
              : !lastOut
                ? "Still punched in"
                : lastOut.isAuto
                  ? lateness?.isLate
                    ? "Auto punched out · Late"
                    : "Auto punched out"
                  : lateness?.isLate
                    ? "Late"
                    : "On time",
      });
    }
    return output.sort((a, b) => b.date.localeCompare(a.date));
  }, [employee, punches, leaves, month, company]);

  const liveStatus = useMemo(
    () =>
      employee
        ? getLiveAttendanceStatus(
            employee,
            punches,
            now,
            company?.lateGraceMinutes ?? 1,
            company?.workingDays,
            getEmployeeHolidayDates(company, employee),
          )
        : null,
    [employee, punches, now, company],
  );
  const activeLeave = useMemo(
    () => (employee ? getActiveEmployeeLeave(employee, leaves, now) : null),
    [employee, leaves, now],
  );
  const onLeaveToday = Boolean(activeLeave);
  const onHolidayToday = useMemo(
    () =>
      employee
        ? Boolean(
            getEmployeeHoliday(company, employee, zonedDateKey(now, getEmployeeTimezone(employee))),
          )
        : false,
    [company, employee, now],
  );
  const shiftConversions = useMemo(
    () => (employee ? getShiftConversions(employee, now) : []),
    [employee, now],
  );
  const employeeLeaves = useMemo(() => {
    if (!employee) return [];
    return leaves
      .filter((leave) => leave.employeeId === employee.id || leave.employeeId === employee.authUid)
      .sort((a, b) => b.dateFrom.localeCompare(a.dateFrom));
  }, [leaves, employee]);
  const totalHours = rows.reduce((sum, row) => sum + row.hours, 0);
  const lateDays = rows.filter((row) => row.minutesLate > 0).length;

  function exportRows() {
    if (!employee) return [];
    const timezone = getEmployeeTimezone(employee);
    return rows.map((row) => ({
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
      Status: row.status,
      MinutesLate: row.minutesLate,
      AllEvents: row.punches
        .map(
          (punch) =>
            `${punch.type.toUpperCase()} ${formatInTimezone(punch.timestamp.toDate(), timezone)}`,
        )
        .join(" | "),
    }));
  }

  function downloadCsv() {
    if (!employee || !rows.length) return toast.error("No attendance records for this month.");
    const blob = new Blob([Papa.unparse(exportRows())], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${employee.name.replace(/\s+/g, "_")}_${month}_attendance.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Employee CSV downloaded");
  }

  function downloadPdf() {
    if (!employee || !rows.length) return toast.error("No attendance records for this month.");
    const timezone = getEmployeeTimezone(employee);
    const pdf = new jsPDF();
    pdf.setFontSize(16);
    pdf.text(`${employee.name} — Attendance`, 14, 17);
    pdf.setFontSize(9);
    pdf.text(`${month} · ${timezone} · ${rows.length} attendance days`, 14, 24);
    let y = 36;
    pdf.setFont("helvetica", "bold");
    pdf.text("Date", 14, y);
    pdf.text("In", 48, y);
    pdf.text("Out", 80, y);
    pdf.text("Hours", 112, y);
    pdf.text("Status", 140, y);
    pdf.setFont("helvetica", "normal");
    for (const row of rows) {
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
      pdf.text(
        row.isAutoPunchOut
          ? `${row.status}${row.minutesLate ? ` ${row.minutesLate}m` : ""}`
          : row.minutesLate
            ? `Late ${row.minutesLate}m`
            : row.status,
        140,
        y,
      );
    }
    pdf.save(`${employee.name.replace(/\s+/g, "_")}_${month}_attendance.pdf`);
    toast.success("Employee PDF downloaded");
  }

  if (!employee)
    return <div className="p-12 text-center text-muted-foreground">Loading employee…</div>;
  const timezone = getEmployeeTimezone(employee);
  const department =
    departments.find((item) => item.id === employee.deptId)?.name || "No department";

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-primary">{employee.name}</h1>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-bold ${liveStatus?.isPunchedIn ? "bg-emerald-500/10 text-emerald-700" : "bg-slate-500/10 text-slate-600"}`}
            >
              {onHolidayToday
                ? "Holiday"
                : onLeaveToday
                  ? getLeaveLabel(activeLeave)
                  : liveStatus?.isPunchedIn
                    ? "Punched in"
                    : "Punched out"}
            </span>
            {!onHolidayToday && !onLeaveToday && liveStatus?.isLate && (
              <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-bold text-amber-700">
                {liveStatus.minutesLate}m late
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {employee.jobTitle} · {department} · State: {normalizeState(employee.state)}
          </p>
          <p className="text-xs text-muted-foreground">
            {employee.email} · {timezone}
          </p>
        </div>
        <Link
          to="/admin/employees"
          className="rounded-md border px-3 py-2 text-xs font-bold text-primary"
        >
          Back to employees
        </Link>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        {shiftConversions.map((zone) => (
          <div
            key={zone.value}
            className={`rounded-xl border p-4 ${zone.value === timezone ? "border-primary bg-primary/5" : "bg-card"}`}
          >
            <div className="text-xs font-bold text-muted-foreground">{zone.short}</div>
            <div className="mt-1 font-mono font-bold">
              {zone.start} – {zone.end}
            </div>
            {zone.value === timezone && (
              <div className="text-[10px] font-bold uppercase text-primary">
                Employee local time
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <Summary label="Attendance days" value={rows.length} />
        <Summary label="Hours recorded" value={totalHours.toFixed(2)} />
        <Summary label="Late days" value={lateDays} />
      </div>

      <section className="rounded-xl border bg-card shadow-lift overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b p-4">
          <div>
            <h2 className="font-bold text-primary flex items-center gap-2">
              <Timer className="h-4 w-4" /> Monthly attendance
            </h2>
            <p className="text-xs text-muted-foreground">
              Every punch in and punch out for the selected month.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={downloadCsv}
              className="rounded-md border px-3 py-2 text-xs font-bold text-primary flex items-center gap-1"
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </button>
            <button
              onClick={downloadPdf}
              className="rounded-md bg-primary px-3 py-2 text-xs font-bold text-primary-foreground flex items-center gap-1"
            >
              <FileText className="h-3.5 w-3.5" /> PDF
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-secondary text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Date</th>
                <th className="p-3">Punch in</th>
                <th className="p-3">Punch out</th>
                <th className="p-3">Hours</th>
                <th className="p-3">Status</th>
                <th className="p-3">All events</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.date} className="hover:bg-secondary/30">
                  <td className="p-3 font-mono text-xs">{row.date}</td>
                  <td className="p-3 font-mono text-xs">
                    {row.firstIn ? formatInTimezone(row.firstIn.timestamp.toDate(), timezone) : "—"}
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {row.lastOut
                      ? formatInTimezone(row.lastOut.timestamp.toDate(), timezone)
                      : row.firstIn
                        ? "Still in"
                        : "â€”"}
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
                      {row.isAutoPunchOut
                        ? `${row.status}${row.minutesLate ? ` (${row.minutesLate}m)` : ""}`
                        : row.minutesLate
                          ? `Late ${row.minutesLate}m`
                          : row.status}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {row.punches
                      .map(
                        (punch) =>
                          `${punch.type.toUpperCase()} ${formatInTimezone(punch.timestamp.toDate(), timezone)}`,
                      )
                      .join(" · ")}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-10 text-center text-muted-foreground">
                    No attendance recorded in {month}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-lift">
        <h2 className="font-bold text-primary flex items-center gap-2">
          <Calendar className="h-4 w-4" /> Leave history
        </h2>
        <div className="mt-3 space-y-2">
          {employeeLeaves.map((leave) => (
            <div
              key={leave.id}
              className="flex items-center justify-between rounded-lg border p-3 text-sm"
            >
              <div>
                <div className="font-bold">
                  {leave.dateFrom} to {leave.dateTo}
                </div>
                <div className="text-xs text-muted-foreground">{leave.reason}</div>
              </div>
              <span className="rounded-full bg-secondary px-2 py-1 text-xs font-bold capitalize">
                {leave.status}
              </span>
            </div>
          ))}
          {employeeLeaves.length === 0 && (
            <p className="text-sm text-muted-foreground">No leave requests.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs font-bold uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-black text-primary">{value}</div>
    </div>
  );
}
