import { useEffect, useMemo, useState } from "react";
import {
  COMPANY_ID,
  type Company,
  type Employee,
  type LeaveRequest,
  type OvertimeRequest,
} from "./types";
import { useAdminLateNotificationCount } from "./use-admin-late-notification-count";
import { listOf, useEmployeeLeavesLive, useWhereEqualLive } from "./live-data";

function readLastSeenOvertime() {
  try {
    return Number(localStorage.getItem("lastSeenOvertime")) || 0;
  } catch {
    return 0;
  }
}

export function useNavigationBadgeCounts({
  isAdmin,
  employee,
  company,
  activeCompanyId,
}: {
  isAdmin?: boolean;
  employee: Employee | null;
  company: Company | null;
  activeCompanyId: string;
}): Record<string, number> {
  const [lastSeenOvertime, setLastSeenOvertime] = useState(readLastSeenOvertime);
  const unreadLateCount = useAdminLateNotificationCount({ enabled: Boolean(isAdmin), company });
  // Shared live reads: a decision made on the Leave or Overtime page moves the
  // badge at once. Admins need only what is pending, not the whole history;
  // employee navigation needs only their own leave requests, never
  // company-wide admin data.
  const overtimeRequests = listOf(
    useWhereEqualLive<OvertimeRequest>("overtimeRequests", "status", isAdmin ? "pending" : null),
  );
  const pendingLeaves = listOf(
    useWhereEqualLive<LeaveRequest>("leaveRequests", "status", isAdmin ? "pending" : null),
  );
  const ownLeaves = listOf(useEmployeeLeavesLive(isAdmin ? null : employee));
  const leaveRequests: LeaveRequest[] = isAdmin ? pendingLeaves : ownLeaves;

  useEffect(() => {
    const syncSeen = () => setLastSeenOvertime(readLastSeenOvertime());
    window.addEventListener("storage", syncSeen);
    window.addEventListener("OVERTIME_SEEN", syncSeen);
    return () => {
      window.removeEventListener("storage", syncSeen);
      window.removeEventListener("OVERTIME_SEEN", syncSeen);
    };
  }, []);

  return useMemo(() => {
    const badges: Record<string, number> = {};

    if (isAdmin) {
      // 1. Pending Overtime Approvals
      const pendingOvertime = overtimeRequests.filter((r) => {
        if (r.status !== "pending") return false;
        const createdTime = new Date(r.createdAt || 0).getTime();
        if (createdTime <= lastSeenOvertime) return false;

        if (activeCompanyId && activeCompanyId !== "all" && activeCompanyId !== COMPANY_ID) {
          return r.companyId === activeCompanyId;
        }
        return true;
      });
      badges["/admin/overtime"] = pendingOvertime.length;

      // 2. Pending Leave Approvals
      const pendingLeaves = leaveRequests.filter((l) => {
        if (l.status !== "pending") return false;
        if (activeCompanyId && activeCompanyId !== "all" && activeCompanyId !== COMPANY_ID) {
          return l.companyId === activeCompanyId;
        }
        return true;
      });
      badges["/admin/leaves"] = pendingLeaves.length;

      // 3. Late Logs & Punctuality
      badges["/admin/late"] = unreadLateCount;

      // 4. Notifications & Alerts
      badges["/admin/notices"] = unreadLateCount;
    } else if (employee) {
      // Employee portal badges
      const myEmployeeIds = new Set([employee.id, employee.authUid].filter(Boolean));

      // Pending Leaves for this employee
      const myPendingLeaves = leaveRequests.filter(
        (l) => myEmployeeIds.has(l.employeeId) && l.status === "pending",
      );
      badges["/app/leave"] = myPendingLeaves.length;
    }

    return badges;
  }, [
    isAdmin,
    employee,
    activeCompanyId,
    overtimeRequests,
    leaveRequests,
    unreadLateCount,
    lastSeenOvertime,
  ]);
}
