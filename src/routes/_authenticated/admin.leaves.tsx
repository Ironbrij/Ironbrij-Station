import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { collection, doc, onSnapshot, updateDoc, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Company, CompanyNotice, Employee, LeaveDayItem, LeaveRequest } from "@/lib/types";
import { COMPANY_ID } from "@/lib/types";
import { useAuth } from "@/lib/auth-context";
import { companyEmailBranding, findEmployeeCompany } from "@/lib/email-branding";
import { toast } from "sonner";
import { getLeaveLabel } from "@/lib/attendance";
import { ymd } from "@/lib/time";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { resolveProfilePhoto } from "@/lib/profile-photo";
import { Calendar, CheckCircle2, Clock, Edit3, Plus, Trash2, X } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin/leaves")({
  head: () => ({
    meta: [
      { title: "Leave Requests — SavyTimes Admin" },
      { name: "description", content: "Review and manage employee leave requests." },
      { property: "og:title", content: "Leave Requests — SavyTimes Admin" },
      {
        property: "og:description",
        content: "Review and manage employee leave requests.",
      },
    ],
  }),
  component: LeaveRequestsPage,
});

type StatusFilter = "all" | LeaveRequest["status"];
type PeriodFilter = "all" | "today" | "upcoming" | "past";

type UserProfile = {
  uid: string;
  email?: string;
  photoUrl?: string;
  photoURL?: string;
  picture?: string;
};

const PAGE_SIZE = 8;

