import { useEffect, useRef } from "react";
import type { User } from "firebase/auth";
import { doc, runTransaction, updateDoc } from "firebase/firestore";
import { db } from "./firebase";
import { activePunchesInOrder, useEmployeePunchesLive } from "./live-data";
import { calculateAttendanceSession, isPunchOutReminderDue } from "./attendance-calculation";
import { getPunchCompanyId } from "./company-context";
import { companyEmailBranding } from "./email-branding";
import type { Company, Employee, Punch } from "./types";
import { toDate, toMillis } from "./time";

const REMINDER_CHECK_INTERVAL_MS = 60_000;

export function usePunchOutReminder({
  user,
  employee,
  company,
  activeCompanyId,
}: {
  user: User | null;
  employee: Employee | null;
  company: Company | null;
  activeCompanyId: string;
}) {
  const punchesRef = useRef<Punch[]>([]);
  const processingRef = useRef(false);
  // The same live punches the punch page shows, under either of the ids.
  const punchesData = useEmployeePunchesLive(user && company ? employee : null).data;

  useEffect(() => {
    if (!user || !employee || !company) return;
    let active = true;
    punchesRef.current = activePunchesInOrder(punchesData ?? []);

    async function checkReminder() {
      if (!active || processingRef.current || !user || !employee || !company) return;
      const companyPunches = punchesRef.current.filter(
        (punch) => getPunchCompanyId(punch, employee) === activeCompanyId,
      );
      const latestRegularPunch = [...companyPunches]
        .reverse()
        .find((punch) => punch.type === "in" || punch.type === "out");
      if (latestRegularPunch?.type !== "in" || !latestRegularPunch.timestamp) return;
      const punchIn = toDate(latestRegularPunch.timestamp);
      if (!punchIn) return;
      if (
        !isPunchOutReminderDue({
          employee,
          punchIn,
          reminderMinutes: company.punchOutReminderMinutes ?? 20,
        })
      ) {
        return;
      }

      processingRef.current = true;
      const reminderId = `${employee.id}__punch-out__${latestRegularPunch.id}`;
      const reminderRef = doc(db(), "attendanceReminders", reminderId);
      try {
        const calculation = calculateAttendanceSession({
          employee,
          company,
          punchIn,
        });
        const claimed = await runTransaction(db(), async (transaction) => {
          const existing = await transaction.get(reminderRef);
          if (existing.exists()) return false;
          transaction.set(reminderRef, {
            employeeId: employee.id,
            companyId: activeCompanyId,
            punchInId: latestRegularPunch.id,
            attendanceDate: calculation.attendanceDate,
            shiftEndAt: calculation.scheduledShiftEnd.toISOString(),
            status: "pending",
            createdAt: new Date().toISOString(),
          });
          return true;
        });
        if (!claimed) return;

        const idToken = await user.getIdToken();
        const response = await fetch("/api/punch-out-reminder", {
          method: "POST",
          headers: {
            authorization: `Bearer ${idToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            reminderId,
            employeeId: employee.id,
            employeeName: employee.name,
            employeeEmail: employee.email,
            companyId: activeCompanyId,
            company: companyEmailBranding(company, activeCompanyId),
            attendanceDate: calculation.attendanceDate,
            shiftEndAt: calculation.scheduledShiftEnd.toISOString(),
            shiftTimezone: employee.shiftTimezone || employee.timezone,
          }),
        });
        await updateDoc(
          reminderRef,
          response.ok
            ? { status: "sent", sentAt: new Date().toISOString() }
            : { status: "failed", error: `HTTP ${response.status}` },
        );
      } catch (error) {
        await updateDoc(reminderRef, {
          status: "failed",
          error: (error as Error).message.slice(0, 500),
        }).catch(() => {});
      } finally {
        processingRef.current = false;
      }
    }

    void checkReminder();
    const interval = window.setInterval(() => void checkReminder(), REMINDER_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeCompanyId, company, employee, user, punchesData]);
}
