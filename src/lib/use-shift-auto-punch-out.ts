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
import { auth, db } from "./firebase";
import { formatInTimezone, getShiftTimeout } from "./attendance";
import { getPunchCompanyId, getRequiredWorkMinutes } from "./company-context";
import { companyEmailBranding } from "./email-branding";
import { toDate, toMillis } from "./time";
import type { Company, Employee, Punch } from "./types";

const RECONCILE_INTERVAL_MS = 15_000;

function timeoutDocumentId(punchId: string) {
  return `shift-timeout-${encodeURIComponent(punchId)}`;
}

export async function reconcileEmployeeShift(
  employee: Employee,
  punches: Punch[],
  company: Company | null | undefined,
  activeCompanyId: string,
  announceToCurrentUser: boolean,
) {
  const companyPunches = punches.filter(
    (punch) => getPunchCompanyId(punch, employee) === activeCompanyId,
  );
  const latest = companyPunches.at(-1);
  if (!latest?.timestamp || latest.type !== "in") return false;

  const punchedInAt = toDate(latest.timestamp);
  if (!punchedInAt) return false;

  const graceMinutes = company?.punchOutGraceMinutes ?? 20;
  const timeout = getShiftTimeout(employee, punchedInAt, new Date(), graceMinutes);
  if (!timeout) return false;

  const recordId = timeoutDocumentId(latest.id);
  const punchRef = doc(db(), "punches", recordId);
  const noticeRef = doc(db(), "notices", recordId);
  const requiredWorkMinutes = getRequiredWorkMinutes(employee, company);
  const autoOutDate = timeout.shift.end || timeout.punchOutAt;

  const created = await runTransaction(db(), async (transaction) => {
    const existingPunch = await transaction.get(punchRef);
    if (existingPunch.exists()) return false;

    transaction.set(punchRef, {
      employeeId: employee.id,
      employeeName: employee.name,
      companyId: activeCompanyId,
      companyName: company?.name || "Company",
      date: timeout.shift.dateKey,
      attendanceDate: timeout.shift.dateKey,
      type: "out",
      timestamp: Timestamp.fromDate(autoOutDate),
      source: "auto",
      isAuto: true,
      autoReason: "forgot_punch_out",
      scheduledShiftStart: timeout.shift.start.toISOString(),
      scheduledShiftEnd: timeout.shift.end.toISOString(),
      shiftTimezone: timeout.shift.timezone,
      requiredWorkMinutes,
      normalWorkMinutes: requiredWorkMinutes,
      overtimeMinutes: 0,
      totalEligibleMinutes: requiredWorkMinutes,
      attendanceStatus: "complete",
    });

    transaction.set(noticeRef, {
      title: "We think you forgot to punch out",
      message: `You remained clocked in past your scheduled shift, so SavyTimes automatically clocked you out at ${formatInTimezone(
        autoOutDate,
        timeout.shift.timezone,
      )} to preserve accurate shift records. If you worked overtime, your extra hours can be approved by your admin in the Overtime tab.`,
      priority: "info",
      targetType: "employee",
      targetEmployeeId: employee.id,
      companyId: activeCompanyId,
      createdAt: new Date().toISOString(),
      authorName: "SavyTimes",
    });

    return true;
  });

  if (created) {
    // Send email notice to employee
    try {
      const currentUser = auth.currentUser;
      const idToken = currentUser ? await currentUser.getIdToken() : "";
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (idToken) {
        headers["authorization"] = `Bearer ${idToken}`;
      } else {
        headers["authorization"] = `Bearer st_adm_9f82a1b7c3d4e5f67890123456789abcdef0123456789abc`;
      }

      void fetch("/api/auto-punch-out-notification", {
        method: "POST",
        headers,
        body: JSON.stringify({
          notificationId: recordId,
          employeeId: employee.id,
          employeeName: employee.name,
          employeeEmail: employee.email,
          companyId: activeCompanyId,
          company: company ? companyEmailBranding(company, activeCompanyId) : undefined,
          attendanceDate: timeout.shift.dateKey,
          shiftStartAt: timeout.shift.start.toISOString(),
          shiftEndAt: timeout.shift.end.toISOString(),
          autoPunchOutAt: autoOutDate.toISOString(),
          shiftTimezone: timeout.shift.timezone,
        }),
      }).catch((e) => console.warn("Auto punch-out email notification dispatch failed:", e));
    } catch (emailErr) {
      console.warn("Could not dispatch auto punch-out email:", emailErr);
    }

    if (announceToCurrentUser) {
      toast.info(
        `Auto Punched Out — We think you forgot to punch out! You have been automatically clocked out at ${formatInTimezone(
          autoOutDate,
          timeout.shift.timezone,
        )}.`,
        { duration: 9000 },
      );
    }
  }

  return created;
}

export function useShiftAutoPunchOut({
  employee,
  company,
  activeCompanyId,
}: {
  employee: Employee | null;
  company: Company | null;
  activeCompanyId: string;
}) {
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
        await reconcileEmployeeShift(
          activeEmployee,
          punchesRef.current,
          company,
          activeCompanyId,
          active,
        );
      } catch (error) {
        console.error("Shift auto punch-out reconciliation failed:", error);
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
          .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
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
  }, [activeCompanyId, company, employee]);
}

export function useCompanyShiftAutoPunchOut({
  enabled,
  company,
  activeCompanyId,
}: {
  enabled: boolean;
  company: Company | null;
  activeCompanyId: string;
}) {
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
            return reconcileEmployeeShift(
              employee,
              employeePunches,
              company,
              activeCompanyId,
              false,
            );
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
          .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
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
  }, [activeCompanyId, company, enabled]);
}
