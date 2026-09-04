import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";
import {
  Building2,
  CalendarClock,
  CheckSquare,
  Filter,
  Megaphone,
  Search,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { db } from "@/lib/firebase";
import type {
  Company,
  CompanyNotice,
  Department,
  Employee,
  LeaveRequest,
  Punch,
} from "@/lib/types";
import { COMPANY_ID } from "@/lib/types";
import { formatInTimezone, getEmployeeTimezone } from "@/lib/attendance";
import { useAuth } from "@/lib/auth-context";
import { normalizeState, STATE_NOT_APPLICABLE } from "@/lib/states";
import { getNoticeDeliveryTime } from "@/lib/notices";
import {
  buildAdminLateAlerts,
  LATE_ALERT_READ_EVENT,
  markLateAlertsRead,
  readLateAlertIds,
} from "@/lib/late-alerts";

export const Route = createFileRoute("/_authenticated/admin/notices")({
  head: () => ({ meta: [{ title: "Notifications — SavyTimes Admin" }] }),
  component: NotificationsPage,
});

const NOTICE_PAGE_SIZE = 10;

function NotificationsPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [notices, setNotices] = useState<CompanyNotice[]>([]);
  const [noticeLimit, setNoticeLimit] = useState(NOTICE_PAGE_SIZE);
  const [hasMoreNotices, setHasMoreNotices] = useState(false);
  const [loadingNotices, setLoadingNotices] = useState(true);
  const [now, setNow] = useState(() => new Date());

  // Global Page Filters
  const { company, user, activeCompanyId } = useAuth();
  const [pageCompanyFilter, setPageCompanyFilter] = useState(activeCompanyId);

  useEffect(() => {
    setPageCompanyFilter(activeCompanyId);
  }, [activeCompanyId]);

  // Form State
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [priority, setPriority] = useState<CompanyNotice["priority"]>("info");
  const [targetType, setTargetType] = useState<CompanyNotice["targetType"]>("all");
  const [targetId, setTargetId] = useState("");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<string[]>([]);
  const [selectedStateCodes, setSelectedStateCodes] = useState<string[]>([]);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);

  // Employee Audience Filter Controls
  const [empSearchQuery, setEmpSearchQuery] = useState("");
  const [empFilterCompanyId, setEmpFilterCompanyId] = useState("all");
  const [empFilterDeptId, setEmpFilterDeptId] = useState("all");

  const [deliveryMode, setDeliveryMode] = useState<"instant" | "scheduled">("instant");
  const [scheduledAt, setScheduledAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [readLateIds, setReadLateIds] = useState<Set<string>>(() => readLateAlertIds());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    const unsubscribers = [
      onSnapshot(collection(db(), "companies"), (snapshot) =>
        setCompanies(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Company, "id">) })),
        ),
      ),
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

  useEffect(() => {
    setLoadingNotices(true);
    const noticesQuery = query(
      collection(db(), "notices"),
      orderBy("createdAt", "desc"),
      limit(noticeLimit + 1),
    );
    return onSnapshot(
      noticesQuery,
      (snapshot) => {
        setHasMoreNotices(snapshot.docs.length > noticeLimit);
        setNotices(
          snapshot.docs.slice(0, noticeLimit).map((item) => ({
            id: item.id,
            ...(item.data() as Omit<CompanyNotice, "id">),
          })),
        );
        setLoadingNotices(false);
      },
      (error) => {
        console.error("Could not load announcement history", error);
        setLoadingNotices(false);
      },
    );
  }, [noticeLimit]);

  useEffect(() => {
    const syncReadIds = () => setReadLateIds(readLateAlertIds());
    syncReadIds();
    window.addEventListener(LATE_ALERT_READ_EVENT, syncReadIds);
    window.addEventListener("storage", syncReadIds);
    return () => {
      window.removeEventListener(LATE_ALERT_READ_EVENT, syncReadIds);
      window.removeEventListener("storage", syncReadIds);
    };
  }, []);

  // Map company helper
  const companyMap = useMemo(() => {
    const map = new Map<string, string>();
    companies.forEach((c) => map.set(c.id || COMPANY_ID, c.name));
    return map;
  }, [companies]);

  // Map department helper
  const deptMap = useMemo(() => {
    const map = new Map<string, string>();
    departments.forEach((d) => map.set(d.id, d.name));
    return map;
  }, [departments]);

  // Late alerts calculation
  const alerts = useMemo(
    () => buildAdminLateAlerts({ employees, punches, leaves, company, now }),
    [employees, punches, leaves, now, company],
  );

  const unreadAlerts = useMemo(
    () => alerts.filter((alert) => !readLateIds.has(alert.id)),
    [alerts, readLateIds],
  );

  // Filtered Late Alerts based on Top Company Filter
  const filteredLateAlerts = useMemo(() => {
    if (pageCompanyFilter === "all") return unreadAlerts;
    return unreadAlerts.filter(({ employee }) => {
      const empCompanyIds = [employee.companyId, ...(employee.companyIds || [])].filter(
        Boolean,
      ) as string[];
      if (empCompanyIds.length === 0) empCompanyIds.push(COMPANY_ID);
      return empCompanyIds.includes(pageCompanyFilter);
    });
  }, [unreadAlerts, pageCompanyFilter]);

  // Filtered Announcements History based on Top Company Filter
  const filteredNotices = useMemo(() => {
    if (pageCompanyFilter === "all") return notices;
    return notices.filter((notice) => {
      if (!notice.targetType || notice.targetType === "all") return true;
      if (notice.targetType === "companies") {
        return notice.targetCompanyIds?.includes(pageCompanyFilter);
      }
      if (notice.targetType === "dept") {
        const dept = departments.find((d) => d.id === notice.targetDeptId);
        const deptCompId = dept?.companyId || COMPANY_ID;
        return deptCompId === pageCompanyFilter;
      }
      if (notice.targetType === "employee") {
        const targetEmpIds =
          notice.targetEmployeeIds || (notice.targetEmployeeId ? [notice.targetEmployeeId] : []);
        return targetEmpIds.some((empId) => {
          const emp = employees.find((e) => e.id === empId || e.authUid === empId);
          if (!emp) return false;
          const empCompIds = [emp.companyId, ...(emp.companyIds || [])].filter(Boolean);
          if (empCompIds.length === 0) empCompIds.push(COMPANY_ID);
          return empCompIds.includes(pageCompanyFilter);
        });
      }
      return true;
    });
  }, [notices, pageCompanyFilter, departments, employees]);

  function markLateAlertRead(id: string) {
    setReadLateIds(markLateAlertsRead([id]));
  }

  function clearLateAlerts() {
    setReadLateIds(markLateAlertsRead(alerts.map((alert) => alert.id)));
    toast.success("Late alerts cleared");
  }

  const availableStates = useMemo(
    () =>
      [...new Set(employees.map((employee) => normalizeState(employee.state)))]
        .filter((state) => state !== STATE_NOT_APPLICABLE)
        .sort(),
    [employees],
  );

  // Filtered employee candidates for specific employee picker
  const filteredEmployeeAudience = useMemo(() => {
    return employees.filter((emp) => {
      if (emp.status !== "active" || emp.inviteStatus !== "accepted") return false;
      // Company filter
      if (empFilterCompanyId !== "all") {
        const empCompIds = [emp.companyId, ...(emp.companyIds || [])].filter(Boolean);
        if (empCompIds.length === 0) empCompIds.push(COMPANY_ID);
        if (!empCompIds.includes(empFilterCompanyId)) return false;
      }
      // Department filter
      if (empFilterDeptId !== "all") {
        if (emp.deptId !== empFilterDeptId) return false;
      }
      // Search query
      if (empSearchQuery.trim()) {
        const q = empSearchQuery.toLowerCase().trim();
        const nameMatch = (emp.name || "").toLowerCase().includes(q);
        const emailMatch = (emp.email || "").toLowerCase().includes(q);
        const jobMatch = (emp.jobTitle || "").toLowerCase().includes(q);
        if (!nameMatch && !emailMatch && !jobMatch) return false;
      }
      return true;
    }).sort((a, b) =>
      (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
    );
  }, [employees, empFilterCompanyId, empFilterDeptId, empSearchQuery]);

  const employeeFilterDepartments = useMemo(() => {
    if (empFilterCompanyId === "all") return departments;
    return departments.filter(
      (department) => (department.companyId || COMPANY_ID) === empFilterCompanyId,
    );
  }, [departments, empFilterCompanyId]);

  function recipientLabel(notice: CompanyNotice) {
    if (!notice.targetType || notice.targetType === "all") return "Everyone";
    if (notice.targetType === "companies") {
      const names = companies
        .filter((c) => notice.targetCompanyIds?.includes(c.id || ""))
        .map((c) => c.name);
      return names.length ? `Companies: ${names.join(", ")}` : "Selected companies";
    }
    if (notice.targetType === "dept") {
      const departmentIds = notice.targetDeptIds?.length
        ? notice.targetDeptIds
        : notice.targetDeptId
          ? [notice.targetDeptId]
          : [];
      const names = departments
        .filter((item) => departmentIds.includes(item.id))
        .map((item) => item.name);
      return names.length ? `Department: ${names.join(", ")}` : "Selected department";
    }
    if (notice.targetType === "states") {
      return notice.targetStateCodes?.length
        ? `States: ${notice.targetStateCodes.join(", ")}`
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
    return names.length
      ? `${names.length} Specific Employee${names.length === 1 ? "" : "s"} (${names.slice(0, 3).join(", ")}${names.length > 3 ? "..." : ""})`
      : "Selected employees";
  }

  async function publish(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !message.trim()) return;
    if (targetType === "companies" && selectedCompanyIds.length === 0) {
      toast.error("Select at least one company.");
      return;
    }
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
        ...(targetType === "companies" ? { targetCompanyIds: selectedCompanyIds } : {}),
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
      setSelectedCompanyIds([]);
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
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Top Header with Global Company Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold text-primary flex items-center gap-2">
            <Megaphone className="h-6 w-6 text-primary" /> Notifications & Announcements
          </h1>
          <p className="text-sm text-muted-foreground">
            Live attendance warnings, targeted announcements, and company notifications.
          </p>
        </div>

        {/* Global Company Filter Dropdown */}
        <div className="flex items-center gap-2 bg-card p-2 rounded-xl border shadow-xs">
          <Building2 className="h-4 w-4 text-primary shrink-0 ml-1" />
          <span className="text-xs font-bold text-muted-foreground shrink-0">Company Filter:</span>
          <select
            value={pageCompanyFilter}
            onChange={(e) => setPageCompanyFilter(e.target.value)}
            className="rounded-lg border bg-background px-3 py-1.5 text-xs font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="all">All Companies</option>
            {companies.map((c) => (
              <option key={c.id || COMPANY_ID} value={c.id || COMPANY_ID}>
                {c.name} {c.isMain ? "(Main)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Late Alerts Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <span>Late alerts</span>
            {pageCompanyFilter !== "all" && (
              <span className="text-xs font-normal text-muted-foreground">
                (Filtered by {companyMap.get(pageCompanyFilter) || "Company"})
              </span>
            )}
          </h2>
          <div className="flex items-center gap-3 text-xs">
            {unreadAlerts.length > 0 && (
              <button
                type="button"
                onClick={clearLateAlerts}
                className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Clear all
              </button>
            )}
            <Link to="/admin/late" className="font-medium text-foreground hover:underline">
              Full late log →
            </Link>
          </div>
        </div>
        {filteredLateAlerts.length === 0 ? (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            No new late alerts {pageCompanyFilter !== "all" ? "for this company" : ""}.
          </div>
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            {filteredLateAlerts.map(({ id, employee, status }) => (
              <Link
                key={id}
                to="/admin/employees/$id"
                params={{ id: employee.id }}
                onClick={() => markLateAlertRead(id)}
                className="flex flex-col gap-2 px-4 py-3 hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="font-medium text-foreground flex items-center gap-2">
                    <span>{employee.name}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground font-semibold">
                      {companyMap.get(employee.companyId || COMPANY_ID) || "Company"}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {deptMap.get(employee.deptId || "") || "No department"}
                  </div>
                </div>
                <div className="text-left sm:text-right">
                  <div className="text-sm font-medium text-foreground">
                    {status.isMissingLate ? "Not punched in" : "Arrived late"} ·{" "}
                    {status.minutesLate} min
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Shift started{" "}
                    {formatInTimezone(status.shift.start, getEmployeeTimezone(employee))}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Main Publishing Form & History */}
      <section className="grid lg:grid-cols-5 gap-6 items-start">
        {/* Announcement Publisher Form */}
        <form
          onSubmit={publish}
          className="lg:col-span-2 rounded-xl border bg-card p-5 shadow-lift space-y-4"
        >
          <h2 className="font-bold text-primary flex items-center gap-2">
            <Megaphone className="h-4 w-4" /> Publish announcement
          </h2>

          <label className="block text-xs font-bold text-muted-foreground">
            Title *
            <input
              required
              placeholder="Announcement title..."
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-none"
            />
          </label>

          <label className="block text-xs font-bold text-muted-foreground">
            Message *
            <textarea
              required
              placeholder="Write notice message..."
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={4}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground focus:ring-1 focus:ring-primary focus:outline-none"
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
              Audience Target
              <select
                value={targetType}
                onChange={(event) => {
                  setTargetType(event.target.value as CompanyNotice["targetType"]);
                  setTargetId("");
                  setSelectedStateCodes([]);
                  setSelectedEmployeeIds([]);
                  setSelectedCompanyIds([]);
                  setEmpSearchQuery("");
                  setEmpFilterCompanyId("all");
                  setEmpFilterDeptId("all");
                }}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground font-semibold"
              >
                <option value="all">Everyone (All Companies)</option>
                <option value="companies">Specific Companies</option>
                <option value="dept">Specific Department</option>
                <option value="states">One or more states</option>
                <option value="employee">Specific people</option>
              </select>
            </label>
          </div>

          {/* Target: Specific Companies */}
          {targetType === "companies" && (
            <div className="space-y-2 rounded-lg border bg-secondary/20 p-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-muted-foreground flex items-center gap-1">
                  <Building2 className="h-3.5 w-3.5 text-primary" /> Select Companies (
                  {selectedCompanyIds.length})
                </label>
                <div className="flex gap-2 text-[11px] font-bold">
                  <button
                    type="button"
                    onClick={() => setSelectedCompanyIds(companies.map((c) => c.id || COMPANY_ID))}
                    className="text-primary hover:underline"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedCompanyIds([])}
                    className="text-muted-foreground hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-1.5 max-h-48 overflow-y-auto">
                {companies.map((c) => {
                  const compId = c.id || COMPANY_ID;
                  const isSelected = selectedCompanyIds.includes(compId);
                  return (
                    <label
                      key={compId}
                      className={`flex items-center gap-2 text-xs font-semibold p-2 rounded-md cursor-pointer transition-colors ${
                        isSelected
                          ? "bg-primary/10 border border-primary/30 text-primary"
                          : "hover:bg-muted"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          setSelectedCompanyIds((prev) =>
                            prev.includes(compId)
                              ? prev.filter((i) => i !== compId)
                              : [...prev, compId],
                          );
                        }}
                      />
                      <span>
                        {c.name} {c.isMain ? "(Main)" : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Target: Specific Department */}
          {targetType === "dept" && (
            <label className="block text-xs font-bold text-muted-foreground">
              Select Department
              <select
                required
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground font-semibold"
              >
                <option value="">Choose department…</option>
                {companies.map((comp) => {
                  const compId = comp.id || COMPANY_ID;
                  const compDepts = departments.filter(
                    (d) => (d.companyId || COMPANY_ID) === compId,
                  );
                  if (compDepts.length === 0) return null;

                  return (
                    <optgroup key={compId} label={comp.name}>
                      {compDepts.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </label>
          )}

          {/* Target: States */}
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
              </div>
            </fieldset>
          )}

          {/* Target: Specific Employees (People Filter & Picker) */}
          {targetType === "employee" && (
            <fieldset className="space-y-3 rounded-xl border bg-secondary/10 p-3.5">
              <div className="flex items-center justify-between">
                <legend className="text-xs font-extrabold uppercase text-primary tracking-wider flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" /> Target People ({selectedEmployeeIds.length}{" "}
                  Selected)
                </legend>
                <div className="flex gap-2 text-[11px] font-bold">
                  <button
                    type="button"
                    onClick={() => {
                      const visibleIds = filteredEmployeeAudience.map((e) => e.id);
                      setSelectedEmployeeIds((prev) =>
                        Array.from(new Set([...prev, ...visibleIds])),
                      );
                    }}
                    className="text-primary hover:underline"
                  >
                    Select visible ({filteredEmployeeAudience.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedEmployeeIds([])}
                    className="text-muted-foreground hover:underline"
                  >
                    Clear all
                  </button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Filter by company or department, then tick the individual people who should receive
                this announcement.
              </p>

              {/* Employee Filters: Search, Company, Dept */}
              <div className="space-y-2 border-b pb-3">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Search people by name, email..."
                    value={empSearchQuery}
                    onChange={(e) => setEmpSearchQuery(e.target.value)}
                    className="w-full rounded-lg border bg-background pl-8 pr-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={empFilterCompanyId}
                    onChange={(e) => {
                      setEmpFilterCompanyId(e.target.value);
                      setEmpFilterDeptId("all");
                    }}
                    className="rounded-lg border bg-background px-2 py-1.5 text-xs font-semibold text-foreground"
                  >
                    <option value="all">All Companies</option>
                    {companies.map((c) => (
                      <option key={c.id || COMPANY_ID} value={c.id || COMPANY_ID}>
                        {c.name}
                      </option>
                    ))}
                  </select>

                  <select
                    value={empFilterDeptId}
                    onChange={(e) => setEmpFilterDeptId(e.target.value)}
                    className="rounded-lg border bg-background px-2 py-1.5 text-xs font-semibold text-foreground"
                  >
                    <option value="all">All Departments</option>
                    {employeeFilterDepartments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Filtered Employee List */}
              <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {filteredEmployeeAudience.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4 italic">
                    No employees match your search filter.
                  </p>
                ) : (
                  filteredEmployeeAudience.map((emp) => {
                    const isSelected = selectedEmployeeIds.includes(emp.id);
                    const compName = companyMap.get(emp.companyId || COMPANY_ID) || "Company";
                    const deptName = deptMap.get(emp.deptId || "") || "No department";

                    return (
                      <label
                        key={emp.id}
                        className={`flex items-center justify-between gap-2 rounded-lg p-2 text-xs cursor-pointer transition-colors border ${
                          isSelected
                            ? "bg-primary/10 border-primary/40 text-foreground"
                            : "bg-background border-transparent hover:bg-muted"
                        }`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(event) =>
                              setSelectedEmployeeIds((current) =>
                                event.target.checked
                                  ? [...current, emp.id]
                                  : current.filter((id) => id !== emp.id),
                              )
                            }
                          />
                          <div className="truncate">
                            <div className="font-bold truncate text-foreground">{emp.name}</div>
                            <div className="text-[11px] text-muted-foreground truncate">
                              {emp.email}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0 text-[10px]">
                          <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 font-semibold truncate">
                            {deptName}
                          </span>
                          <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-semibold truncate">
                            {compName}
                          </span>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
            </fieldset>
          )}

          {/* Delivery Mode: Instant or Scheduled */}
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
              </label>
            )}
          </fieldset>

          <button
            disabled={busy}
            className="w-full rounded-lg bg-primary py-3 text-sm font-bold text-primary-foreground hover:bg-primary/90 transition-colors shadow-md disabled:opacity-50"
          >
            {busy ? "Publishing…" : "Publish notification"}
          </button>
        </form>

        {/* Announcement History Column */}
        <div className="lg:col-span-3 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-primary flex items-center gap-2">
              Announcement history
              {pageCompanyFilter !== "all" && (
                <span className="text-xs font-normal text-muted-foreground">
                  (Filtered by {companyMap.get(pageCompanyFilter) || "Company"})
                </span>
              )}
            </h2>
            <span className="text-xs text-muted-foreground font-semibold">
              Showing {filteredNotices.length} notice{filteredNotices.length === 1 ? "" : "s"}
            </span>
          </div>

          {filteredNotices.map((notice) => (
            <div key={notice.id} className="rounded-xl border bg-card p-4 shadow-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1.5">
                  <div className="font-bold text-primary text-base flex items-center gap-2">
                    <span>{notice.title}</span>
                    <span
                      className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-extrabold tracking-wider ${
                        notice.priority === "urgent"
                          ? "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300"
                          : notice.priority === "warning"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                            : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                      }`}
                    >
                      {notice.priority}
                    </span>
                  </div>

                  <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                    {notice.message}
                  </div>

                  <div className="pt-2 text-[11px] font-semibold text-muted-foreground flex flex-wrap items-center gap-3">
                    <span className="bg-muted px-2 py-0.5 rounded text-foreground">
                      Target: {recipientLabel(notice)}
                    </span>
                    <span>
                      {notice.publishAt && getNoticeDeliveryTime(notice).getTime() > now.getTime()
                        ? `📅 Scheduled for ${getNoticeDeliveryTime(notice).toLocaleString()}`
                        : `Sent ${getNoticeDeliveryTime(notice).toLocaleString()}`}
                    </span>
                  </div>
                </div>

                <button
                  onClick={() =>
                    deleteDoc(doc(db(), "notices", notice.id)).then(() =>
                      toast.success("Notification deleted"),
                    )
                  }
                  className="rounded-lg border p-2 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                  title="Delete announcement"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}

          {filteredNotices.length === 0 && (
            <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground space-y-1">
              <div className="text-base font-semibold text-foreground">No announcements found</div>
              <p>
                {loadingNotices
                  ? "Loading announcements…"
                  : pageCompanyFilter !== "all"
                    ? `No announcements for ${companyMap.get(pageCompanyFilter)}.`
                    : "No announcements published yet."}
              </p>
            </div>
          )}

          {hasMoreNotices && (
            <button
              type="button"
              disabled={loadingNotices}
              onClick={() => {
                setLoadingNotices(true);
                setNoticeLimit((current) => current + NOTICE_PAGE_SIZE);
              }}
              className="w-full rounded-lg border px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50"
            >
              {loadingNotices ? "Loading…" : "Load more announcements"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
