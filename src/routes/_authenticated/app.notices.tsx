import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/auth-context";
import type { CompanyNotice, LeaveRequest, Punch } from "@/lib/types";
import {
  formatInTimezone,
  getActiveEmployeeLeave,
  getEmployeeApprovedLeaveForDate,
  getEmployeeHoliday,
  getEmployeeHolidayDates,
  getEmployeeTimezone,
  getLiveAttendanceStatus,
  getLeaveLabel,
  getShiftTimezone,
  zonedDateKey,
} from "@/lib/attendance";
import { CheckCircle2, Megaphone, AlertCircle, ShieldAlert, ChevronDown } from "lucide-react";
import { format } from "date-fns";
import { getNoticeDeliveryTime, isNoticePublished, noticeMatchesEmployee } from "@/lib/notices";
import { getPunchCompanyId } from "@/lib/company-context";

export const Route = createFileRoute("/_authenticated/app/notices")({
  head: () => ({
    meta: [
      { title: "Notifications & Notices — SavyTimes" },
      { name: "description", content: "View HR announcements and notices." },
      { property: "og:title", content: "Notifications & Notices — SavyTimes" },
      { property: "og:description", content: "View HR announcements and notices." },
    ],
  }),
  component: UserNoticesPage,
});

function UserNoticesPage() {
  const { employee, company, activeCompanyId } = useAuth();
  const [notices, setNotices] = useState<CompanyNotice[]>([]);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [readIds, setReadIds] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("read_notice_ids");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const todayStr = employee ? zonedDateKey(now, getShiftTimezone(employee)) : "";

  useEffect(() => {
    const unsubNotices = onSnapshot(collection(db(), "notices"), (s) =>
      setNotices(s.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<CompanyNotice, "id">) }))),
    );
    return () => {
      unsubNotices();
    };
  }, []);

  const companyPunches = useMemo(
    () => punches.filter((punch) => getPunchCompanyId(punch, employee) === activeCompanyId),
    [activeCompanyId, employee, punches],
  );
  const companyLeaves = useMemo(
    () =>
      leaves.filter(
        (leave) =>
          (leave.companyId || employee?.companyIds?.[0] || employee?.companyId) === activeCompanyId,
      ),
    [activeCompanyId, employee, leaves],
  );

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    if (!employee?.id) return () => window.clearInterval(timer);
    const unsubscribePunches = onSnapshot(
      query(collection(db(), "punches"), where("employeeId", "==", employee.id)),
      (snapshot) =>
        setPunches(
          snapshot.docs.map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) })),
        ),
    );
    const unsubscribeLeaves = onSnapshot(
      query(collection(db(), "leaveRequests"), where("employeeId", "==", employee.id)),
      (snapshot) =>
        setLeaves(
          snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<LeaveRequest, "id">),
          })),
        ),
    );
    return () => {
      window.clearInterval(timer);
      unsubscribePunches();
      unsubscribeLeaves();
    };
  }, [employee?.id]);

  const attendanceStatus = useMemo(
    () =>
      employee && !getEmployeeApprovedLeaveForDate(employee, companyLeaves, todayStr)
        ? getLiveAttendanceStatus(
            employee,
            companyPunches,
            now,
            company?.lateGraceMinutes ?? 5,
            company?.workingDays,
            getEmployeeHolidayDates(company, employee),
          )
        : null,
    [employee, companyPunches, companyLeaves, now, company, todayStr],
  );
  const isHoliday = useMemo(() => {
    return Boolean(getEmployeeHoliday(company, employee, todayStr));
  }, [company, employee, todayStr]);
  const activeLeave = useMemo(
    () => (employee ? getActiveEmployeeLeave(employee, companyLeaves, now) : null),
    [employee, companyLeaves, now],
  );

  // Filter notices relevant to this employee
  const allUserNotices = useMemo(() => {
    return notices
      .filter((notice) => isNoticePublished(notice, now))
      .filter((notice) => noticeMatchesEmployee(notice, employee, activeCompanyId))
      .sort((a, b) => getNoticeDeliveryTime(b).getTime() - getNoticeDeliveryTime(a).getTime());
  }, [notices, employee, now, activeCompanyId]);

  // Default: Filter to past 4 days only
  const visibleNotices = useMemo(() => {
    if (showAllHistory) return allUserNotices;

    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    const nowMs = Date.now();

    return allUserNotices.filter((n) => {
      if (!n.createdAt) return false;
      const deliveredMs = getNoticeDeliveryTime(n).getTime();
      return nowMs - deliveredMs <= fourDaysMs;
    });
  }, [allUserNotices, showAllHistory]);

  function markAsRead(id: string) {
    if (readIds.includes(id)) return;
    const next = [...readIds, id];
    setReadIds(next);
    localStorage.setItem("read_notice_ids", JSON.stringify(next));
    window.dispatchEvent(new Event("notice_read_change"));
  }

  function markAllAsRead() {
    const all = allUserNotices.map((n) => n.id);
    setReadIds(all);
    localStorage.setItem("read_notice_ids", JSON.stringify(all));
    window.dispatchEvent(new Event("notice_read_change"));
  }

  const hasOlderNotices = allUserNotices.length > visibleNotices.length;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            Notifications & HR Announcements
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Showing notices from the past 4 days.
          </p>
        </div>

        {allUserNotices.length > 0 && (
          <button
            onClick={markAllAsRead}
            className="rounded-md border bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Mark All as Read
          </button>
        )}
      </div>

      {activeLeave && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm">
          <span className="font-extrabold text-amber-800 dark:text-amber-200">
            {getLeaveLabel(activeLeave)}
          </span>
          <p className="mt-1 text-xs text-muted-foreground">
            Your attendance status is updated for this approved period.
          </p>
        </div>
      )}

      {/* Holiday status */}
      {isHoliday && (
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <span className="block text-sm font-semibold text-foreground">Company holiday</span>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Regular shifts are off today. Approved additional work can be logged separately.
            </p>
          </div>
          <Link
            to="/app/extra"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            Open extra time
          </Link>
        </div>
      )}

      <div className="space-y-4">
        {visibleNotices.length === 0 ? (
          <div className="rounded-xl border bg-card p-12 text-center text-sm text-muted-foreground font-medium space-y-3">
            <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
            <div className="text-base font-bold text-primary">
              No Notifications in the Past 4 Days
            </div>
            <p>You have no recent HR notices or announcements.</p>
            {hasOlderNotices && (
              <button
                onClick={() => setShowAllHistory(true)}
                className="btn-lift text-xs font-bold text-primary underline pt-2 block mx-auto"
              >
                Load Older Notifications ({allUserNotices.length} Total)
              </button>
            )}
          </div>
        ) : (
          visibleNotices.map((n) => {
            const isRead = readIds.includes(n.id);

            return (
              <div
                key={n.id}
                onClick={() => markAsRead(n.id)}
                className={`p-5 rounded-xl border transition-colors cursor-pointer relative ${
                  !isRead ? "bg-card border-primary/40" : "bg-muted/30 border-border"
                }`}
              >
                {!isRead && (
                  <span className="absolute top-4 right-4 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-rose-600"></span>
                  </span>
                )}

                <div className="flex items-start gap-3">
                  {n.priority === "urgent" ? (
                    <ShieldAlert className="h-6 w-6 text-rose-600 shrink-0 mt-0.5" />
                  ) : n.priority === "warning" ? (
                    <AlertCircle className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
                  ) : (
                    <Megaphone className="h-6 w-6 text-primary shrink-0 mt-0.5" />
                  )}

                  <div className="space-y-1.5 flex-1 pr-6">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-extrabold text-base text-primary">{n.title}</h3>
                      <span
                        className={`px-2.5 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-wider ${
                          n.priority === "urgent"
                            ? "bg-rose-500/10 text-rose-600 border border-rose-500/20"
                            : n.priority === "warning"
                              ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20"
                              : "bg-primary/10 text-primary border border-primary/20"
                        }`}
                      >
                        {n.priority}
                      </span>
                    </div>

                    <p className="text-sm text-foreground leading-relaxed font-medium">
                      {n.message}
                    </p>

                    <div className="pt-2 flex items-center justify-between text-xs text-muted-foreground font-mono">
                      <span>
                        To {employee?.name || "you"} · Posted by {n.authorName}
                      </span>
                      <span>{format(new Date(n.createdAt), "MMMM d, yyyy · hh:mm a")}</span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}

        {hasOlderNotices && !showAllHistory && (
          <div className="flex justify-center pt-4">
            <button
              onClick={() => setShowAllHistory(true)}
              className="btn-lift rounded-lg border bg-card px-5 py-2.5 text-xs font-bold text-primary hover:bg-secondary flex items-center gap-1.5 shadow-sm"
            >
              <ChevronDown className="h-4 w-4" /> See More (Load Older Notifications)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
