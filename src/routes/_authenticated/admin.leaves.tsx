import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { collection, doc, onSnapshot, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Company, CompanyNotice, Employee, LeaveRequest } from "@/lib/types";
import { COMPANY_ID } from "@/lib/types";
import { useAuth } from "@/lib/auth-context";
import { companyEmailBranding, findEmployeeCompany } from "@/lib/email-branding";
import { toast } from "sonner";
import { getLeaveLabel } from "@/lib/attendance";
import { ymd } from "@/lib/time";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { resolveProfilePhoto } from "@/lib/profile-photo";

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

                <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-foreground">Dates</dt>
                    <dd className="mt-0.5 font-medium text-foreground">
                      {formatLeaveDateRange(leave.dateFrom, leave.dateTo)}
                    </dd>
                    <dd className="text-xs text-muted-foreground">{dateDurationLabel(leave)}</dd>
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
