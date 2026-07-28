import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, deleteDoc, doc, onSnapshot } from "firebase/firestore";
import { AlertTriangle, CalendarClock, Megaphone, Trash2, UserX } from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import type { CompanyNotice, Department, Employee, LeaveRequest, Punch } from "@/lib/types";
import {
  formatInTimezone,
  getActiveEmployeeLeave,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  zonedDateKey,
} from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import { normalizeState, STATE_NOT_APPLICABLE } from "@/lib/states";
import { getNoticeDeliveryTime } from "@/lib/notices";

export const Route = createFileRoute("/_authenticated/admin/notices")({
  head: () => ({ meta: [{ title: "Notifications — Time Station Admin" }] }),
  component: NotificationsPage,
});

function NotificationsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [notices, setNotices] = useState<CompanyNotice[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<CompanyNotice["priority"]>("info");
  const [targetType, setTargetType] = useState<CompanyNotice["targetType"]>("all");
  const [targetId, setTargetId] = useState("");
  const [selectedStateCodes, setSelectedStateCodes] = useState<string[]>([]);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);
  const [deliveryMode, setDeliveryMode] = useState<"instant" | "scheduled">("instant");
  const [scheduledAt, setScheduledAt] = useState("");
  const [busy, setBusy] = useState(false);
  const { company, user } = useAuth();

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
      onSnapshot(collection(db(), "notices"), (snapshot) =>
        setNotices(
          snapshot.docs
            .map((item) => ({ id: item.id, ...(item.data() as Omit<CompanyNotice, "id">) }))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        ),
      ),
    ];
    return () => {
      window.clearInterval(timer);
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const alerts = useMemo(
    () =>
      employees
        .filter((employee) => employee.status === "active" && employee.inviteStatus === "accepted")
        .filter((employee) => !getActiveEmployeeLeave(employee, leaves, now))
        .filter(
          (employee) =>
            !getEmployeeHoliday(
              company,
              employee,
              zonedDateKey(now, getEmployeeTimezone(employee)),
            ),
        )
        .map((employee) => {
          const ids = new Set([employee.id, employee.authUid].filter(Boolean));
          const list = punches.filter((punch) => ids.has(punch.employeeId));
          return {
            employee,
            status: getLiveAttendanceStatus(
              employee,
              list,
              now,
              company?.lateGraceMinutes ?? 1,
              company?.workingDays,
              getEmployeeHolidayDates(company, employee),
            ),
          };
        })
        .filter((item) => item.status.isLate)
        .sort((a, b) => b.status.minutesLate - a.status.minutesLate),
    [employees, punches, leaves, now, company],
  );

  const availableStates = useMemo(
    () =>
      [...new Set(employees.map((employee) => normalizeState(employee.state)))]
        .filter((state) => state !== STATE_NOT_APPLICABLE)
        .sort(),
    [employees],
  );

  function recipientLabel(notice: CompanyNotice) {
    if (!notice.targetType || notice.targetType === "all") return "Everyone";
    if (notice.targetType === "dept") {
      const departmentIds = notice.targetDeptIds?.length
        ? notice.targetDeptIds
        : notice.targetDeptId
          ? [notice.targetDeptId]
          : [];
      const names = departments
        .filter((item) => departmentIds.includes(item.id))
        .map((item) => item.name);
      return names.length
        ? `${names.join(", ")} department${names.length === 1 ? "" : "s"}`
        : "Selected department";
    }
    if (notice.targetType === "states") {
      return notice.targetStateCodes?.length
        ? notice.targetStateCodes.join(", ")
        : "Selected states";
    }
    const recipientIds = notice.targetEmployeeIds?.length
      ? notice.targetEmployeeIds
      : notice.targetEmployeeId
        ? [notice.targetEmployeeId]
        : [];
    const names = recipientIds
      .map((id) => employees.find((item) => item.id === id || item.authUid === id)?.name)
      .filter((name): name is string => Boolean(name));
    return names.length ? names.join(", ") : "Selected employees";
  }
  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !message.trim()) return;
    if (targetType === "dept" && !targetId) {
      toast.error("Select a department.");
      return;
    }
    if (targetType === "states" && selectedStateCodes.length === 0) {
      toast.error("Select at least one state.");
      return;
    }
    if (targetType === "employee" && selectedEmployeeIds.length === 0) {
      toast.error("Select at least one employee.");
      return;
    }
    if (deliveryMode === "scheduled" && !scheduledAt) {
      toast.error("Choose the notification date and time.");
      return;
    }
    const publishAt =
      deliveryMode === "scheduled" ? new Date(scheduledAt).toISOString() : new Date().toISOString();
    if (deliveryMode === "scheduled" && new Date(publishAt).getTime() <= Date.now()) {
      toast.error("Scheduled notification time must be in the future.");
      return;
    }
    setBusy(true);
    try {
      await addDoc(collection(db(), "notices"), {
        title: title.trim(),
        message: message.trim(),
        priority,
        targetType,
        ...(targetType === "dept" ? { targetDeptId: targetId } : {}),
        ...(targetType === "states" ? { targetStateCodes: selectedStateCodes } : {}),
        ...(targetType === "employee"
          ? {
              targetEmployeeIds: selectedEmployeeIds,
              ...(selectedEmployeeIds.length === 1
                ? { targetEmployeeId: selectedEmployeeIds[0] }
                : {}),
            }
          : {}),
        createdAt: new Date().toISOString(),
        publishAt,
        authorName: user?.displayName || user?.email || "Admin",
      });
      setTitle("");
      setMessage("");
      setTargetId("");
      setSelectedStateCodes([]);
      setSelectedEmployeeIds([]);
      setDeliveryMode("instant");
      setScheduledAt("");
      toast.success(
        deliveryMode === "scheduled"
          ? `Notification scheduled for ${new Date(publishAt).toLocaleString()}`
          : targetType === "employee"
            ? `Notification sent to ${selectedEmployeeIds.length} employees`
            : "Notification published",
      );
    } catch (error) {
      toast.error("Could not publish: " + (error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-primary flex items-center gap-2">Notifications</h1>
        <p className="text-sm text-muted-foreground">
          Live attendance warnings and company announcements.
        </p>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-primary flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" /> Live late alerts
          </h2>
          <Link to="/admin/late" className="text-xs font-bold text-primary hover:underline">
            Open full late log
          </Link>
        </div>
        {alerts.length === 0 ? (
          <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
            No employee is currently late.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {alerts.map(({ employee, status }) => (
              <Link
                key={employee.id}
                to="/admin/employees/$id"
                params={{ id: employee.id }}
                className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4 hover:bg-rose-500/10"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-bold text-primary">{employee.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {departments.find((item) => item.id === employee.deptId)?.name ||
                        "No department"}
                    </div>
                  </div>
                  {status.isMissingLate ? (
                    <UserX className="h-5 w-5 text-rose-600" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-amber-600" />
                  )}
                </div>
                <div className="mt-3 text-sm font-bold text-rose-600">
                  {status.isMissingLate ? "Not punched in" : "Arrived late"} · {status.minutesLate}{" "}
                  min
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Shift started{" "}
                  {formatInTimezone(status.shift.start, getEmployeeTimezone(employee))} local time
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="grid lg:grid-cols-5 gap-6 items-start">
        <form
          onSubmit={publish}
          className="lg:col-span-2 rounded-xl border bg-card p-5 shadow-lift space-y-3"
        >
          <h2 className="font-bold text-primary flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Publish announcement
          </h2>
          <label className="block text-xs font-bold text-muted-foreground">
            Title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <label className="block text-xs font-bold text-muted-foreground">
            Message
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-bold text-muted-foreground">
              Priority
              <select
                value={priority}
                onChange={(event) => setPriority(event.target.value as CompanyNotice["priority"])}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="info">Information</option>
                <option value="warning">Warning</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="text-xs font-bold text-muted-foreground">
              Audience
              <select
                value={targetType}
                onChange={(event) => {
                  setTargetType(event.target.value as CompanyNotice["targetType"]);
                  setTargetId("");
                  setSelectedStateCodes([]);
                  setSelectedEmployeeIds([]);
                }}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="all">Everyone</option>
                <option value="dept">Department</option>
                <option value="states">One or more states</option>
                <option value="employee">Specific employees</option>
              </select>
            </label>
          </div>
          <fieldset className="space-y-2 rounded-lg border p-3">
            <legend className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5" /> Delivery time
            </legend>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDeliveryMode("instant")}
                className={`rounded-md border px-3 py-2 text-xs font-bold ${
                  deliveryMode === "instant" ? "border-primary bg-primary/10 text-primary" : ""
                }`}
              >
                Send instantly
              </button>
              <button
                type="button"
                onClick={() => setDeliveryMode("scheduled")}
                className={`rounded-md border px-3 py-2 text-xs font-bold ${
                  deliveryMode === "scheduled" ? "border-primary bg-primary/10 text-primary" : ""
                }`}
              >
                Schedule
              </button>
            </div>
            {deliveryMode === "scheduled" && (
              <label className="block text-xs font-bold text-muted-foreground">
                Calendar and clock
                <input
                  required
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
                />
                <span className="mt-1 block font-normal">Uses your current device timezone.</span>
              </label>
            )}
          </fieldset>
          {targetType === "dept" && (
            <label className="block text-xs font-bold text-muted-foreground">
              Department
              <select
                required
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground"
              >
                <option value="">Select department…</option>
                {departments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {targetType === "states" && (
            <fieldset className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <legend className="text-xs font-bold text-muted-foreground">
                  States ({selectedStateCodes.length} selected)
                </legend>
                <div className="flex gap-2 text-[11px] font-bold">
                  <button
                    type="button"
                    onClick={() => setSelectedStateCodes(availableStates)}
                    className="text-primary hover:underline"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedStateCodes([])}
                    className="text-muted-foreground hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="grid gap-1 sm:grid-cols-2">
                {availableStates.map((state) => (
                  <label
                    key={state}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                  >
                    <input
                      type="checkbox"
                      checked={selectedStateCodes.includes(state)}
                      onChange={(event) =>
                        setSelectedStateCodes((current) =>
                          event.target.checked
                            ? [...current, state]
                            : current.filter((item) => item !== state),
                        )
                      }
                    />
                    <span className="font-semibold">{state}</span>
                  </label>
                ))}
                {availableStates.length === 0 && (
                  <span className="text-xs italic text-muted-foreground">
                    No employee states have been assigned yet.
                  </span>
                )}
              </div>
            </fieldset>
          )}
          {targetType === "employee" && (
            <fieldset className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <legend className="text-xs font-bold text-muted-foreground">
                  Employees ({selectedEmployeeIds.length} selected)
                </legend>
                <div className="flex gap-2 text-[11px] font-bold">
                  <button
                    type="button"
                    onClick={() => setSelectedEmployeeIds(employees.map((item) => item.id))}
                    className="text-primary hover:underline"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedEmployeeIds([])}
                    className="text-muted-foreground hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                {[...departments, { id: "", name: "No department", companyId: "" }].map(
                  (department) => {
                    const departmentEmployees = employees.filter((item) =>
                      department.id ? item.deptId === department.id : !item.deptId,
                    );
                    if (departmentEmployees.length === 0) return null;
                    return (
                      <div key={department.id || "unassigned"} className="space-y-1">
                        <div className="text-[10px] font-extrabold uppercase tracking-wide text-muted-foreground">
                          {department.name}
                        </div>
                        {departmentEmployees.map((item) => (
                          <label
                            key={item.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60"
                          >
                            <input
                              type="checkbox"
                              checked={selectedEmployeeIds.includes(item.id)}
                              onChange={(event) =>
                                setSelectedEmployeeIds((current) =>
                                  event.target.checked
                                    ? [...current, item.id]
                                    : current.filter((id) => id !== item.id),
                                )
                              }
                            />
                            <span className="font-semibold text-foreground">{item.name}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {item.email}
                            </span>
                          </label>
                        ))}
                      </div>
                    );
                  },
                )}
              </div>
            </fieldset>
          )}{" "}
          <button
            disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-bold text-primary-foreground"
          >
            {busy ? "Publishing…" : "Publish notification"}
          </button>
        </form>

        <div className="lg:col-span-3 space-y-3">
          <h2 className="font-bold text-primary">Announcement history</h2>
          {notices.map((notice) => (
            <div key={notice.id} className="rounded-xl border bg-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-bold text-primary">{notice.title}</div>
                  <div className="mt-1 text-sm text-muted-foreground whitespace-pre-wrap">
                    {notice.message}
                  </div>
                  <div className="mt-2 text-[10px] uppercase font-bold text-muted-foreground">
                    {notice.priority} · Sent to: {recipientLabel(notice)} ·{" "}
                    {notice.publishAt && getNoticeDeliveryTime(notice).getTime() > now.getTime()
                      ? `Scheduled for ${getNoticeDeliveryTime(notice).toLocaleString()}`
                      : `Sent ${getNoticeDeliveryTime(notice).toLocaleString()}`}
                  </div>
                </div>
                <button
                  onClick={() =>
                    deleteDoc(doc(db(), "notices", notice.id)).then(() =>
                      toast.success("Notification deleted"),
                    )
                  }
                  className="rounded-md border p-2 text-rose-600"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
          {notices.length === 0 && (
            <div className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
              No announcements published yet.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
