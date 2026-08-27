import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { COMPANY_ID, type Company, type Employee, type LeaveRequest, type OvertimeRequest } from "./types";
import { useAdminLateNotificationCount } from "./use-admin-late-notification-count";

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
  const [overtimeRequests, setOvertimeRequests] = useState<OvertimeRequest[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const unreadLateCount = useAdminLateNotificationCount({ enabled: Boolean(isAdmin), company });

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Overtime Requests Listener
    unsubscribers.push(
      onSnapshot(collection(db(), "overtimeRequests"), (snapshot) => {
        setOvertimeRequests(
          snapshot.docs.map((doc) => ({
            id: doc.id,
            ...(doc.data() as Omit<OvertimeRequest, "id">),
          })),
        );
      }),
    );

    // Leave Requests Listener
    unsubscribers.push(
      onSnapshot(collection(db(), "leaveRequests"), (snapshot) => {
        setLeaveRequests(
          snapshot.docs.map((doc) => ({
            id: doc.id,
            ...(doc.data() as Omit<LeaveRequest, "id">),
          })),
        );
      }),
    );

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, []);

  return useMemo(() => {
    const badges: Record<string, number> = {};

    if (isAdmin) {
      // 1. Pending Overtime Approvals
      const pendingOvertime = overtimeRequests.filter((r) => {
        if (r.status !== "pending") return false;
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
  }, [isAdmin, employee, activeCompanyId, overtimeRequests, leaveRequests, unreadLateCount]);
}
