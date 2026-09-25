import { attendanceNow } from "./attendance-clock";
import { useAppRuntime } from "./app-runtime";
import { useEffect, useRef } from "react";
import { doc, setDoc, Timestamp } from "firebase/firestore";
import { toast } from "sonner";
import { db } from "./firebase";
import {
  formatInTimezone,
  getShiftTimeout,
  getShiftTimezone,
  zonedDateKey,
} from "./attendance";
import {
  cleanFirestoreData,
  indexPunchesByEmployee,
  getIndexedEmployeePunches,
  getEmployeeCompanyIds,
  getEmployeeForCompany,
  getPunchCompanyId,
  getRequiredWorkMinutes,
  normalizeCompanyId,
} from "./company-context";
import { toDate, toMillis } from "./time";
import type { Company, Employee, Punch } from "./types";
import {
  activePunchesInOrder,
  isSettled,
  listOf,
  useCompaniesLive,
  useEmployeePunchesLive,
  useEmployeesLive,
  useRecentPunchesLive,
} from "./live-data";
import { sessionCloseId } from "./punch-session";
import { autoCloseSession } from "./punch-writes";

const RECONCILE_INTERVAL_MS = 15_000;

/**
 * A close the database turned away (someone already closed or changed the
 * shift) is not tried again for a while. The live punches normally catch up in
 * a second; if they never show the reason, retrying every 15 seconds would
 * spend reads all day for nothing.
 */
const DECLINED_RETRY_MS = 10 * 60_000;
const declinedCloses = new Map<string, number>();

export async function reconcileEmployeeShift(
  employee: Employee,
  punches: Punch[],
  company: Company | null | undefined,
  activeCompanyId: string,
  announceToCurrentUser: boolean,
  companies: Company[] = [],
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

      const recordId = sessionCloseId(sessionIn.id);
      const noticeRef = doc(db(), "notices", recordId);
      const requiredWorkMinutes = getRequiredWorkMinutes(cCompanyEmployee, company);
      const autoReason = subsequentOtherPunch ? "switch_company" : "forgot_punch_out";
      // The close is filed under the shift it ends. The UTC date used to put a
      // switch made early in an Asian morning on the previous day.
      const attendanceDate =
        sessionIn.attendanceDate ||
        sessionIn.date ||
        timeout?.shift.dateKey ||
        zonedDateKey(punchedInAt, getShiftTimezone(cCompanyEmployee));
      const companyName =
        companies.find((item) => normalizeCompanyId(item.id) === cId)?.name ||
        sessionIn.companyName ||
        (cId === activeCompanyId ? company?.name : "") ||
        cId;

      const attemptKey = `${sessionIn.id}|${(sessionIn as Punch & { correctedAt?: string }).correctedAt || ""}|${autoReason}`;
      const declinedAt = declinedCloses.get(attemptKey);
      if (declinedAt !== undefined && attendanceNow().getTime() - declinedAt < DECLINED_RETRY_MS) {
        continue;
      }

      let created = false;
      try {
        // Checked against the saved shift: an employee's own clock-out, an
        // admin's correction or another device closing it first all win.
        created = await autoCloseSession({
          sessionInId: sessionIn.id,
          expected: {
            timestampMs: punchedInAt.getTime(),
            correctedAt: (sessionIn as Punch & { correctedAt?: string }).correctedAt,
          },
          nextPunchInId: subsequentOtherPunch?.id,
          stamp: attendanceNow().toISOString(),
          close: cleanFirestoreData({
            employeeId: sessionIn.employeeId || employee.id,
            employeeName: employee.name,
            companyId: cId,
            companyName,
            date: attendanceDate,
            attendanceDate,
            type: "out",
            timestamp: Timestamp.fromDate(autoOutDate),
            createdAt: attendanceNow().toISOString(),
            source: "auto",
            isAuto: true,
            autoReason,
            notes: subsequentOtherPunch
              ? `Auto punched out upon starting work in another company`
              : "Auto punched out at shift end",
            scheduledShiftStart:
              timeout?.shift.start.toISOString() || sessionIn.scheduledShiftStart,
            scheduledShiftEnd: timeout?.shift.end.toISOString() || sessionIn.scheduledShiftEnd,
            shiftTimezone: timeout?.shift.timezone || sessionIn.shiftTimezone,
            requiredWorkMinutes,
            normalWorkMinutes: requiredWorkMinutes,
            overtimeMinutes: 0,
            totalEligibleMinutes: requiredWorkMinutes,
            attendanceStatus: "complete",
          }),
        });
        if (!created) declinedCloses.set(attemptKey, attendanceNow().getTime());
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
  // The same punches the punch page shows, so both judge the same shift.
  const punchesLive = useEmployeePunchesLive(ready ? employee : null);
  // Never act on the local cache or on our own unconfirmed writes.
  const punches = isSettled(punchesLive) ? punchesLive.data : undefined;
  const reconcilingRef = useRef(false);

  useEffect(() => {
    if (!employee || !ready || !punches) return;

    const activeEmployee = employee;
    const ordered = activePunchesInOrder(punches);
    let active = true;

    async function reconcile() {
      if (!active || reconcilingRef.current) return;

      reconcilingRef.current = true;
      try {
        await reconcileEmployeeShift(
          activeEmployee,
          ordered,
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

    void reconcile();
    const interval = window.setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeCompanyId, company, employee, ready, punches]);
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
  const watching = enabled && ready;
  // Forgotten punch-outs are closed within hours, so the recent window the
  // dashboard already reads is enough; sharing it keeps both in step.
  const employeesLive = useEmployeesLive(watching);
  const punchesLive = useRecentPunchesLive(undefined, watching);
  const companiesLive = useCompaniesLive(watching);
  const settled = isSettled(employeesLive, punchesLive);
  const employees = settled ? employeesLive.data : undefined;
  const punches = settled ? punchesLive.data : undefined;
  const companies = listOf(companiesLive);
  const reconcilingRef = useRef(false);

  useEffect(() => {
    if (!watching || !employees || !punches) return;

    let active = true;
    const punchesByEmployee = indexPunchesByEmployee(activePunchesInOrder(punches));
    const uniqueEmployees = new Map<string, Employee>();
    for (const employee of employees) {
      const identity = employee.authUid || employee.id;
      const current = uniqueEmployees.get(identity);
      if (!current || employee.id === identity) uniqueEmployees.set(identity, employee);
    }

    async function reconcileAll() {
      if (!active || reconcilingRef.current) return;
      reconcilingRef.current = true;
      try {
        await Promise.allSettled(
          [...uniqueEmployees.values()].map((employee) => {
            const employeePunches = getIndexedEmployeePunches(punchesByEmployee, employee);
            return reconcileEmployeeShift(
              employee,
              employeePunches,
              company,
              activeCompanyId,
              false,
              companies,
            );
          }),
        );
      } finally {
        reconcilingRef.current = false;
      }
    }

    void reconcileAll();
    const interval = window.setInterval(() => void reconcileAll(), RECONCILE_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeCompanyId, company, companies, employees, punches, watching]);
}