function LeaveRequestsPage() {
  const [leaves, setLeaves] = useState<LeaveRequest[] | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [filterCompany, setFilterCompany] = useState("all");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingLeave, setEditingLeave] = useState<LeaveRequest | null>(null);
  const { user } = useAuth();
  const today = ymd(new Date());

  useEffect(() => {
    const unsubCompanies = onSnapshot(collection(db(), "companies"), (snapshot) =>
      setCompanies(
        snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Company, "id">) })),
      ),
    );
    const unsubscribeLeaves = onSnapshot(collection(db(), "leaveRequests"), (snapshot) =>
      setLeaves(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<LeaveRequest, "id">),
        })),
      ),
    );
    const unsubscribeEmployees = onSnapshot(collection(db(), "employees"), (snapshot) =>
      setEmployees(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Employee, "id">),
        })),
      ),
    );
    const unsubscribeUsers = onSnapshot(collection(db(), "users"), (snapshot) =>
      setUserProfiles(
        snapshot.docs.map((item) => ({
          uid: item.id,
          ...(item.data() as Omit<UserProfile, "uid">),
        })),
      ),
    );

    return () => {
      unsubCompanies();
      unsubscribeLeaves();
      unsubscribeEmployees();
      unsubscribeUsers();
    };
  }, []);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, statusFilter, filterCompany, periodFilter, dateFrom, dateTo]);

  const employeeById = useMemo(() => {
    const map = new Map<string, Employee>();
    for (const employee of employees) {
      map.set(employee.id, employee);
      if (employee.authUid) map.set(employee.authUid, employee);
    }
    return map;
  }, [employees]);

  const userByIdentity = useMemo(() => {
    const map = new Map<string, UserProfile>();
    for (const profile of userProfiles) {
      map.set(profile.uid, profile);
      if (profile.email) map.set(profile.email.toLowerCase(), profile);
    }
    return map;
  }, [userProfiles]);

  const filteredRequests = useMemo(() => {
    if (!leaves) return [];
    const queryText = search.trim().toLowerCase();
    const statusRank: Record<LeaveRequest["status"], number> = {
      pending: 0,
      approved: 1,
      rejected: 2,
    };

    return leaves
      .filter((leave) => {
        const employee = employeeById.get(leave.employeeId);
        const searchable =
          `${employee?.name || ""} ${employee?.email || ""} ${leave.reason || ""}`.toLowerCase();
        if (queryText && !searchable.includes(queryText)) return false;
        if (statusFilter !== "all" && leave.status !== statusFilter) return false;
        if (filterCompany !== "all") {
          const matchCompany =
            leave.companyId === filterCompany ||
            (!leave.companyId && employee?.companyId === filterCompany) ||
            employee?.companyIds?.includes(filterCompany) ||
            (!employee?.companyId && filterCompany === COMPANY_ID);
          if (!matchCompany) return false;
        }
        if (periodFilter === "today" && !(leave.dateFrom <= today && leave.dateTo >= today))
          return false;
        if (periodFilter === "upcoming" && leave.dateFrom <= today) return false;
        if (periodFilter === "past" && leave.dateTo >= today) return false;
        if (dateFrom && leave.dateTo < dateFrom) return false;
        if (dateTo && leave.dateFrom > dateTo) return false;
        return true;
      })
      .sort((a, b) => {
        const statusDifference = statusRank[a.status] - statusRank[b.status];
        if (statusDifference) return statusDifference;
        if (a.status === "pending") return a.dateFrom.localeCompare(b.dateFrom);
        return requestTimestamp(b) - requestTimestamp(a) || b.dateFrom.localeCompare(a.dateFrom);
      });
  }, [
    leaves,
    employeeById,
    search,
    statusFilter,
    filterCompany,
    periodFilter,
    dateFrom,
    dateTo,
    today,
  ]);

  const visibleRequests = filteredRequests.slice(0, visibleCount);
  const hasFilters =
    Boolean(search || dateFrom || dateTo) || statusFilter !== "pending" || periodFilter !== "all";

  async function setStatus(
    id: string,
    status: "approved" | "rejected",
    paymentStatus?: "paid" | "unpaid",
  ) {
    const leave = leaves?.find((item) => item.id === id);
    if (!leave || leave.status !== "pending" || busyId) return;
    setBusyId(id);

    try {
      const employee = employeeById.get(leave.employeeId);
      const batch = writeBatch(db());
      batch.update(doc(db(), "leaveRequests", id), {
        status,
        decidedAt: new Date().toISOString(),
        decidedBy: user?.email || "Admin",
        decisionSource: "admin",
        ...(status === "approved" && paymentStatus ? { paymentStatus } : {}),
      });

      if (employee) {
        const approved = status === "approved";
        const dateRange =
          leave.dateFrom === leave.dateTo ? leave.dateFrom : `${leave.dateFrom} to ${leave.dateTo}`;
        const leaveLabel = getLeaveLabel(leave);
        const reason = leave.reason?.trim() || "No reason was provided.";
        const notice: Omit<CompanyNotice, "id"> = {
          title: approved ? "Leave request approved" : "Leave request rejected",
          message: approved
            ? `Your ${leaveLabel.toLowerCase()} request for ${dateRange} has been approved.`
            : `Your ${leaveLabel.toLowerCase()} request for ${dateRange} has been rejected. Submitted reason: ${reason}`,
          priority: approved ? "info" : "warning",
          targetType: "employee",
          targetEmployeeId: employee.id,
          targetEmployeeIds: [employee.id],
          createdAt: new Date().toISOString(),
          authorName: user?.displayName || user?.email || "Leave administration",
        };
        batch.set(doc(collection(db(), "notices")), notice);
      }

      await batch.commit();
      toast.success(
        status === "approved"
          ? "Leave approved and employee notified"
          : "Leave rejected and employee notified",
      );

      if (!employee || !user) return;
      try {
        const idToken = await user.getIdToken();
        const emailResponse = await fetch("/api/leave-decision-notification", {
          method: "POST",
          headers: {
            authorization: `Bearer ${idToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            company: companyEmailBranding(
              findEmployeeCompany(employee, companies),
              employee.companyId,
            ),
            leaveRequestId: leave.id,
            employeeId: employee.id,
            employeeName: employee.name,
            employeeEmail: employee.email,
            dateFrom: leave.dateFrom,
            dateTo: leave.dateTo,
            leaveType: leave.leaveType || "full_day",
            leaveCategory: leave.leaveCategory,
            paymentStatus: paymentStatus || leave.paymentStatus,
            remarks: leave.remarks || leave.reason,
            halfDayPeriod: leave.halfDayPeriod,
            startTime: leave.startTime,
            endTime: leave.endTime,
            reason: leave.reason,
            status,
          }),
        });
        if (!emailResponse.ok) {
          toast.warning("Decision saved, but the email automation is not configured.");
        }
      } catch {
        toast.warning("Decision saved, but the decision email could not be sent.");
      }
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function revokeLeave(id: string) {
    const leave = leaves?.find((item) => item.id === id);
    if (!leave || busyId) return;

    if (
      !window.confirm(
        "Are you sure you want to revoke this approved leave? This will allow the employee to punch in on these dates.",
      )
    ) {
      return;
    }

    setBusyId(id);
    try {
      const employee = employeeById.get(leave.employeeId);
      const batch = writeBatch(db());
      batch.update(doc(db(), "leaveRequests", id), {
        status: "rejected",
        decidedAt: new Date().toISOString(),
        decidedBy: user?.email || "Admin",
        decisionReason: "Revoked by admin",
      });

      if (employee) {
        const dateRange =
          leave.dateFrom === leave.dateTo ? leave.dateFrom : `${leave.dateFrom} to ${leave.dateTo}`;
        const notice: Omit<CompanyNotice, "id"> = {
          title: "Approved leave revoked",
          message: `Your approved leave for ${dateRange} has been revoked by admin. You may now punch in as usual.`,
          priority: "warning",
          targetType: "employee",
          targetEmployeeId: employee.id,
          targetEmployeeIds: [employee.id],
          createdAt: new Date().toISOString(),
          authorName: user?.displayName || user?.email || "Leave administration",
        };
        batch.set(doc(collection(db(), "notices")), notice);
      }

      await batch.commit();
      toast.success("Approved leave revoked successfully! Employee can now punch in.");
    } catch (error) {
      toast.error("Could not revoke leave: " + (error as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  function clearFilters() {
    setSearch("");
    setStatusFilter("pending");
    setPeriodFilter("all");
    setDateFrom("");
    setDateTo("");
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">Leave requests</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review dates and reasons, then approve, reject, or revoke leave requests.
        </p>
      </div>

      <section className="border-b pb-5">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[1.4fr_0.8fr_0.8fr_1fr_1fr]">
          <FilterField label="Search">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, email, or reason"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-foreground"
            />
          </FilterField>

          <FilterField label="Status">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="all">Any status</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </FilterField>

          <FilterField label="Company">
            <select
              value={filterCompany}
              onChange={(event) => setFilterCompany(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="all">All companies ({companies.length})</option>
              {companies.map((c) => (
                <option key={c.id || c.name} value={c.id || COMPANY_ID}>
                  {c.name} {c.isMain ? "(Main)" : ""}
                </option>
              ))}
            </select>
          </FilterField>

          <FilterField label="When">
            <select
              value={periodFilter}
              onChange={(event) => setPeriodFilter(event.target.value as PeriodFilter)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="all">Any date</option>
              <option value="today">Today</option>
              <option value="upcoming">Upcoming</option>
              <option value="past">Past</option>
            </select>
          </FilterField>

          <FilterField label="From">
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </FilterField>

          <FilterField label="To">
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </FilterField>
        </div>

        {hasFilters && (
          <div className="mt-3 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">
              Showing {filteredRequests.length} of {leaves?.length || 0} requests
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className="font-medium text-foreground hover:underline"
            >
              Clear filters
            </button>
          </div>
        )}
      </section>

      {leaves === null ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading leave requests…
        </div>
      ) : filteredRequests.length === 0 ? (
        <div className="rounded-xl border bg-card p-8 text-center shadow-lift">
          <h2 className="font-semibold text-foreground">No leave requests found</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasFilters
              ? "Try adjusting your filters to see more requests."
              : "Employee leave applications will appear here."}
          </p>
        </div>
      ) : (
        <section className="space-y-3">
          {visibleRequests.map((leave) => {
            const employee = employeeById.get(leave.employeeId);
            const userProfile = userByIdentity.get(
              employee?.authUid || employee?.id || employee?.email?.toLowerCase() || "",
            );
            const isBusy = busyId === leave.id;

            return (
              <article key={leave.id} className="rounded-xl border bg-card p-5 shadow-lift">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
                  <div className="flex items-center gap-3">
                    <ProfileAvatar
                      name={employee?.name || leave.employeeId}
                      photoUrl={resolveProfilePhoto(userProfile, employee)}
                      className="h-10 w-10 text-xs"
                    />
                    <div>
                      <div className="font-semibold text-foreground">
                        {employee?.name || leave.employeeId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {employee?.email || "No email available"}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingLeave(leave)}
                      className="inline-flex items-center gap-1.5 rounded-lg border bg-secondary/50 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-secondary transition shadow-2xs"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      Tweak Dates & Breakdown
                    </button>
                    <span className="text-xs font-medium text-muted-foreground">
                      {leave.status === "pending"
                        ? "Pending review"
                        : leave.decisionSource === "automatic"
                          ? "Rejected automatically"
                          : leave.status === "approved"
                            ? "Approved"
                            : "Rejected"}
                    </span>
                  </div>
                </div>

                <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <div className="flex items-center justify-between">
                      <dt className="text-xs text-muted-foreground">Dates</dt>
                      <button
                        type="button"
                        onClick={() => setEditingLeave(leave)}
                        className="text-[11px] font-bold text-primary hover:underline flex items-center gap-1"
                      >
                        <Edit3 className="h-3 w-3" /> Edit Dates
                      </button>
                    </div>
                    {Array.isArray(leave.dates) && leave.dates.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {leave.dates.map((d) => (
                          <span
                            key={d.date}
                            className="inline-flex items-center gap-1 rounded-md border bg-muted/60 px-2 py-0.5 text-[11px] font-semibold text-foreground"
                          >
                            <Calendar className="h-3 w-3 text-muted-foreground" />
                            <span className="font-bold">{formatDateKey(d.date)}</span>:{" "}
                            <span className="text-muted-foreground">
                              {d.leaveType === "half_day"
                                ? d.halfDayPeriod === "second_half"
                                  ? "Half (2nd)"
                                  : "Half (1st)"
                                : d.leaveType === "timed_break"
                                  ? `Break (${d.startTime || ""}-${d.endTime || ""})`
                                  : "Full day"}
                            </span>
                            <span className="text-muted-foreground">·</span>
                            <span
                              className={
                                d.paymentStatus === "unpaid"
                                  ? "font-bold text-amber-600 dark:text-amber-400"
                                  : "font-bold text-emerald-600 dark:text-emerald-400"
                              }
                            >
                              {d.paymentStatus || "paid"}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <>
                        <dd className="mt-0.5 font-medium text-foreground">
                          {formatLeaveDateRange(leave.dateFrom, leave.dateTo)}
                        </dd>
                        <dd className="text-xs text-muted-foreground">
                          {dateDurationLabel(leave)}
                        </dd>
                      </>
                    )}
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Type</dt>
                    <dd className="mt-0.5 font-medium text-foreground">{leaveTypeLabel(leave)}</dd>
                    <dd className="text-xs text-muted-foreground">{leaveTimeDetail(leave)}</dd>
                    <dd className="mt-1 text-xs font-semibold text-foreground">
                      {(leave.leaveCategory || "other").replace("_", " ")} ·{" "}
                      {leave.paymentStatus === "unpaid"
                        ? "Unpaid"
                        : leave.paymentStatus === "paid"
                          ? "Paid"
                          : "Not classified"}
                    </dd>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-1">
                    <dt className="text-xs text-muted-foreground">Reason</dt>
                    <dd className="mt-0.5 leading-relaxed text-foreground">
                      {leave.reason?.trim() || "No reason was provided."}
                    </dd>
                  </div>
                </dl>

                <div className="mt-4 flex flex-col gap-3 border-t pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    Submitted {formatRequestTimestamp(leave)}
                    {leave.decidedAt ? ` · Decided ${formatIsoDateTime(leave.decidedAt)}` : ""}
                    {leave.decidedBy ? ` by ${leave.decidedBy}` : ""}
                  </span>

                  {leave.decisionSource === "automatic" && leave.decisionReason && (
                    <span>{leave.decisionReason}</span>
                  )}

                  {leave.status === "pending" ? (
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => setStatus(leave.id, "rejected")}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => setStatus(leave.id, "approved", "unpaid")}
                        className="rounded-md border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        Approve unpaid
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => setStatus(leave.id, "approved", "paid")}
                        className="rounded-md border border-foreground bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-80 disabled:opacity-50"
                      >
                        {isBusy ? "Saving…" : "Approve paid"}
                      </button>
                    </div>
                  ) : leave.status === "approved" ? (
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={Boolean(busyId)}
                        onClick={() => revokeLeave(leave.id)}
                        className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300 disabled:opacity-50"
                      >
                        {isBusy ? "Revoking..." : "Revoke Leave"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </section>
      )}

      {visibleCount < filteredRequests.length && (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
            className="rounded-md border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Load more
          </button>
        </div>
      )}

      {/* Edit Leave Dates & Breakdown Modal */}
      {editingLeave && (
        <EditLeaveModal
          leave={editingLeave}
          employee={employeeById.get(editingLeave.employeeId)}
          onClose={() => setEditingLeave(null)}
        />
      )}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateKey(dateKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parseDateKey(dateKey));
}

function formatLeaveDateRange(dateFrom: string, dateTo: string): string {
  if (dateFrom === dateTo) return formatDateKey(dateFrom);
  return `${formatDateKey(dateFrom)} – ${formatDateKey(dateTo)}`;
}

function inclusiveDays(dateFrom: string, dateTo: string): number {
  return Math.max(
    1,
    Math.round((parseDateKey(dateTo).getTime() - parseDateKey(dateFrom).getTime()) / 86400000) + 1,
  );
}

function dateDurationLabel(leave: LeaveRequest): string {
  if (leave.leaveType === "half_day") return "Half day";
  if (leave.leaveType === "timed_break") return "Timed request";
  const days = inclusiveDays(leave.dateFrom, leave.dateTo);
  return `${days} calendar ${days === 1 ? "day" : "days"}`;
}

function leaveTypeLabel(leave: LeaveRequest): string {
  if (leave.leaveType === "half_day") return "Half-day leave";
  if (leave.leaveType === "timed_break") return "Timed break";
  return "Full-day leave";
}

function leaveTimeDetail(leave: LeaveRequest): string {
  if (leave.leaveType === "half_day") {
    return leave.halfDayPeriod === "second_half" ? "Second half of shift" : "First half of shift";
  }
  if (leave.leaveType === "timed_break") {
    return leave.startTime && leave.endTime
      ? `${leave.startTime} – ${leave.endTime}`
      : "Time not specified";
  }
  return leave.dateFrom === leave.dateTo ? "One full day" : "Multiple days";
}

function requestTimestamp(leave: LeaveRequest): number {
  const value = leave.createdAt as unknown as { toMillis?: () => number } | string | undefined;
  if (typeof value === "string") return new Date(value).getTime() || 0;
  return value?.toMillis?.() ?? 0;
}

function formatRequestTimestamp(leave: LeaveRequest): string {
  const timestamp = requestTimestamp(leave);
  if (!timestamp) return "not recorded";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatIsoDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function addCalendarDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function EditLeaveModal({
  leave,
  employee,
  onClose,
}: {
  leave: LeaveRequest;
  employee?: Employee;
  onClose: () => void;
}) {
  const initialDates: LeaveDayItem[] = useMemo(() => {
    if (Array.isArray(leave.dates) && leave.dates.length > 0) {
      return [...leave.dates].sort((a, b) => a.date.localeCompare(b.date));
    }
    const list: LeaveDayItem[] = [];
    let d = leave.dateFrom;
    while (d <= leave.dateTo) {
      list.push({
        date: d,
        leaveType: leave.leaveType || "full_day",
        paymentStatus: leave.paymentStatus || "paid",
        leaveCategory: leave.leaveCategory || "annual",
        halfDayPeriod: leave.halfDayPeriod || "first_half",
        startTime: leave.startTime || "09:00",
        endTime: leave.endTime || "17:00",
      });
      d = addCalendarDays(d, 1);
    }
    return list;
  }, [leave]);

  const [datesList, setDatesList] = useState<LeaveDayItem[]>(initialDates);
  const [newDate, setNewDate] = useState("");
  const [newType, setNewType] = useState<NonNullable<LeaveDayItem["leaveType"]>>("full_day");
  const [newPayment, setNewPayment] = useState<NonNullable<LeaveDayItem["paymentStatus"]>>("paid");
  const [newHalfDayPeriod, setNewHalfDayPeriod] = useState<"first_half" | "second_half">("first_half");
  const [newCategory, setNewCategory] = useState<NonNullable<LeaveDayItem["leaveCategory"]>>(
    leave.leaveCategory || "annual",
  );
  const [remarks, setRemarks] = useState(leave.remarks || "");
  const [reason, setReason] = useState(leave.reason || "");
  const [saving, setSaving] = useState(false);

  const handleAddDate = () => {
    if (!newDate) {
      toast.error("Please pick a date to add");
      return;
    }
    if (datesList.some((item) => item.date === newDate)) {
      toast.error("This date is already in the leave list");
      return;
    }
    const item: LeaveDayItem = {
      date: newDate,
      leaveType: newType,
      paymentStatus: newPayment,
      leaveCategory: newCategory,
    };
    if (newType === "half_day") {
      item.halfDayPeriod = newHalfDayPeriod;
    }
    const updated = [...datesList, item].sort((a, b) => a.date.localeCompare(b.date));
    setDatesList(updated);
    setNewDate("");
    toast.success(`Added ${newDate}`);
  };

  const handleRemoveDate = (dateToRemove: string) => {
    if (datesList.length <= 1) {
      toast.error("A leave request must have at least one date");
      return;
    }
    setDatesList(datesList.filter((item) => item.date !== dateToRemove));
  };

  const handleUpdateItem = (index: number, patch: Partial<LeaveDayItem>) => {
    const next = [...datesList];
    const updated = { ...next[index], ...patch };
    if (updated.leaveType !== "half_day") {
      delete updated.halfDayPeriod;
    }
    if (updated.leaveType !== "timed_break") {
      delete updated.startTime;
      delete updated.endTime;
    }
    next[index] = updated;
    setDatesList(next);
  };

  const handleSave = async () => {
    if (datesList.length === 0) {
      toast.error("Please add at least one date");
      return;
    }
    setSaving(true);
    try {
      const cleanedDates: LeaveDayItem[] = datesList.map((item) => {
        const res: LeaveDayItem = {
          date: item.date,
          leaveType: item.leaveType || "full_day",
          paymentStatus: item.paymentStatus || "paid",
          leaveCategory: item.leaveCategory || "annual",
        };
        if (item.leaveType === "half_day" && item.halfDayPeriod) {
          res.halfDayPeriod = item.halfDayPeriod;
        }
        if (item.leaveType === "timed_break") {
          if (item.startTime) res.startTime = item.startTime;
          if (item.endTime) res.endTime = item.endTime;
        }
        return res;
      });

      const sorted = cleanedDates.sort((a, b) => a.date.localeCompare(b.date));
      const minDate = sorted[0].date;
      const maxDate = sorted[sorted.length - 1].date;

      const payload: Record<string, any> = {
        dates: sorted,
        dateFrom: minDate,
        dateTo: maxDate,
        leaveType: sorted[0]?.leaveType || "full_day",
        paymentStatus: sorted[0]?.paymentStatus || "paid",
        leaveCategory: sorted[0]?.leaveCategory || "annual",
        remarks: remarks || "",
        reason: reason || "",
      };

      if (sorted[0]?.leaveType === "half_day" && sorted[0]?.halfDayPeriod) {
        payload.halfDayPeriod = sorted[0].halfDayPeriod;
      }

      await updateDoc(doc(db(), "leaveRequests", leave.id), payload);

      toast.success("Leave dates and breakdown successfully updated!");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in">
      <div className="rounded-2xl border bg-card max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-5 border-b bg-secondary/30 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center font-bold">
              <Calendar className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">
                Tweak Leave Dates & Breakdown
              </h3>
              <p className="text-xs text-muted-foreground">
                {employee?.name || leave.employeeId} · {employee?.email || ""}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto flex-1 text-sm">
          {/* Reason Box */}
          <div className="p-3 rounded-xl bg-muted/40 border text-xs space-y-1">
            <div className="font-bold text-foreground flex items-center gap-1.5 text-muted-foreground">
              Submitted Request & Reason
            </div>
            <p className="text-foreground whitespace-pre-wrap leading-relaxed font-medium">
              {leave.reason?.trim() || "No submitted reason."}
            </p>
          </div>

          {/* Dates Breakdown Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-foreground uppercase tracking-wide">
                Included Dates ({datesList.length})
              </label>
              <span className="text-[11px] text-muted-foreground">
                Configure type and paid status per date
              </span>
            </div>

            <div className="rounded-xl border divide-y overflow-hidden bg-background">
              {datesList.map((item, idx) => (
                <div
                  key={item.date}
                  className="p-3 flex flex-wrap items-center justify-between gap-2.5 hover:bg-muted/20"
                >
                  <div className="flex items-center gap-2 min-w-[130px]">
                    <Calendar className="h-4 w-4 text-primary shrink-0" />
                    <div>
                      <div className="font-bold text-xs text-foreground">
                        {formatDateKey(item.date)}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{item.date}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Type Selector */}
                    <select
                      value={
                        item.leaveType === "half_day"
                          ? `half_${item.halfDayPeriod || "first_half"}`
                          : item.leaveType || "full_day"
                      }
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val.startsWith("half_")) {
                          handleUpdateItem(idx, {
                            leaveType: "half_day",
                            halfDayPeriod: val === "half_second_half" ? "second_half" : "first_half",
                          });
                        } else {
                          handleUpdateItem(idx, {
                            leaveType: val as LeaveDayItem["leaveType"],
                            halfDayPeriod: undefined,
                          });
                        }
                      }}
                      className="rounded-md border bg-background px-2 py-1 text-xs font-medium text-foreground outline-none"
                    >
                      <option value="full_day">Full Day</option>
                      <option value="half_first_half">Half Day (1st Half)</option>
                      <option value="half_second_half">Half Day (2nd Half)</option>
                      <option value="timed_break">Timed Break</option>
                    </select>

                    {/* Paid / Unpaid */}
                    <select
                      value={item.paymentStatus || "paid"}
                      onChange={(e) =>
                        handleUpdateItem(idx, {
                          paymentStatus: e.target.value as "paid" | "unpaid",
                        })
                      }
                      className={`rounded-md border px-2 py-1 text-xs font-bold outline-none ${
                        item.paymentStatus === "unpaid"
                          ? "bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300"
                          : "bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/40 dark:text-emerald-300"
                      }`}
                    >
                      <option value="paid">Paid</option>
                      <option value="unpaid">Unpaid</option>
                    </select>

                    {/* Category */}
                    <select
                      value={item.leaveCategory || "annual"}
                      onChange={(e) =>
                        handleUpdateItem(idx, {
                          leaveCategory: e.target.value as LeaveDayItem["leaveCategory"],
                        })
                      }
                      className="rounded-md border bg-background px-2 py-1 text-xs font-medium text-muted-foreground outline-none"
                    >
                      <option value="annual">Annual</option>
                      <option value="sick">Sick</option>
                      <option value="personal">Personal</option>
                      <option value="other">Other</option>
                    </select>

                    {/* Remove Date */}
                    <button
                      type="button"
                      onClick={() => handleRemoveDate(item.date)}
                      className="p-1 rounded-md text-muted-foreground hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                      title="Remove date"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Add Another Date Bar */}
          <div className="p-3 rounded-xl border bg-secondary/20 space-y-2">
            <label className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5 text-primary" /> Add Another Date to this Leave
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground outline-none"
              />
              <select
                value={
                  newType === "half_day"
                    ? `half_${newHalfDayPeriod}`
                    : newType
                }
                onChange={(e) => {
                  const val = e.target.value;
                  if (val.startsWith("half_")) {
                    setNewType("half_day");
                    setNewHalfDayPeriod(val === "half_second_half" ? "second_half" : "first_half");
                  } else {
                    setNewType((val as LeaveDayItem["leaveType"]) || "full_day");
                  }
                }}
                className="rounded-md border bg-background px-2 py-1.5 text-xs font-medium text-foreground outline-none"
              >
                <option value="full_day">Full Day</option>
                <option value="half_first_half">Half Day (1st Half)</option>
                <option value="half_second_half">Half Day (2nd Half)</option>
                <option value="timed_break">Timed Break</option>
              </select>

              <select
                value={newPayment}
                onChange={(e) => setNewPayment(e.target.value as "paid" | "unpaid")}
                className="rounded-md border bg-background px-2 py-1.5 text-xs font-semibold text-foreground outline-none"
              >
                <option value="paid">Paid</option>
                <option value="unpaid">Unpaid</option>
              </select>

              <select
                value={newCategory}
                onChange={(e) =>
                  setNewCategory((e.target.value as LeaveDayItem["leaveCategory"]) || "annual")
                }
                className="rounded-md border bg-background px-2 py-1.5 text-xs font-medium text-foreground outline-none"
              >
                <option value="annual">Annual</option>
                <option value="sick">Sick</option>
                <option value="personal">Personal</option>
                <option value="other">Other</option>
              </select>

              <button
                type="button"
                onClick={handleAddDate}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-bold shadow-xs hover:bg-primary/90 flex items-center gap-1"
              >
                <Plus className="h-3.5 w-3.5" /> Add Date
              </button>
            </div>
          </div>

          {/* Admin Remarks */}
          <div>
            <label className="block text-xs font-bold text-foreground mb-1">
              Admin Remarks / Notes
            </label>
            <input
              type="text"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="e.g. Approved per Rose request for Aug 25, 28 (half), 31"
              className="w-full px-3 py-2 rounded-lg border bg-background text-foreground text-xs font-medium focus:ring-2 focus:ring-primary/20 outline-none"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t bg-secondary/30 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg border text-xs font-bold text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="px-5 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-bold shadow-sm hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving ? (
              <>Saving Changes…</>
            ) : (
              <>
                <CheckCircle2 className="h-4 w-4" /> Save Dates & Breakdown
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
