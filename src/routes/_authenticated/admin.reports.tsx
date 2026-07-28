import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { Download, FileText, Search } from "lucide-react";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import type { Department, Employee, LeaveRequest, Punch } from "@/lib/types";
import { computeDay } from "@/lib/time";
import {
  computeEmployeeLateness,
  formatInTimezone,
  getEmployeeTimezone,
  getShiftTimezone,
  isEmployeeOnApprovedLeave,
  zonedDateKey,
} from "@/lib/attendance";

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
  head: () => ({ meta: [{ title: "Attendance Reports — Time Station Admin" }] }),
  component: ReportsPage,
});

function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

function ReportsPage() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const initialBounds = monthBounds(currentMonth);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [month, setMonth] = useState(currentMonth);
  const [from, setFrom] = useState(initialBounds.from);
  const [to, setTo] = useState(initialBounds.to);
  const [departmentId, setDepartmentId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
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
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  const filteredEmployees = useMemo(
    () =>
      employees.filter((employee) => {
        if (departmentId && employee.deptId !== departmentId) return false;
        if (employeeId && employee.id !== employeeId && employee.authUid !== employeeId)
          return false;
        if (
          search &&
          !`${employee.name} ${employee.email}`.toLowerCase().includes(search.toLowerCase())
        )
          return false;
        return true;
      }),
    [employees, departmentId, employeeId, search],
  );

  const rows = useMemo(() => {
    const output: AttendanceRow[] = [];
    for (const employee of filteredEmployees) {
      const ids = new Set([employee.id, employee.authUid].filter(Boolean));
      const shiftTimezone = getShiftTimezone(employee);
      const groups = new Map<string, Punch[]>();
      for (const punch of punches) {
        if (!ids.has(punch.employeeId) || !punch.timestamp) continue;
        const date = zonedDateKey(punch.timestamp.toDate(), shiftTimezone);
        if (date < from || date > to) continue;
        if (!groups.has(date)) groups.set(date, []);
        groups.get(date)!.push(punch);
      }
      for (const [date, dayPunches] of groups) {
        const sorted = [...dayPunches].sort(
          (a, b) => a.timestamp.toMillis() - b.timestamp.toMillis(),
        );
        const firstIn = sorted.find((punch) => punch.type === "in");
        const lastOut = [...sorted].reverse().find((punch) => punch.type === "out");
        const calculation = computeDay(sorted);
        const onApprovedLeave = isEmployeeOnApprovedLeave(employee, leaves, date);
        const late = firstIn
          ? computeEmployeeLateness(firstIn.timestamp.toDate(), employee, 1)
          : null;
        const isAutoPunchOut = Boolean(lastOut?.isAuto);
        output.push({
          key: `${employee.id}-${date}`,
          employee,
          department:
            departments.find((item) => item.id === employee.deptId)?.name || "No department",
          date,
          firstIn,
          lastOut,
          hours: calculation.regularHours + calculation.overtimeHours,
          status: onApprovedLeave
            ? "On leave"
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
          minutesLate: !onApprovedLeave && late?.isLate ? late.minutes : 0,
          isAutoPunchOut,
        });
      }
    }
    return output.sort(
      (a, b) => b.date.localeCompare(a.date) || a.employee.name.localeCompare(b.employee.name),
    );
  }, [filteredEmployees, punches, leaves, departments, from, to]);

  const exportData = useMemo(
    () =>
      rows.map((row) => {
        const localTimezone = getEmployeeTimezone(row.employee);
        return {
          Department: row.department,
          Employee: row.employee.name,
          Date: row.date,
          PunchIn: row.firstIn
            ? formatInTimezone(row.firstIn.timestamp.toDate(), localTimezone)
            : "",
          PunchOut: row.lastOut
            ? formatInTimezone(row.lastOut.timestamp.toDate(), localTimezone)
            : "",
          Hours: row.hours.toFixed(2),
          Status: row.status,
          MinutesLate: row.minutesLate,
        };
      }),
    [rows],
  );

  function fileScope() {
    if (employeeId) return filteredEmployees[0]?.name.replace(/\s+/g, "_") || "employee";
    if (departmentId)
      return (
        departments.find((item) => item.id === departmentId)?.name.replace(/\s+/g, "_") ||
        "department"
      );
    return "all_departments";
  }

  function exportCsv() {
    if (!exportData.length) return toast.error("No attendance records match this report.");
    const blob = new Blob([Papa.unparse(exportData)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `attendance_${fileScope()}_${from}_to_${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Attendance CSV downloaded");
  }

  function exportPdf() {
    if (!rows.length) return toast.error("No attendance records match this report.");
    const pdf = new jsPDF({ orientation: "landscape" });
    pdf.setFontSize(16);
    pdf.text("Time Station Attendance Report", 14, 16);
    pdf.setFontSize(9);
    pdf.text(`${from} to ${to} · ${fileScope().replace(/_/g, " ")}`, 14, 23);
    let y = 34;
    pdf.setFont("helvetica", "bold");
    pdf.text("Date", 14, y);
    pdf.text("Employee", 42, y);
    pdf.text("Department", 92, y);
    pdf.text("In", 140, y);
    pdf.text("Out", 172, y);
    pdf.text("Hours", 205, y);
    pdf.text("Status", 230, y);
    pdf.setFont("helvetica", "normal");
    for (const row of rows) {
      y += 7;
      if (y > 190) {
        pdf.addPage();
        y = 20;
      }
      const timezone = getEmployeeTimezone(row.employee);
      pdf.text(row.date, 14, y);
      pdf.text(row.employee.name.slice(0, 26), 42, y);
      pdf.text(row.department.slice(0, 24), 92, y);
      pdf.text(
        row.firstIn ? formatInTimezone(row.firstIn.timestamp.toDate(), timezone) : "—",
        140,
        y,
      );
      pdf.text(
        row.lastOut ? formatInTimezone(row.lastOut.timestamp.toDate(), timezone) : "—",
        172,
        y,
      );
      pdf.text(row.hours.toFixed(2), 205, y);
      pdf.text(row.status, 230, y);
    }
    pdf.save(`attendance_${fileScope()}_${from}_to_${to}.pdf`);
    toast.success("Attendance PDF downloaded");
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
          <FileText className="h-6 w-6" /> Attendance Reports
        </h1>
        <p className="text-sm text-muted-foreground">
          Inspect and download one employee, one department, or all departments. Times are shown in
          each employee’s local timezone.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-lift space-y-4">
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <label className="text-xs font-bold text-muted-foreground">
            Month
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
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs font-bold text-muted-foreground">
            From
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs font-bold text-muted-foreground">
            To
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="text-xs font-bold text-muted-foreground">
            Department
            <select
              value={departmentId}
              onChange={(event) => {
                setDepartmentId(event.target.value);
                setEmployeeId("");
              }}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
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
            Employee
            <select
              value={employeeId}
              onChange={(event) => setEmployeeId(event.target.value)}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="">All employees</option>
              {employees
                .filter((employee) => !departmentId || employee.deptId === departmentId)
                .map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search employee…"
              className="w-full rounded-md border bg-background py-2 pl-9 pr-3 text-sm"
            />
          </div>
          <button
            onClick={exportCsv}
            className="rounded-md border px-4 py-2 text-sm font-bold text-primary flex items-center justify-center gap-2"
          >
            <Download className="h-4 w-4" /> Download Filtered CSV
          </button>
          <button
            onClick={exportPdf}
            className="rounded-md bg-primary px-4 py-2 text-sm font-bold text-primary-foreground flex items-center justify-center gap-2"
          >
            <FileText className="h-4 w-4" /> Download PDF
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Summary label="Employees" value={new Set(rows.map((row) => row.employee.id)).size} />
        <Summary label="Attendance days" value={rows.length} />
        <Summary label="Late arrivals" value={rows.filter((row) => row.minutesLate > 0).length} />
      </div>

      <div className="rounded-xl border bg-card overflow-x-auto shadow-lift">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-secondary text-left text-xs uppercase text-muted-foreground">
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
            {rows.map((row) => {
              const timezone = getEmployeeTimezone(row.employee);
              return (
                <tr key={row.key} className="hover:bg-secondary/30">
                  <td className="p-3 font-mono text-xs">{row.date}</td>
                  <td className="p-3">
                    <div className="font-bold">{row.employee.name}</div>
                    <div className="text-xs text-muted-foreground">{row.employee.email}</div>
                  </td>
                  <td className="p-3">{row.department}</td>
                  <td className="p-3 font-mono text-xs">
                    {row.firstIn ? formatInTimezone(row.firstIn.timestamp.toDate(), timezone) : "—"}
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {row.lastOut
                      ? formatInTimezone(row.lastOut.timestamp.toDate(), timezone)
                      : "Still in"}
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
                      Open employee
                    </Link>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-10 text-center text-muted-foreground">
                  No attendance records match the selected report.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs font-bold uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-black text-primary">{value}</div>
    </div>
  );
}
