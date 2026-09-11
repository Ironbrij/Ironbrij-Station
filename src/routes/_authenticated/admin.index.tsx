import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { Search, ChevronLeft, ChevronRight, SlidersHorizontal, X } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useAppRuntime } from "@/lib/app-runtime";
import { attendanceNow } from "@/lib/attendance-clock";
import { db } from "@/lib/firebase";
import { zonedDateKey } from "@/lib/attendance";
import { buildAttendanceLog, type AttendanceLogStatus } from "@/lib/dashboard-attendance";
import { AttendanceLogTable, attendanceStatusLabels } from "@/components/AttendanceLogTable";
import type { Employee, LeaveRequest, Punch } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({
    meta: [
      { title: "Attendance - SavyTimes Admin" },
      {
        name: "description",
        content: "A simple live attendance log with punch times, hours, and late arrivals.",
      },
    ],
  }),
  component: AdminHome,
});

function AdminHome() {
  const { companies, company, activeCompanyId } = useAuth();
  const runtime = useAppRuntime();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [synced, setSynced] = useState({ employees: false, punches: false, leaves: false });
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => attendanceNow());
  const [date, setDate] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<AttendanceLogStatus | "all">("all");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const today = zonedDateKey(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const ready = runtime.ready && synced.employees && synced.punches && synced.leaves;

  useEffect(() => {
    const tick = () => {
      if (!document.hidden) setNow(attendanceNow());
    };
    tick();
    const timer = window.setInterval(tick, 30000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [runtime.ready]);

  useEffect(() => {
    const failed = (kind: keyof typeof synced) => {
      setSynced((previous) => ({ ...previous, [kind]: false }));
      setError("Attendance could not reconnect. Refresh this page to try again.");
    };
    const unsubEmployees = onSnapshot(
      collection(db(), "employees"),
      { includeMetadataChanges: true },
      (snapshot) => {
        setEmployees(snapshot.docs.map((item) => ({ ...item.data(), id: item.id }) as Employee));
        setSynced((previous) => ({
          ...previous,
          employees: !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites,
        }));
      },
      () => failed("employees"),
    );
    const unsubPunches = onSnapshot(
      collection(db(), "punches"),
      { includeMetadataChanges: true },
      (snapshot) => {
        setNow(attendanceNow());
        setPunches(
          snapshot.docs.map(
            (item) => ({ ...item.data({ serverTimestamps: "estimate" }), id: item.id }) as Punch,
          ),
        );
        setSynced((previous) => ({
          ...previous,
          punches: !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites,
        }));
      },
      () => failed("punches"),
    );
    const unsubLeaves = onSnapshot(
      query(collection(db(), "leaveRequests"), where("status", "==", "approved")),
      { includeMetadataChanges: true },
      (snapshot) => {
        setLeaves(snapshot.docs.map((item) => ({ ...item.data(), id: item.id }) as LeaveRequest));
        setSynced((previous) => ({
          ...previous,
          leaves: !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites,
        }));
      },
      () => failed("leaves"),
    );
    return () => {
      unsubEmployees();
      unsubPunches();
      unsubLeaves();
    };
  }, []);

  const rows = useMemo(
    () =>
      buildAttendanceLog({
        employees,
        punches,
        companies,
        leaves,
        now,
        date,
        companyId: activeCompanyId,
      }),
    [employees, punches, companies, leaves, now, date, activeCompanyId],
  );
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (status === "all" || row.status === status) &&
        (!term ||
          `${row.employeeName} ${row.companyName} ${row.state}`.toLowerCase().includes(term)),
    );
  }, [rows, search, status]);
  const working = new Set(
    rows
      .filter((row) => row.status === "working" || row.status === "break")
      .map((row) => row.employeeId),
  ).size;
  const needsAttention = rows.filter(
    (row) => row.status === "missing" || row.status === "review",
  ).length;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(visible.length / pageSize) - 1));
  useEffect(() => {
    setPage(0);
  }, [search, status, date, activeCompanyId]);
  function changeDate(offset: number) {
    const next = new Date(`${date || today}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + offset);
    const key = next.toISOString().slice(0, 10);
    setDate(key === today ? "" : key);
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Attendance</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            See who is working and check their hours in one place.
          </p>
        </div>
        <Link
          to="/admin/reports"
          className="rounded-lg border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          View reports
        </Link>
      </header>

      <section
        className="overflow-hidden rounded-xl border bg-background shadow-sm"
        aria-labelledby="attendance-log-title"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <h2 id="attendance-log-title" className="font-semibold">
              {date ? "Attendance log" : "Today's attendance"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {activeCompanyId === "all" ? "All companies" : company?.name || "Company"}{" "}
              <span aria-hidden="true">·</span>{" "}
              {ready ? `${rows.length} entries` : "Connecting to attendance..."}
              {ready && !date && (
                <>
                  {" "}
                  <span aria-hidden="true">·</span>{" "}
                  <span className="font-medium text-emerald-700">{working} working now</span>
                </>
              )}
            </p>
          </div>
          <div
            className={`flex items-center gap-1.5 text-xs ${ready ? "text-emerald-700" : "text-amber-700"}`}
            role="status"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {ready ? "Live updates" : "Syncing"}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
          <div className="relative min-w-52 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              aria-label="Search employees or clients"
              placeholder="Search employee or client"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full rounded-lg border bg-background pl-9 pr-9 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
            {search && (
              <button
                aria-label="Clear search"
                onClick={() => setSearch("")}
                className="absolute right-2 top-2 rounded p-0.5 hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="flex h-9 items-center rounded-lg border bg-background">
            <button
              aria-label="Previous day"
              onClick={() => changeDate(-1)}
              className="h-full px-2 hover:bg-muted"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <input
              aria-label="Attendance date"
              type="date"
              value={date || today}
              max={today}
              onChange={(event) => setDate(event.target.value === today ? "" : event.target.value)}
              className="min-w-0 bg-transparent px-1 text-xs outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              aria-label="Next day"
              disabled={!date || date >= today}
              onClick={() => changeDate(1)}
              className="h-full px-2 hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          {date && (
            <button
              onClick={() => setDate("")}
              className="text-xs font-medium text-primary hover:underline"
            >
              Today
            </button>
          )}
          <button
            onClick={() => setShowFilters(!showFilters)}
            aria-expanded={showFilters}
            aria-controls="attendance-filters"
            className={`ml-auto flex h-9 items-center gap-2 rounded-lg px-3 text-xs hover:bg-muted ${status !== "all" ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
          >
            <SlidersHorizontal className="h-4 w-4" />
            {status === "all" ? "Filter" : attendanceStatusLabels[status]}
          </button>
        </div>
        {showFilters && (
          <div
            id="attendance-filters"
            className="flex flex-wrap items-center gap-3 border-t bg-muted/20 px-5 py-3 text-xs"
          >
            <label htmlFor="attendance-status">Status</label>
            <select
              id="attendance-status"
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
              className="rounded-md border bg-background px-3 py-2"
            >
              <option value="all">Everyone</option>
              {Object.entries(attendanceStatusLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            {status !== "all" && (
              <button onClick={() => setStatus("all")} className="text-primary hover:underline">
                Clear filter
              </button>
            )}
          </div>
        )}
        {!ready && (
          <div role="status" className="border-t bg-amber-50 px-5 py-3 text-xs text-amber-900">
            {error ||
              runtime.message ||
              "Syncing attendance. Live status and totals will appear when connected."}
          </div>
        )}
        <p className="border-t px-5 py-2 text-[11px] text-muted-foreground md:hidden">
          Swipe the table sideways for punch times and hours.
        </p>
        <AttendanceLogTable
          rows={visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize)}
          ready={ready}
          emptyMessage={
            !ready
              ? "Loading attendance..."
              : search || status !== "all"
                ? "No matching employees. Clear the search or filter to see everyone."
                : "No attendance or assigned employees for this date and company."
          }
        />
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-xs text-muted-foreground">
          <span>
            {visible.length
              ? `${currentPage * pageSize + 1}-${Math.min((currentPage + 1) * pageSize, visible.length)} of ${visible.length} entries`
              : "0 entries"}
          </span>
          <span>Times follow the schedule timezone. Hours exclude breaks.</span>
          {visible.length > pageSize && (
            <div className="flex gap-3">
              <button
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
                className="font-medium text-primary disabled:text-muted-foreground disabled:opacity-40"
              >
                Previous
              </button>
              <button
                disabled={(currentPage + 1) * pageSize >= visible.length}
                onClick={() => setPage(currentPage + 1)}
                className="font-medium text-primary disabled:text-muted-foreground disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </footer>
      </section>
      {ready && needsAttention > 0 && (
        <p className="text-xs text-muted-foreground">
          {needsAttention} {needsAttention === 1 ? "entry needs" : "entries need"} an attendance
          check.{" "}
          <Link to="/admin/late" className="font-medium text-primary hover:underline">
            Review late or missing punches
          </Link>
        </p>
      )}
    </div>
  );
}
