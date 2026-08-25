import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";
import {
  COMPANY_ID,
  type Company,
  type Department,
  type Employee,
  type LeaveRequest,
  type Punch,
} from "@/lib/types";
import { computeDay, COUNTRY_TIMEZONES, toDate, toMillis } from "@/lib/time";
import {
  computeEmployeeLateness,
  formatEmployeeShiftSummary,
  formatInTimezone,
  getEmployeeApprovedLeaveDates,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getShiftTimezone,
  getLeaveLabel,
  zonedDateKey,
} from "@/lib/attendance";
import { toast } from "sonner";
import {
  Trash2,
  Users,
  Clock,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  Calendar,
  Building2,
} from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { format } from "date-fns";
import Papa from "papaparse";
import { jsPDF } from "jspdf";
import { getStateOptions, normalizeState } from "@/lib/states";

export const Route = createFileRoute("/_authenticated/admin/departments")({
  head: () => ({
    meta: [
      { title: "Departments — SavyTimes Admin" },
      {
        name: "description",
        content: "Manage departments, assigned users, and download department reports.",
      },
      { property: "og:title", content: "Departments — SavyTimes Admin" },
      {
        property: "og:description",
        content: "Manage departments, assigned users, and download department reports.",
      },
    ],
  }),
  component: DepartmentsPage,
});

