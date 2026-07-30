import { useEffect, useRef } from "react";
import { collection, doc, onSnapshot, runTransaction } from "firebase/firestore";
import { getEmployeeTimezone, zonedDateKey } from "./attendance";
import { db } from "./firebase";
import type { CompanyNotice, Employee, LeaveRequest } from "./types";
import { ymd } from "./time";

const AUTO_REJECTION_REASON = "The request was not reviewed before its leave start date.";

export function useAutoRejectExpiredLeaves(enabled: boolean) {
  const employeesRef = useRef<Employee[]>([]);
  const employeesLoadedRef = useRef(false);
  const leavesRef = useRef<LeaveRequest[]>([]);
  const processingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) return;
    const processing = processingRef.current;

    function processExpiredRequests() {
      if (!employeesLoadedRef.current) return;
      const employees = employeesRef.current;
      const now = new Date();
      const expiredRequests = leavesRef.current.filter((leave) => {
        if (leave.status !== "pending" || processing.has(leave.id)) return false;
        const employee = employees.find(
          (item) => item.id === leave.employeeId || item.authUid === leave.employeeId,
        );
        const today = employee ? zonedDateKey(now, getEmployeeTimezone(employee)) : ymd(now);
        return leave.dateFrom <= today;
      });

      for (const leave of expiredRequests) {
        processing.add(leave.id);
        void autoRejectLeave(leave, employees)
          .catch((error) => {
            console.error("Could not automatically reject expired leave request", error);
          })
          .finally(() => {
            processing.delete(leave.id);
          });
      }
    }

    const unsubscribeEmployees = onSnapshot(collection(db(), "employees"), (snapshot) => {
      employeesRef.current = snapshot.docs.map((item) => ({
        id: item.id,
        ...(item.data() as Omit<Employee, "id">),
      }));
      employeesLoadedRef.current = true;
      processExpiredRequests();
    });

    const unsubscribeLeaves = onSnapshot(collection(db(), "leaveRequests"), (snapshot) => {
      leavesRef.current = snapshot.docs.map((item) => ({
        id: item.id,
        ...(item.data() as Omit<LeaveRequest, "id">),
      }));
      processExpiredRequests();
    });
    const timer = window.setInterval(processExpiredRequests, 60000);

    return () => {
      window.clearInterval(timer);
      unsubscribeEmployees();
      unsubscribeLeaves();
      employeesLoadedRef.current = false;
      leavesRef.current = [];
      processing.clear();
    };
  }, [enabled]);
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
