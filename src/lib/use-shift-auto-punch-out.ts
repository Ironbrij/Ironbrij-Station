import { useEffect, useRef } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  Timestamp,
  where,
} from "firebase/firestore";
import { toast } from "sonner";
import { db } from "./firebase";
import { formatInTimezone, getShiftTimeout } from "./attendance";
import type { Employee, Punch } from "./types";

const RECONCILE_INTERVAL_MS = 10_000;

function timeoutDocumentId(punchId: string) {
  return `shift-timeout-${encodeURIComponent(punchId)}`;
}

async function reconcileEmployeeShift(
  employee: Employee,
  punches: Punch[],
  announceToCurrentUser: boolean,
) {
  const latest = punches.at(-1);
  if (!latest?.timestamp || latest.type !== "in") return false;

  const timeout = getShiftTimeout(employee, latest.timestamp.toDate(), new Date());
  if (!timeout) return false;

  const recordId = timeoutDocumentId(latest.id);
  const punchRef = doc(db(), "punches", recordId);
  const noticeRef = doc(db(), "notices", recordId);
  const created = await runTransaction(db(), async (transaction) => {
    const existingPunch = await transaction.get(punchRef);
    if (existingPunch.exists()) return false;

    transaction.set(punchRef, {
      employeeId: latest.employeeId,
      employeeName: employee.name,
      date: timeout.shift.dateKey,
      type: "out",
      timestamp: Timestamp.fromDate(timeout.punchOutAt),
      source: "auto",
      isAuto: true,
      autoReason: "shift_timeout",
    });
    transaction.set(noticeRef, {
      title: "Automatically punched out",
      message: `You completed your full scheduled shift and were automatically punched out at ${formatInTimezone(
        timeout.punchOutAt,
        timeout.shift.timezone,
      )}. Time Station stops regular time after the full shift duration has been worked. Use Extra Time for approved additional work.`,
      priority: "warning",
      targetType: "employee",
      targetEmployeeId: employee.id,
      createdAt: new Date().toISOString(),
      authorName: "Time Station",
    });
    return true;
  });

  if (created && announceToCurrentUser) {
    toast.warning(
      `Full shift completed — you were automatically punched out at ${formatInTimezone(
        timeout.punchOutAt,
        timeout.shift.timezone,
      )}.`,
      { duration: 7000 },
    );
  }

  return created;
}

export function useShiftAutoPunchOut(employee: Employee | null) {
  const punchesRef = useRef<Punch[]>([]);
  const reconcilingRef = useRef(false);

  useEffect(() => {
    if (!employee) return;

    const activeEmployee = employee;
    let active = true;

    async function reconcile() {
      if (!active || reconcilingRef.current) return;

      reconcilingRef.current = true;
      try {
        await reconcileEmployeeShift(activeEmployee, punchesRef.current, active);
      } catch (error) {
        console.error("Shift auto punch-out failed:", error);
      } finally {
        reconcilingRef.current = false;
      }
    }

    const punchesQuery = query(
      collection(db(), "punches"),
      where("employeeId", "==", activeEmployee.id),
    );
    const unsubscribe = onSnapshot(
      punchesQuery,
      (snapshot) => {
        punchesRef.current = snapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) }))
          .filter((punch) => punch.timestamp)
          .sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
        void reconcile();
      },
      (error) => console.error("Auto punch-out punch snapshot failed:", error),
    );
    const interval = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [employee]);
}

export function useCompanyShiftAutoPunchOut(enabled: boolean) {
  const employeesRef = useRef<Employee[]>([]);
  const companyPunchesRef = useRef<Punch[]>([]);
  const reconcilingRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    let active = true;

    async function reconcileAll() {
      if (!active || reconcilingRef.current) return;
      reconcilingRef.current = true;
      try {
        const punches = companyPunchesRef.current;
        const uniqueEmployees = new Map<string, Employee>();
        for (const employee of employeesRef.current) {
          const identity = employee.authUid || employee.id;
          const current = uniqueEmployees.get(identity);
          if (!current || employee.id === identity) uniqueEmployees.set(identity, employee);
        }
        await Promise.allSettled(
          [...uniqueEmployees.values()].map((employee) => {
            const employeeIds = new Set(
              [employee.id, employee.authUid].filter((value): value is string => Boolean(value)),
            );
            const employeePunches = punches.filter((punch) => employeeIds.has(punch.employeeId));
            return reconcileEmployeeShift(employee, employeePunches, false);
          }),
        );
      } finally {
        reconcilingRef.current = false;
      }
    }

    const unsubscribeEmployees = onSnapshot(
      collection(db(), "employees"),
      (snapshot) => {
        employeesRef.current = snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Employee, "id">),
        }));
        void reconcileAll();
      },
      (error) => console.error("Company auto punch-out employee snapshot failed:", error),
    );
    const unsubscribePunches = onSnapshot(
      collection(db(), "punches"),
      (snapshot) => {
        companyPunchesRef.current = snapshot.docs
          .map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) }))
          .filter((punch) => punch.timestamp)
          .sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
        void reconcileAll();
      },
      (error) => console.error("Company auto punch-out punch snapshot failed:", error),
    );
    const interval = window.setInterval(() => void reconcileAll(), RECONCILE_INTERVAL_MS);

    return () => {
      active = false;
      unsubscribeEmployees();
      unsubscribePunches();
      window.clearInterval(interval);
    };
  }, [enabled]);
}
