import { attendanceNow } from "./attendance-clock";
import { useAppRuntime } from "./app-runtime";
import { useEffect, useRef } from "react";
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  Timestamp,
  where,
} from "firebase/firestore";
import { toast } from "sonner";
import { auth, db } from "./firebase";
import { formatInTimezone, getShiftTimeout } from "./attendance";
import {
  cleanFirestoreData,
  indexPunchesByEmployee,
  getIndexedEmployeePunches,
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
  punches = punches.filter((punch) => !punch.voidedAt);
  const companyIds = getEmployeeCompanyIds(employee);
  let anyCreated = false;

  for (const cId of companyIds) {
    const cCompanyEmployee = getEmployeeForCompany(employee, cId);
    const companyPunches = punches
      .filter((punch) => getPunchCompanyId(punch, employee) === cId)
      .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
    const latest = companyPunches.at(-1);
    if (
      !latest?.timestamp ||
      (latest.type !== "in" && latest.type !== "lunch_start" && latest.type !== "lunch_end")
    ) {
      continue;
    }

    // Lunch punches pause the original session; they do not start a new shift.
    const sessionIn = [...companyPunches]
      .reverse()
      .find(
        (punch) =>
          punch.type === "in" ||
          punch.type === "out" ||
          punch.type === "extra_in" ||
          punch.type === "extra_out",
      );
    if (sessionIn?.type !== "in") continue;
    const punchedInAt = toDate(sessionIn.timestamp);
    if (!punchedInAt) continue;

    // Only a new start transfers work to another company. A delayed out or
    // break from the old company must not close the newly started shift.
    const subsequentOtherPunch = punches
      .filter((p) => {
        if (p.type !== "in" && p.type !== "extra_in") return false;
        if (getPunchCompanyId(p, employee) === cId) return false;
        const pTime = toDate(p.timestamp);
        return pTime && pTime.getTime() > punchedInAt.getTime();
      })
      .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))[0];

    const timeout = getShiftTimeout(cCompanyEmployee, punchedInAt, attendanceNow(), 0, companyPunches);

    if (subsequentOtherPunch || timeout) {
      const autoOutDate = subsequentOtherPunch
        ? toDate(subsequentOtherPunch.timestamp) || attendanceNow()
        : timeout!.punchOutAt;

      const recordId = timeoutDocumentId(sessionIn.id);
      const punchRef = doc(db(), "punches", recordId);
      const noticeRef = doc(db(), "notices", recordId);
      const requiredWorkMinutes = getRequiredWorkMinutes(cCompanyEmployee, company);
      const autoReason = subsequentOtherPunch ? "switch_company" : "forgot_punch_out";

      let created = false;
      try {
        created = await runTransaction(db(), async (transaction) => {
          const existingPunch = await transaction.get(punchRef);
          const sourcePunch = await transaction.get(doc(db(), "punches", sessionIn.id));
          if (!sourcePunch.exists() || sourcePunch.data().voidedAt ||
              (sourcePunch.data().correctedAt || "") !== ((sessionIn as Punch & { correctedAt?: string }).correctedAt || "") ||
              toMillis(sourcePunch.data().timestamp) !== punchedInAt.getTime()) return false;
          if (existingPunch.exists() && !existingPunch.data().voidedAt) return false;

          transaction.set(
            punchRef,
            cleanFirestoreData({
              employeeId: employee.id,
              employeeName: employee.name,
              companyId: cId,
              companyName: cId === activeCompanyId ? company?.name || "Company" : cId,
              date: timeout?.shift.dateKey || attendanceNow().toISOString().slice(0, 10),
              attendanceDate: timeout?.shift.dateKey || attendanceNow().toISOString().slice(0, 10),
              type: "out",
              punchInId: sessionIn.id,
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
            }),
          );

          return true;
        });
      } catch (txError) {
        console.error("Shift auto punch-out transaction failed:", txError);
      }

      if (created) {
        anyCreated = true;

        if (!subsequentOtherPunch && timeout) {
          try {
            await setDoc(
              noticeRef,
              cleanFirestoreData({
                title: "We think you forgot to punch out",
                message: `You remained clocked in past your scheduled shift, so SavyTimes automatically clocked you out at ${formatInTimezone(
                  autoOutDate,
                  timeout.shift.timezone,
                )} to preserve accurate shift records. If you worked overtime, your extra hours can be approved by your admin in the Overtime tab.`,
                priority: "info",
                targetType: "employee",
                targetEmployeeId: employee.id,
                companyId: cId,
                createdAt: attendanceNow().toISOString(),
                authorName: "SavyTimes",
              }),
            );
          } catch (noticeError) {
            console.warn("Failed to create auto punch-out notice:", noticeError);
          }
        }

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
  const { ready } = useAppRuntime();
  const punchesRef = useRef<Punch[]>([]);
  const reconcilingRef = useRef(false);

  useEffect(() => {
    if (!employee || !ready) return;

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

    const employeeIds = Array.from(
      new Set([activeEmployee.id, activeEmployee.authUid].filter((v): v is string => Boolean(v))),
    );
    const punchesQuery =
      employeeIds.length > 1
        ? query(collection(db(), "punches"), where("employeeId", "in", employeeIds))
        : query(collection(db(), "punches"), where("employeeId", "==", activeEmployee.id));
    const unsubscribe = onSnapshot(
      punchesQuery,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) { punchesRef.current = []; return; }
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
  }, [activeCompanyId, company, employee, ready]);
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
  const { ready } = useAppRuntime();
  const employeesRef = useRef<Employee[]>([]);
  const companyPunchesRef = useRef<Punch[]>([]);
  const reconcilingRef = useRef(false);

  useEffect(() => {
    if (!enabled || !ready) return;

    let active = true;
    let employeesReady = false;

    async function reconcileAll() {
      if (!active || !employeesReady || reconcilingRef.current) return;
      reconcilingRef.current = true;
      try {
        const punchesByEmployee = indexPunchesByEmployee(companyPunchesRef.current);
        const uniqueEmployees = new Map<string, Employee>();
        for (const employee of employeesRef.current) {
          const identity = employee.authUid || employee.id;
          const current = uniqueEmployees.get(identity);
          if (!current || employee.id === identity) uniqueEmployees.set(identity, employee);
        }
        await Promise.allSettled(
          [...uniqueEmployees.values()].map((employee) => {
            const employeePunches = getIndexedEmployeePunches(punchesByEmployee, employee);
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
      { includeMetadataChanges: true },
      (snapshot) => {
        employeesReady = !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites;
        if (!employeesReady) return;
        employeesRef.current = snapshot.docs.map((item) => ({
          ...(item.data() as Omit<Employee, "id">),
          id: item.id,
        }));
        void reconcileAll();
      },
      (error) => console.error("Company auto punch-out employee snapshot failed:", error),
    );
    const unsubscribePunches = onSnapshot(
      collection(db(), "punches"),
      { includeMetadataChanges: true },
      (snapshot) => {
        if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) { companyPunchesRef.current = []; return; }
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
  }, [activeCompanyId, company, enabled, ready]);
}
