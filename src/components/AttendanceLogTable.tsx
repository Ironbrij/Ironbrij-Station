import { Link } from "@tanstack/react-router";
import type { AttendanceLogRow, AttendanceLogStatus } from "@/lib/dashboard-attendance";
import { formatInTimezone } from "@/lib/attendance";

export const attendanceStatusLabels: Record<AttendanceLogStatus, string> = {
  working: "Working",
  break: "On break",
  completed: "Completed",
  missing: "Not punched in",
  upcoming: "Shift upcoming",
  leave: "On leave",
  off: "Day off / holiday",
  review: "Check punch-out",
};
const statusColors: Record<AttendanceLogStatus, string> = {
  working: "text-emerald-700",
  break: "text-amber-700",
  completed: "text-slate-500",
  missing: "text-rose-700",
  upcoming: "text-slate-500",
  leave: "text-blue-700",
  off: "text-slate-500",
  review: "text-amber-700",
};
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
        <thead className="border-y bg-slate-50 text-xs font-medium text-slate-500">
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
            <tr key={row.id} className="bg-background transition-colors hover:bg-slate-50/70">
              <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-muted-foreground">
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
                <div
                  className={`mt-1 flex items-center gap-1.5 text-[11px] ${ready ? statusColors[row.status] : "text-slate-500"}`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                  {ready ? attendanceStatusLabels[row.status] : "Syncing"}
                </div>
              </td>
              <td className="max-w-48 px-4 py-3 text-muted-foreground">
                <span className="block truncate" title={row.companyName}>
                  {row.companyName}
                </span>
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                {row.state || "—"}
              </td>
              <td className="whitespace-nowrap px-4 py-3 tabular-nums">
                <div>
                  {time(row.scheduleStart, row.timezone)}–{time(row.scheduleEnd, row.timezone)}
                </div>
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
                  <span className="mt-1 block text-[10px] text-emerald-700">Open shift</span>
                )}
              </td>
              <td className="px-4 py-3 text-right tabular-nums font-medium">
                {ready && row.hours !== null ? row.hours.toFixed(2) : "—"}
              </td>
              <td
                className={`whitespace-nowrap px-4 py-3 text-right tabular-nums ${ready && row.lateMinutes > 0 ? "font-semibold text-rose-600" : "text-muted-foreground"}`}
              >
                {!ready || !row.timeIn ? "—" : row.excused ? "Excused" : `${row.lateMinutes}m`}
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
