import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { db } from "./firebase";
import {
  COMPANY_ID,
  type Company,
  type Employee,
  type LeaveRequest,
  type OvertimeRequest,
} from "./types";
import { useAdminLateNotificationCount } from "./use-admin-late-notification-count";

function readLastSeenOvertime() {
  try { return Number(localStorage.getItem("lastSeenOvertime")) || 0; } catch { return 0; }
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
  const [overtimeRequests, setOvertimeRequests] = useState<OvertimeRequest[]>([]);
  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>([]);
  const [lastSeenOvertime, setLastSeenOvertime] = useState(readLastSeenOvertime);
  const unreadLateCount = useAdminLateNotificationCount({ enabled: Boolean(isAdmin), company });

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    setOvertimeRequests([]);
    setLeaveRequests([]);
    // Employee navigation needs only their leave requests, never company-wide admin data.
    if (isAdmin) {
      unsubscribers.push(onSnapshot(query(collection(db(), "overtimeRequests"), where("status", "==", "pending")), (snapshot) => {
        setOvertimeRequests(snapshot.docs.map((item) => ({ ...item.data(), id: item.id } as OvertimeRequest)));
      }));
    }
    const employeeIds = Array.from(new Set([employee?.id, employee?.authUid].filter((id): id is string => Boolean(id))));
    if (isAdmin || employeeIds.length) {
      const leavesQuery = isAdmin
        ? query(collection(db(), "leaveRequests"), where("status", "==", "pending"))
        : query(collection(db(), "leaveRequests"), where("employeeId", employeeIds.length > 1 ? "in" : "==", employeeIds.length > 1 ? employeeIds : employeeIds[0]));
      unsubscribers.push(onSnapshot(leavesQuery, (snapshot) => {
        setLeaveRequests(snapshot.docs.map((item) => ({ ...item.data(), id: item.id } as LeaveRequest)));
      }));
    }

    const syncSeen = () => setLastSeenOvertime(readLastSeenOvertime());
    window.addEventListener("storage", syncSeen);
    window.addEventListener("OVERTIME_SEEN", syncSeen);

    return () => {
      unsubscribers.forEach((unsub) => unsub());
      window.removeEventListener("storage", syncSeen);
      window.removeEventListener("OVERTIME_SEEN", syncSeen);
    };
  }, [isAdmin, employee?.id, employee?.authUid]);

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
  }, [isAdmin, employee, activeCompanyId, overtimeRequests, leaveRequests, unreadLateCount, lastSeenOvertime]);
}
