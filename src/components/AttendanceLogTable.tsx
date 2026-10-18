import { Link } from "@tanstack/react-router";
import {
  LogIn,
  LogOut,
  Coffee,
  CalendarDays,
  Clock3,
  Moon,
  CircleX,
  TriangleAlert,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import type { AttendanceLogRow, AttendanceLogStatus } from "@/lib/dashboard-attendance";
import { formatInTimezone } from "@/lib/attendance";

export const attendanceStatusLabels: Record<AttendanceLogStatus, string> = {
  working: "Clocked in",
  break: "On break",
  completed: "Clocked out",
  missing: "Not punched in",
  upcoming: "Not started",
  leave: "On leave",
  off: "Day off / holiday",
  review: "Check punch-out",
};
const statusAppearance: Record<AttendanceLogStatus, { classes: string; icon: LucideIcon }> = {
  working: { classes: "border-emerald-700 bg-emerald-700 dark:bg-emerald-700 text-white", icon: LogIn },
  break: { classes: "border-amber-300 dark:border-amber-800 bg-amber-100 dark:bg-amber-950/40 text-amber-950 dark:text-amber-300", icon: Coffee },
  completed: { classes: "border-slate-300 dark:border-border bg-slate-200 dark:bg-muted text-slate-800 dark:text-slate-300", icon: LogOut },
  missing: { classes: "border-rose-300 dark:border-rose-800 bg-rose-100 dark:bg-rose-950/40 text-rose-900 dark:text-rose-300", icon: CircleX },
  upcoming: { classes: "border-sky-200 dark:border-sky-800 bg-sky-50 dark:bg-sky-950/40 text-sky-900 dark:text-sky-300", icon: Clock3 },
  leave: { classes: "border-violet-300 dark:border-violet-800 bg-violet-100 dark:bg-violet-950/40 text-violet-900 dark:text-violet-300", icon: CalendarDays },
  off: { classes: "border-dashed border-slate-300 dark:border-border bg-slate-50 dark:bg-muted text-slate-600 dark:text-slate-300", icon: Moon },
  review: { classes: "border-orange-300 dark:border-orange-800 bg-orange-100 dark:bg-orange-950/40 text-orange-950 dark:text-orange-300", icon: TriangleAlert },
};
function AttendanceStatusBadge({ status, ready }: { status: AttendanceLogStatus; ready: boolean }) {
  const appearance = statusAppearance[status];
  const Icon = ready ? appearance.icon : RefreshCw;
  return (
    <span
      className={`mt-2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${ready ? appearance.classes : "border-slate-200 dark:border-border bg-slate-50 dark:bg-muted text-slate-500 dark:text-slate-300"}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} aria-hidden="true" />
      {ready ? attendanceStatusLabels[status] : "Syncing"}
    </span>
  );
}
function time(value: Date | null, timezone: string) {
  return value
    ? formatInTimezone(value, timezone, { hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";
}
export function AttendanceLogTable({
  rows,
  ready,
  emptyMessage,
}: {
  rows: AttendanceLogRow[];
  ready: boolean;
  emptyMessage: string;
}) {
  return (
    <div
      className="overflow-x-auto"
      tabIndex={0}
      aria-label="Attendance table. Scroll horizontally to see all columns."
    >
      <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
        <caption className="sr-only">
          Attendance by employee and client. Hours exclude breaks. Times use the timezone shown in
          each schedule.
        </caption>
        <thead className="border-y bg-slate-50 dark:bg-muted text-xs font-medium text-slate-500 dark:text-slate-300">
          <tr>
            {[
              "Date",
              "Employee",
              "Client",
              "State / country",
              "Schedule",
              "Time in",
              "Time out",
              "Hours",
              "Late",
              "Overtime",
            ].map((label, i) => (
              <th
                key={label}
                scope="col"
                className={`whitespace-nowrap px-4 py-3 font-medium ${i >= 7 ? "text-right" : ""}`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`transition-colors ${ready && row.status === "working" ? "bg-emerald-50/60 dark:bg-emerald-950/40 hover:bg-emerald-50 dark:hover:bg-emerald-950/40" : "bg-background hover:bg-slate-50/70 dark:hover:bg-muted"}`}
            >
              <td
                className={`whitespace-nowrap border-l-4 px-4 py-3 text-xs tabular-nums text-muted-foreground ${ready && row.status === "working" ? "border-l-emerald-600" : "border-l-transparent"}`}
              >
                {row.date}
              </td>
              <td className="px-4 py-3">
                <Link
                  to="/admin/employees/$id"
                  params={{ id: row.employeeId }}
                  className="whitespace-nowrap font-semibold text-foreground hover:text-primary hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                >
                  {row.employeeName}
                </Link>
                <div>
                  <AttendanceStatusBadge status={row.status} ready={ready} />
                </div>
              </td>
              <td className="max-w-48 px-4 py-3 text-muted-foreground">
                <span className="block truncate font-medium text-foreground" title={row.companyName}>
                  {row.companyName}
                </span>
                {row.parentCompanyName && row.parentCompanyName !== row.companyName && (
                  <span className="mt-0.5 block truncate text-[10px]" title={row.parentCompanyName}>
                    via {row.parentCompanyName}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                {row.state || "—"}
              </td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                <div>
                  {time(row.scheduleStart, row.timezone)}–{time(row.scheduleEnd, row.timezone)}
                </div>
                {row.shiftLabel && (
                  <div className="mt-1 text-[10px] font-semibold text-primary">
                    {row.shiftLabel}
                  </div>
                )}
                <div className="mt-1 text-[10px] text-muted-foreground">
                  {row.timezone.replaceAll("_", " ")}
                </div>
              </td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                {time(row.timeIn, row.timezone)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                {time(row.timeOut, row.timezone)}
                {row.automatic && (
                  <span className="mt-1 block text-[10px] text-muted-foreground">Automatic</span>
                )}
                {ready && (row.status === "working" || row.status === "break") && (
                  <span className="mt-1 block text-[10px] text-emerald-700 dark:text-emerald-300">Open shift</span>
                )}
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium">
                {ready && row.hours !== null ? row.hours.toFixed(2) : "—"}
              </td>
              <td
                className={`whitespace-nowrap px-4 py-3 text-right tabular-nums ${ready && row.lateMinutes > 0 ? "font-semibold text-rose-600 dark:text-rose-300" : "text-muted-foreground"}`}
              >
                {!ready || !row.timeIn ? (
                  "—"
                ) : row.excused ? (
                  <span
                    className="text-emerald-700 dark:text-emerald-300"
                    title={row.excuseReason || "Marked not late by an admin"}
                  >
                    Excused
                  </span>
                ) : (
                  `${row.lateMinutes}m`
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums text-muted-foreground">
                {ready && row.overtime !== null ? `${row.overtime.toFixed(2)}h` : "—"}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={10} className="px-6 py-16 text-center text-muted-foreground">
                {emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