function DepartmentsPage() {
  const [depts, setDepts] = useState<Department[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [name, setName] = useState("");
  const [departmentState, setDepartmentState] = useState("N/A");
  const [deptCompanyId, setDeptCompanyId] = useState<string>(COMPANY_ID);
  const [filterCompanyId, setFilterCompanyId] = useState<string>("all");
  const [saving, setSaving] = useState(false);
  const [expandedDeptId, setExpandedDeptId] = useState<string | null>(null);
  const [reportDaysMap, setReportDaysMap] = useState<Record<string, number>>({});
  const [allReportDays, setAllReportDays] = useState(30);
  const [allReportDeptId, setAllReportDeptId] = useState("");
  const { user, loading: authLoading, company } = useAuth();

  useEffect(() => {
    if (authLoading || !user) return;

    const u0 = onSnapshot(collection(db(), "companies"), (s) => {
      setCompanies(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Company, "id">) })));
    });

    const u1 = onSnapshot(
      collection(db(), "departments"),
      (s) => {
        setDepts(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Department, "id">) })));
      },
      (err) => console.error("Error loading departments:", err),
    );

    const u2 = onSnapshot(
      collection(db(), "employees"),
      (s) => {
        setEmployees(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Employee, "id">) })));
      },
      (err) => console.error("Error loading employees for departments:", err),
    );

    const u3 = onSnapshot(
      collection(db(), "punches"),
      (s) => {
        setPunches(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Punch, "id">) })));
      },
      (err) => console.error("Error loading punches for department reports:", err),
    );

    const u4 = onSnapshot(
      collection(db(), "leaveRequests"),
      (snapshot) =>
        setLeaves(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<LeaveRequest, "id">),
          })),
        ),
      (error) => console.error("Error loading leave requests:", error),
    );

    return () => {
      u0();
      u1();
      u2();
      u3();
      u4();
    };
  }, [user, authLoading]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) return;

    setSaving(true);
    try {
      const deptRef = doc(collection(db(), "departments"));
      const deptId = deptRef.id;

      const selectedCompanyId = deptCompanyId || COMPANY_ID;
      await setDoc(deptRef, {
        companyId: selectedCompanyId,
        name: cleanName,
        state: departmentState,
        createdAt: new Date().toISOString(),
      });

      const newDept: Department = {
        id: deptId,
        companyId: selectedCompanyId,
        name: cleanName,
        state: departmentState,
      };

      setDepts((prev) => [...prev.filter((d) => d.id !== deptId), newDept]);
      setName("");
      setDepartmentState("N/A");
      toast.success(`Department "${cleanName}" created!`);
    } catch (err) {
      console.error(err);
      toast.error("Save Failed: " + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function rename(id: string, newName: string) {
    if (!newName.trim()) return;
    try {
      await updateDoc(doc(db(), "departments", id), { name: newName.trim() });
      toast.success("Department renamed");
    } catch (err) {
      toast.error("Failed to rename: " + (err as Error).message);
    }
  }

  async function updateDepartmentState(id: string, state: string) {
    try {
      await updateDoc(doc(db(), "departments", id), { state });
      toast.success("Department default state updated");
    } catch (err) {
      toast.error("Failed to update state: " + (err as Error).message);
    }
  }

  async function updateDepartmentCompany(id: string, companyId: string) {
    try {
      await updateDoc(doc(db(), "departments", id), { companyId });
      setDepts((prev) => prev.map((d) => (d.id === id ? { ...d, companyId } : d)));
      toast.success("Department company updated");
    } catch (err) {
      toast.error("Failed to update department company: " + (err as Error).message);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this department?")) return;
    try {
      await deleteDoc(doc(db(), "departments", id));
      setDepts((prev) => prev.filter((d) => d.id !== id));
      toast.success("Department removed");
    } catch (err) {
      toast.error("Failed to delete: " + (err as Error).message);
    }
  }

  function downloadDeptReport(dept: Department, daysRange: number, type: "csv" | "pdf") {
    const deptEmployees = employees.filter(
      (e) => e.deptId === dept.id && e.status === "active" && e.inviteStatus === "accepted",
    );
    if (deptEmployees.length === 0) {
      toast.error(`No employees assigned to ${dept.name} department.`);
      return;
    }

    const end = new Date();
    const start = new Date(Date.now() - daysRange * 86400000);

    const reportRows: Array<{
      EmployeeName: string;
      JobTitle: string;
      Country: string;
      Date: string;
      DayOfWeek: string;
      ClockIn: string;
      ClockOut: string;
      LatenessStatus: string;
      RegularHours: string;
      OvertimeHours: string;
    }> = [];

    for (const emp of deptEmployees) {
      const empPunches = punches.filter((p) => {
        if (!p.timestamp) return false;
        const matchesEmp = p.employeeId === emp.id || (emp.authUid && p.employeeId === emp.authUid);
        if (!matchesEmp) return false;
        const d = toDate(p.timestamp) ?? new Date();
        return d >= start && d <= end;
      });

      const empDays = new Map<string, Punch[]>();
      for (const p of empPunches) {
        if (!p.timestamp) continue;
        const punchedAt = toDate(p.timestamp);
        if (!punchedAt) continue;
        const dateStr = p.attendanceDate || p.date || zonedDateKey(punchedAt, getShiftTimezone(emp));
        if (!empDays.has(dateStr)) empDays.set(dateStr, []);
        empDays.get(dateStr)!.push(p);
      }
      const shiftTimezone = getShiftTimezone(emp);
      const startKey = zonedDateKey(start, shiftTimezone);
      const endKey = zonedDateKey(end, shiftTimezone);
      for (const date of getEmployeeHolidayDates(company, emp)) {
        if (date >= startKey && date <= endKey && !empDays.has(date)) empDays.set(date, []);
      }
      for (const date of getEmployeeApprovedLeaveDates(emp, leaves)) {
        if (date >= startKey && date <= endKey && !empDays.has(date)) empDays.set(date, []);
      }

      const countryData = COUNTRY_TIMEZONES[emp.country ?? "NP"] || COUNTRY_TIMEZONES.NP;

      for (const [dateStr, list] of empDays.entries()) {
        const sorted = [...list].sort(
          (a, b) => toMillis((a.timestamp) || 0) - toMillis((b.timestamp) || 0),
        );
        const firstIn = sorted.find((p) => p.type === "in" || p.type === "extra_in");
        const lastOut = [...sorted]
          .reverse()
          .find((p) => p.type === "out" || p.type === "extra_out");

        const sampleDate = firstIn?.timestamp
          ? toDate(firstIn.timestamp) ?? new Date()
          : new Date(dateStr + "T00:00:00");
        const dayCalc = computeDay(sorted, { employee: emp, company });

        const holiday = getEmployeeHoliday(company, emp, dateStr);
        const approvedLeave = getEmployeeApprovedLeaveForDate(emp, leaves, dateStr);
        let latenessText = holiday
          ? "Holiday"
          : approvedLeave
            ? getLeaveLabel(approvedLeave)
            : "On Time";
        if (firstIn && !holiday && !approvedLeave) {
          const lateness = computeEmployeeLateness(
            toDate(firstIn.timestamp) ?? new Date(),
            emp,
            company?.lateGraceMinutes ?? 5,
          );
          if (lateness.isLate) {
            latenessText = `Late (${lateness.minutes} mins late)`;
          } else if (lateness.isEarly) {
            latenessText = `Early (${lateness.minutes} mins early)`;
          }
        }

        const employeeTimezone = getEmployeeTimezone(emp);
        const clockInStr = firstIn
          ? formatInTimezone(toDate(firstIn.timestamp) ?? new Date(), employeeTimezone)
          : "N/A";
        const clockOutStr = lastOut
          ? formatInTimezone(toDate(lastOut.timestamp) ?? new Date(), employeeTimezone)
          : firstIn
            ? "Punched In"
            : "N/A";

        reportRows.push({
          EmployeeName: emp.name,
          JobTitle: emp.jobTitle || "Member",
          Country: countryData.name,
          Date: dateStr,
          DayOfWeek: format(sampleDate, "EEEE"),
          ClockIn: clockInStr,
          ClockOut: clockOutStr,
          LatenessStatus: latenessText,
          RegularHours: dayCalc.regularHours.toFixed(2),
          OvertimeHours: dayCalc.overtimeHours.toFixed(2),
        });
      }
    }

    if (reportRows.length === 0) {
      toast.error(`No punch logs found for ${dept.name} in the past ${daysRange} days.`);
      return;
    }

    if (type === "csv") {
      const csv = Papa.unparse(reportRows);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Department_${dept.name.replace(/\s+/g, "_")}_${daysRange}Days_Report.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${dept.name} CSV Report!`);
    } else {
      const pdf = new jsPDF();
      pdf.setFontSize(16);
      pdf.text(`Department Report: ${dept.name}`, 14, 18);
      pdf.setFontSize(10);
      pdf.text(`Period: Past ${daysRange} Days (${reportRows.length} activity records)`, 14, 26);
      let y = 38;
      pdf.setFont("helvetica", "bold");
      pdf.text("Employee", 14, y);
      pdf.text("Date / Day", 55, y);
      pdf.text("In - Out", 105, y);
      pdf.text("Lateness", 145, y);
      pdf.text("Hours", 175, y);
      pdf.setFont("helvetica", "normal");
      y += 6;

      for (const r of reportRows) {
        pdf.text(String(r.EmployeeName).slice(0, 18), 14, y);
        pdf.text(`${r.Date} (${r.DayOfWeek.slice(0, 3)})`, 55, y);
        pdf.text(`${r.ClockIn.slice(0, 8)} - ${r.ClockOut.slice(0, 8)}`, 105, y);
        pdf.text(String(r.LatenessStatus).slice(0, 15), 145, y);
        pdf.text(`${r.RegularHours}h`, 175, y);
        y += 6;
        if (y > 280) {
          pdf.addPage();
          y = 20;
        }
      }
      pdf.save(`Department_${dept.name.replace(/\s+/g, "_")}_${daysRange}Days_Report.pdf`);
      toast.success(`Exported ${dept.name} PDF Report!`);
    }
  }

  function downloadAllDepartmentsCsv(daysRange: number, departmentId: string) {
    const end = new Date();
    const start = new Date(Date.now() - daysRange * 86400000);
    const rows: Array<Record<string, string>> = [];

    for (const employee of employees) {
      const employeeTimezone = getEmployeeTimezone(employee);
      const shiftTimezone = getShiftTimezone(employee);
      const department = depts.find((item) => item.id === employee.deptId)?.name || "Unassigned";
      const employeePunches = punches.filter((punch) => {
        if (!punch.timestamp) return false;
        const belongsToEmployee =
          punch.employeeId === employee.id ||
          Boolean(employee.authUid && punch.employeeId === employee.authUid);
        const punchedAt = toDate(punch.timestamp) ?? new Date();
        return belongsToEmployee && punchedAt >= start && punchedAt <= end;
      });
      const days = new Map<string, Punch[]>();
      for (const punch of employeePunches) {
        const punchedAt = toDate(punch.timestamp);
        if (!punchedAt) continue;
        const dateKey = punch.attendanceDate || punch.date || zonedDateKey(punchedAt, shiftTimezone);
        days.set(dateKey, [...(days.get(dateKey) || []), punch]);
      }
      const startKey = zonedDateKey(start, shiftTimezone);
      const endKey = zonedDateKey(end, shiftTimezone);
      for (const date of getEmployeeHolidayDates(company, employee)) {
        if (date >= startKey && date <= endKey && !days.has(date)) days.set(date, []);
      }
      for (const date of getEmployeeApprovedLeaveDates(employee, leaves)) {
        if (date >= startKey && date <= endKey && !days.has(date)) days.set(date, []);
      }

      for (const [dateKey, dayPunches] of days) {
        const sorted = [...dayPunches].sort(
          (a, b) => toMillis(a.timestamp) - toMillis(b.timestamp),
        );
        const firstIn = sorted.find((punch) => punch.type === "in" || punch.type === "extra_in");
        const lastOut = [...sorted]
          .reverse()
          .find((punch) => punch.type === "out" || punch.type === "extra_out");
        const day = computeDay(sorted, { employee, company });
        const approvedLeave = getEmployeeApprovedLeaveForDate(employee, leaves, dateKey);
        const holiday = getEmployeeHoliday(company, employee, dateKey);
        const lateness =
          firstIn && !holiday && !approvedLeave
            ? computeEmployeeLateness(
                toDate(firstIn.timestamp) ?? new Date(),
                employee,
                company?.lateGraceMinutes ?? 5,
              )
            : null;
        rows.push({
          Department: department,
          Employee: employee.name,
          Date: dateKey,
          ClockIn: firstIn ? formatInTimezone(toDate(firstIn.timestamp) ?? new Date(), employeeTimezone) : "",
          ClockOut: lastOut
            ? formatInTimezone(toDate(lastOut.timestamp) ?? new Date(), employeeTimezone)
            : firstIn
              ? "Still punched in"
              : "",
          AttendanceStatus: holiday
            ? "Holiday"
            : approvedLeave
              ? getLeaveLabel(approvedLeave)
              : lateness?.isLate
                ? `Late (${lateness.minutes} min)`
                : firstIn
                  ? "On time"
                  : "No punch in",
          RegularHours: day.regularHours.toFixed(2),
          OvertimeHours: day.overtimeHours.toFixed(2),
        });
      }
    }

    if (rows.length === 0) {
      toast.error(`No attendance data found in the past ${daysRange} days.`);
      return;
    }
    rows.sort(
      (a, b) =>
        a.Department.localeCompare(b.Department) ||
        a.Employee.localeCompare(b.Employee) ||
        b.Date.localeCompare(a.Date),
    );
    const csv = Papa.unparse(rows);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    const scopeName = departmentId
      ? depts.find((item) => item.id === departmentId)?.name || "Department"
      : "All_Departments";
    anchor.download = `${scopeName.replace(/\s+/g, "_")}_${daysRange}Days_Attendance.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded filtered department attendance (${rows.length} records).`);
  }
  const visibleDepartments = depts.filter((department) => {
    if (allReportDeptId && department.id !== allReportDeptId) return false;
    if (filterCompanyId !== "all") {
      const matchComp =
        department.companyId === filterCompanyId ||
        (!department.companyId &&
          (filterCompanyId === COMPANY_ID ||
            companies.find((c) => c.id === filterCompanyId)?.isMain));
      if (!matchComp) return false;
    }
    return true;
  });
  const selectedDepartmentName = allReportDeptId
    ? depts.find((department) => department.id === allReportDeptId)?.name || "Selected department"
    : "All departments";

  return (
    <div className="max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-primary">Departments & Team Cards</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Filter departments by company, choose date ranges, and download attendance reports.
        </p>
      </div>

      <section className="rounded-xl border bg-card p-4 shadow-lift">
        <div className="grid gap-4 md:grid-cols-3 md:items-end">
          <label className="block text-xs font-bold text-muted-foreground">
            Company Filter
            <select
              value={filterCompanyId}
              onChange={(event) => setFilterCompanyId(event.target.value)}
              className="mt-1 block w-full cursor-pointer rounded-lg border bg-background px-3 py-2.5 text-sm font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="all">All companies ({companies.length})</option>
              {companies.map((c) => (
                <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                  {c.name} {c.isMain ? "(Main)" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-xs font-bold text-muted-foreground">
            Department to export
            <select
              data-testid="department-report-filter"
              value={allReportDeptId}
              onChange={(event) => setAllReportDeptId(event.target.value)}
              className="mt-1 block w-full cursor-pointer rounded-lg border bg-background px-3 py-2.5 text-sm font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">All departments</option>
              {depts.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-2">
            <label className="block text-xs font-bold text-muted-foreground flex-1">
              Attendance period
              <select
                value={allReportDays}
                onChange={(event) => setAllReportDays(Number(event.target.value))}
                className="mt-1 block w-full cursor-pointer rounded-lg border bg-background px-3 py-2.5 text-sm font-semibold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option value={7}>Past 7 days</option>
                <option value={30}>Past 30 days</option>
                <option value={90}>Past 90 days</option>
              </select>
            </label>

            <button
              type="button"
              onClick={() => downloadAllDepartmentsCsv(allReportDays, allReportDeptId)}
              className="btn-lift inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-emerald-700 shrink-0 mt-5"
            >
              <Download className="h-4 w-4" /> CSV
            </button>
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-secondary/50 px-3 py-2 text-xs text-muted-foreground">
          Showing <span className="font-bold text-foreground">{selectedDepartmentName}</span> ·{" "}
          {visibleDepartments.length} department{visibleDepartments.length === 1 ? "" : "s"}{" "}
          selected
        </div>
      </section>

      <form
        onSubmit={add}
        className="grid gap-2 bg-card p-4 rounded-xl border shadow-lift sm:grid-cols-[1fr_180px_180px_auto]"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New department name (e.g. IT, Engineering, Sales)"
          className="flex-1 rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 font-medium"
        />

        <select
          value={deptCompanyId}
          onChange={(e) => setDeptCompanyId(e.target.value)}
          className="rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20 font-semibold"
          aria-label="Department company"
        >
          {companies.map((c) => (
            <option key={c.id || c.name} value={c.id || COMPANY_ID}>
              {c.name} {c.isMain ? "(Main)" : ""}
            </option>
          ))}
          {companies.length === 0 && <option value={COMPANY_ID}>Main Company</option>}
        </select>

        <select
          value={departmentState}
          onChange={(event) => setDepartmentState(event.target.value)}
          className="rounded-md border px-3 py-2 text-sm bg-background outline-none focus:ring-2 focus:ring-primary/20"
          aria-label="Department default state"
        >
          {getStateOptions().map((state) => (
            <option key={state} value={state}>
              {state === "N/A" ? "N/A — no default state" : state}
            </option>
          ))}
        </select>
        <button
          disabled={saving}
          className="btn-lift rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-bold"
        >
          {saving ? "Saving…" : "+ Add Department"}
        </button>
      </form>

      <div className="space-y-4">
        {visibleDepartments.length === 0 && (
          <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground font-medium">
            No departments found. Create one above!
          </div>
        )}

        {visibleDepartments.map((d) => {
          const deptEmployees = employees.filter(
            (e) => e.deptId === d.id && e.status === "active" && e.inviteStatus === "accepted",
          );
          const isExpanded = expandedDeptId === d.id || visibleDepartments.length <= 2;
          const selectedDays = reportDaysMap[d.id] || 30; // Default to 30 days (1 month)

          const comp = companies.find(
            (c) => c.id === d.companyId || (!d.companyId && (c.id === COMPANY_ID || c.isMain)),
          );
          return (
            <div key={d.id} className="rounded-xl border bg-card overflow-hidden transition-colors">
              {/* Department Card Top Header */}
              <div className="p-4 bg-secondary/30 flex flex-col md:flex-row md:items-center justify-between gap-4 border-b">
                <div className="flex-1 flex items-center gap-3 flex-wrap">
                  {/* Company assignment */}
                  <div className="flex items-center rounded-md border bg-background px-2 py-1 shrink-0">
                    <select
                      value={d.companyId || COMPANY_ID}
                      onChange={(e) => updateDepartmentCompany(d.id, e.target.value)}
                      className="max-w-[160px] cursor-pointer truncate bg-transparent text-xs font-medium text-foreground outline-none"
                      title="Change assigned company"
                    >
                      {companies.map((c) => (
                        <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                          {c.name} {c.isMain ? "(Main)" : ""}
                        </option>
                      ))}
                      {companies.length === 0 && <option value={COMPANY_ID}>Main Company</option>}
                    </select>
                  </div>

                  <input
                    defaultValue={d.name}
                    onBlur={(e) => rename(d.id, e.target.value)}
                    className="rounded border-b border-transparent bg-transparent px-2 py-1 text-lg font-semibold text-foreground outline-none transition-colors hover:border-border focus:border-primary focus:bg-background"
                  />
                  <select
                    value={normalizeState(d.state)}
                    onChange={(event) => updateDepartmentState(d.id, event.target.value)}
                    className="rounded-md border bg-background px-2 py-1 text-xs font-semibold"
                    aria-label={`${d.name} default state`}
                  >
                    {getStateOptions().map((state) => (
                      <option key={state} value={state}>
                        {state === "N/A" ? "State: N/A" : `State: ${state}`}
                      </option>
                    ))}
                  </select>
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-primary/10 text-primary border border-primary/20 shrink-0">
                    <Users className="h-3.5 w-3.5" />
                    {deptEmployees.length} {deptEmployees.length === 1 ? "User" : "Users"}
                  </span>
                </div>

                {/* Report Export Toolbar per Department Card */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 bg-background border rounded-lg p-1 text-xs font-semibold">
                    <Calendar className="h-3.5 w-3.5 text-muted-foreground ml-1" />
                    <button
                      onClick={() => setReportDaysMap((prev) => ({ ...prev, [d.id]: 7 }))}
                      className={`px-2 py-1 rounded ${selectedDays === 7 ? "bg-primary text-primary-foreground font-bold" : "text-muted-foreground hover:bg-secondary"}`}
                    >
                      7 Days
                    </button>
                    <button
                      onClick={() => setReportDaysMap((prev) => ({ ...prev, [d.id]: 30 }))}
                      className={`px-2 py-1 rounded ${selectedDays === 30 ? "bg-primary text-primary-foreground font-bold" : "text-muted-foreground hover:bg-secondary"}`}
                    >
                      30 Days (1 Mo)
                    </button>
                  </div>

                  <button
                    onClick={() => downloadDeptReport(d, selectedDays, "csv")}
                    className="btn-lift rounded-md bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 shadow-sm"
                    title={`Export ${d.name} ${selectedDays}-day CSV Report`}
                  >
                    <Download className="h-3.5 w-3.5" /> CSV
                  </button>

                  <button
                    onClick={() => downloadDeptReport(d, selectedDays, "pdf")}
                    className="btn-lift rounded-md bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1.5 text-xs font-bold flex items-center gap-1.5 shadow-sm"
                    title={`Export ${d.name} ${selectedDays}-day PDF Report`}
                  >
                    <FileText className="h-3.5 w-3.5" /> PDF
                  </button>

                  <button
                    onClick={() => setExpandedDeptId(isExpanded ? null : d.id)}
                    className="btn-lift rounded-md border px-2.5 py-1.5 text-xs font-semibold flex items-center gap-1 hover:bg-accent"
                  >
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>

                  <button
                    onClick={() => remove(d.id)}
                    className="btn-lift rounded-md border p-1.5 hover:bg-destructive/10 hover:border-destructive/30 transition-colors"
                    title="Delete Department"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </button>
                </div>
              </div>

              {/* Assigned Users / Employees inside Department Card */}
              {isExpanded && (
                <div className="p-5 space-y-4 bg-card">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase font-extrabold tracking-wider text-muted-foreground">
                      Assigned Team Members & Shift Profiles ({deptEmployees.length})
                    </span>
                  </div>

                  {deptEmployees.length === 0 ? (
                    <div className="p-6 text-center text-xs text-muted-foreground rounded-xl border border-dashed font-medium">
                      No users assigned to {d.name} yet. Assign users from the{" "}
                      <Link to="/admin/employees" className="text-primary underline font-bold">
                        Employees page
                      </Link>
                      .
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {deptEmployees.map((e) => {
                        const countryInfo =
                          COUNTRY_TIMEZONES[e.country ?? "NP"] || COUNTRY_TIMEZONES.NP;

                        return (
                          <div
                            key={e.id}
                            className="rounded-xl border bg-secondary/20 p-4 space-y-3 text-xs shadow-sm hover:border-primary/30 transition-all"
                          >
                            <div className="flex items-center justify-between">
                              <div>
                                <Link
                                  to="/admin/employees/$id"
                                  params={{ id: e.id }}
                                  className="font-bold text-sm text-primary hover:underline block"
                                >
                                  {e.name}
                                </Link>
                                <span className="text-muted-foreground font-medium">
                                  {e.jobTitle || "Member"}
                                </span>
                              </div>
                            </div>

                            {(() => {
                              const summary = formatEmployeeShiftSummary(e);
                              return (
                                <div className="pt-2 border-t space-y-1 text-muted-foreground">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-1.5 font-semibold text-foreground">
                                      <span>{countryInfo.flag}</span>
                                      <span>{countryInfo.name}</span>
                                      <span>· {normalizeState(e.state)}</span>
                                    </div>
                                    <div className="flex items-center gap-1 font-mono font-bold text-primary">
                                      <Clock className="h-3.5 w-3.5 shrink-0" />
                                      <span>{summary.shiftLabel}</span>
                                    </div>
                                  </div>
                                  {summary.isCrossTimezone && (
                                    <div className="text-[11px] font-extrabold text-amber-600 dark:text-amber-400 text-right">
                                      ➔ {summary.localLabel}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            <div className="pt-1 flex items-center justify-between border-t text-[11px]">
                              <span className="text-muted-foreground font-mono">{e.email}</span>
                              <Link
                                to="/admin/employees/$id"
                                params={{ id: e.id }}
                                className="font-bold text-primary hover:underline flex items-center gap-0.5"
                              >
                                Individual Report ↗
                              </Link>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
