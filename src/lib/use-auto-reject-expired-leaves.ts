import { useEffect, useRef } from "react";
import { doc, runTransaction } from "firebase/firestore";
import { getEmployeeTimezone, zonedDateKey } from "./attendance";
import { db } from "./firebase";
import { isSettled, useEmployeesLive, useWhereEqualLive } from "./live-data";
import type { CompanyNotice, Employee, LeaveRequest } from "./types";
import { ymd } from "./time";

const AUTO_REJECTION_REASON = "The request was not reviewed before its leave start date.";

export function useAutoRejectExpiredLeaves(enabled: boolean) {
  // Shared live reads; only a server-confirmed list is acted on, and the
  // transaction below re-checks each request before rejecting it.
  const employeesLive = useEmployeesLive(enabled);
  // The same pending-only query the navigation badge reads.
  const leavesLive = useWhereEqualLive<LeaveRequest>("leaveRequests", "status", enabled ? "pending" : null);
  const settled = isSettled(employeesLive, leavesLive);
  const employees = settled ? employeesLive.data : undefined;
  const leaves = settled ? leavesLive.data : undefined;
  const processingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled || !employees || !leaves) return;
    const processing = processingRef.current;
    const currentEmployees = employees;
    const pending = leaves.filter((leave) => leave.status === "pending");

    function processExpiredRequests() {
      const now = new Date();
      const expiredRequests = pending.filter((leave) => {
        if (processing.has(leave.id)) return false;
        const employee = currentEmployees.find(
          (item) => item.id === leave.employeeId || item.authUid === leave.employeeId,
        );
        const today = employee ? zonedDateKey(now, getEmployeeTimezone(employee)) : ymd(now);
        return leave.dateFrom <= today;
      });

      for (const leave of expiredRequests) {
        processing.add(leave.id);
        void autoRejectLeave(leave, currentEmployees)
          .catch((error) => {
            console.error("Could not automatically reject expired leave request", error);
          })
          .finally(() => {
            processing.delete(leave.id);
          });
      }
    }

    processExpiredRequests();
    const timer = window.setInterval(processExpiredRequests, 60000);
    return () => window.clearInterval(timer);
  }, [enabled, employees, leaves]);
}

async function autoRejectLeave(leave: LeaveRequest, employees: Employee[]) {
  const employee = employees.find(
    (item) => item.id === leave.employeeId || item.authUid === leave.employeeId,
  );
  const leaveRef = doc(db(), "leaveRequests", leave.id);
  const noticeRef = doc(db(), "notices", `leave-auto-rejected-${leave.id}`);

  await runTransaction(db(), async (transaction) => {
    const currentSnapshot = await transaction.get(leaveRef);
    if (!currentSnapshot.exists()) return;

    const current = currentSnapshot.data() as Omit<LeaveRequest, "id">;
    if (current.status !== "pending") return;

    const decidedAt = new Date().toISOString();
    transaction.update(leaveRef, {
      status: "rejected",
      decidedAt,
      decidedBy: "Automatic leave rule",
      decisionSource: "automatic",
      decisionReason: AUTO_REJECTION_REASON,
    });

    if (!employee) return;

    const dateRange =
      current.dateFrom === current.dateTo
        ? current.dateFrom
        : `${current.dateFrom} to ${current.dateTo}`;
    const notice: Omit<CompanyNotice, "id"> = {
      title: "Leave request automatically rejected",
      message: `Your leave request for ${dateRange} was not reviewed before the start date, so it was automatically rejected.`,
      priority: "warning",
      targetType: "employee",
      targetEmployeeId: employee.id,
      targetEmployeeIds: [employee.id],
      createdAt: decidedAt,
      authorName: "Automatic leave rule",
    };
    transaction.set(noticeRef, notice);
  });
}
