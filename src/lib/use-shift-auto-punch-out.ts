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
import {
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
} from "./company-context";
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
  const companyIds = getEmployeeCompanyIds(employee);
  let anyCreated = false;

  for (const cId of companyIds) {
    const cCompanyEmployee = getEmployeeForCompany(employee, cId);
    const companyPunches = punches.filter((punch) => getPunchCompanyId(punch, employee) === cId);
    const latest = companyPunches.at(-1);
    if (
      !latest?.timestamp ||
      (latest.type !== "in" && latest.type !== "lunch_start" && latest.type !== "lunch_end")
    ) {
      continue;
    }

    const punchedInAt = toDate(latest.timestamp);
    if (!punchedInAt) continue;

    // Check if there was a subsequent punch in ANY OTHER company after this punch-in
    const subsequentOtherPunch = punches.find((p) => {
      if (getPunchCompanyId(p, employee) === cId) return false;
      const pTime = toDate(p.timestamp);
      return pTime && pTime.getTime() > punchedInAt.getTime();
    });

    const timeout = getShiftTimeout(cCompanyEmployee, punchedInAt, new Date(), 0);

    if (subsequentOtherPunch || timeout) {
      const autoOutDate = subsequentOtherPunch
        ? toDate(subsequentOtherPunch.timestamp) || new Date()
        : timeout?.shift.end || timeout?.punchOutAt || new Date();

      const recordId = timeoutDocumentId(latest.id);
      const punchRef = doc(db(), "punches", recordId);
      const noticeRef = doc(db(), "notices", recordId);
      const requiredWorkMinutes = getRequiredWorkMinutes(cCompanyEmployee, company);
      const autoReason = subsequentOtherPunch ? "switch_company" : "forgot_punch_out";

      const created = await runTransaction(db(), async (transaction) => {
        const existingPunch = await transaction.get(punchRef);
        if (existingPunch.exists()) return false;

        transaction.set(punchRef, {
          employeeId: employee.id,
          employeeName: employee.name,
          companyId: cId,
          companyName: cId === activeCompanyId ? company?.name || "Company" : cId,
          date: timeout?.shift.dateKey || new Date().toISOString().slice(0, 10),
          attendanceDate: timeout?.shift.dateKey || new Date().toISOString().slice(0, 10),
          type: "out",
          timestamp: Timestamp.fromDate(autoOutDate),
          source: "auto",
          isAuto: true,
          autoReason,
          notes: subsequentOtherPunch
            ? `Auto punched out upon starting work in another company`
            : "Auto punched out at shift end",
          scheduledShiftStart: timeout?.shift.start.toISOString(),
          scheduledShiftEnd: timeout?.shift.end.toISOString(),
          shiftTimezone: timeout?.shift.timezone,
          requiredWorkMinutes,
          normalWorkMinutes: requiredWorkMinutes,
          overtimeMinutes: 0,
          totalEligibleMinutes: requiredWorkMinutes,
          attendanceStatus: "complete",
        });

        if (!subsequentOtherPunch && timeout) {
          transaction.set(noticeRef, {
            title: "We think you forgot to punch out",
            message: `You remained clocked in past your scheduled shift, so SavyTimes automatically clocked you out at ${formatInTimezone(
              autoOutDate,
              timeout.shift.timezone,
            )} to preserve accurate shift records. If you worked overtime, your extra hours can be approved by your admin in the Overtime tab.`,
            priority: "info",
            targetType: "employee",
            targetEmployeeId: employee.id,
            companyId: cId,
            createdAt: new Date().toISOString(),
            authorName: "SavyTimes",
          });
        }

        return true;
      });

      if (created) {
        anyCreated = true;
        if (announceToCurrentUser && cId === activeCompanyId && !subsequentOtherPunch) {
          toast.info("Shift ended: You were automatically clocked out.", {
            description: "Shift period concluded.",
            duration: 8000,
          });
        }
      }
    }
  }

  return anyCreated;
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
