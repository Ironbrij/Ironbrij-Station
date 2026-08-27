import { useEffect, useRef } from "react";
import type { User } from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "./firebase";
import { getEmployeeBreakSettings, getPunchCompanyId } from "./company-context";
import { companyEmailBranding } from "./email-branding";
import type { Company, Employee, Punch } from "./types";
import { formatInTimezone, getShiftTimezone, zonedDateKey } from "./attendance";
import { toDate, toMillis } from "./time";

const BREAK_CHECK_INTERVAL_MS = 15_000; // Check every 15 seconds

export function useLunchBreakReminder({
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

  useEffect(() => {
    if (!user || !employee || !company) return;
    let active = true;

    async function checkBreakReminders() {
      if (!active || processingRef.current || !user || !employee || !company) return;
      const companyPunches = punchesRef.current.filter(
        (punch) => getPunchCompanyId(punch, employee) === activeCompanyId,
      );

      const latestPunch = companyPunches[companyPunches.length - 1];
      if (!latestPunch || latestPunch.type !== "lunch_start" || !latestPunch.timestamp) return;

      const lunchStartTime = toDate(latestPunch.timestamp);
      if (!lunchStartTime) return;

      const breakSettings = getEmployeeBreakSettings(employee, activeCompanyId);
      const allowedMinutes = breakSettings.allowanceMinutes;
      if (allowedMinutes <= 0 || breakSettings.maxDailyBreaks <= 0) return;

      const now = new Date();
      const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - lunchStartTime.getTime()) / 1000));
      const elapsedMinutes = Math.floor(elapsedSeconds / 60);

      const warningThresholdMinutes = Math.max(1, allowedMinutes - 5);
      const timezone = getShiftTimezone(employee);
      const attendanceDate = zonedDateKey(lunchStartTime, timezone);
      const breakStartedAt = formatInTimezone(lunchStartTime, timezone);

      // 1. 5-minute warning notification
      if (elapsedMinutes >= warningThresholdMinutes && elapsedMinutes < allowedMinutes) {
        const warningId = `${employee.id}__lunch_warning_5m__${latestPunch.id}`;
        const warningRef = doc(db(), "lunchBreakNotifications", warningId);

        try {
          const claimed = await runTransaction(db(), async (transaction) => {
            const existing = await transaction.get(warningRef);
            if (existing.exists()) return false;
            transaction.set(warningRef, {
              employeeId: employee.id,
              companyId: activeCompanyId,
              lunchPunchId: latestPunch.id,
              type: "warning_5m",
              status: "pending",
              createdAt: new Date().toISOString(),
            });
            return true;
          });

          if (claimed) {
            processingRef.current = true;
            const idToken = await user.getIdToken();
            const response = await fetch("/api/lunch-break-notification", {
              method: "POST",
              headers: {
                authorization: `Bearer ${idToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                notificationId: warningId,
                type: "warning_5m",
                employeeId: employee.id,
                employeeName: employee.name,
                employeeEmail: employee.email,
                companyId: activeCompanyId,
                company: companyEmailBranding(company, activeCompanyId),
                attendanceDate,
                breakStartedAt,
                allowedMinutes,
                elapsedMinutes,
                timezone,
              }),
            });

            await updateDoc(
              warningRef,
              response.ok
                ? { status: "sent", sentAt: new Date().toISOString() }
                : { status: "failed", error: `HTTP ${response.status}` },
            ).catch(() => {});
          }
        } catch (error) {
          await updateDoc(warningRef, {
            status: "failed",
            error: (error as Error).message.slice(0, 500),
          }).catch(() => {});
        } finally {
          processingRef.current = false;
        }
      }

      // 2. Overdue / Break Finished 5 minutes ago notification (e.g. at 35m for a 30m break)
      const overdueThresholdMinutes = allowedMinutes + 5;
      if (elapsedMinutes >= overdueThresholdMinutes) {
        const overdueId = `${employee.id}__lunch_overdue__${latestPunch.id}`;
        const overdueRef = doc(db(), "lunchBreakNotifications", overdueId);

        try {
          const claimed = await runTransaction(db(), async (transaction) => {
            const existing = await transaction.get(overdueRef);
            if (existing.exists()) return false;
            transaction.set(overdueRef, {
              employeeId: employee.id,
              companyId: activeCompanyId,
              lunchPunchId: latestPunch.id,
              type: "overdue",
              status: "pending",
              createdAt: new Date().toISOString(),
            });
            return true;
          });

          if (claimed) {
            processingRef.current = true;
            const idToken = await user.getIdToken();
            const response = await fetch("/api/lunch-break-notification", {
              method: "POST",
              headers: {
                authorization: `Bearer ${idToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                notificationId: overdueId,
                type: "overdue",
                employeeId: employee.id,
                employeeName: employee.name,
                employeeEmail: employee.email,
                companyId: activeCompanyId,
                company: companyEmailBranding(company, activeCompanyId),
                attendanceDate,
                breakStartedAt,
                allowedMinutes,
                elapsedMinutes,
                timezone,
              }),
            });

            await updateDoc(
              overdueRef,
              response.ok
                ? { status: "sent", sentAt: new Date().toISOString() }
                : { status: "failed", error: `HTTP ${response.status}` },
            ).catch(() => {});
          }
        } catch (error) {
          await updateDoc(overdueRef, {
            status: "failed",
            error: (error as Error).message.slice(0, 500),
          }).catch(() => {});
        } finally {
          processingRef.current = false;
        }
      }
    }

    const punchesQuery = query(collection(db(), "punches"), where("employeeId", "==", employee.id));
    const unsubscribe = onSnapshot(punchesQuery, (snapshot) => {
      punchesRef.current = snapshot.docs
        .map((item) => ({ id: item.id, ...(item.data() as Omit<Punch, "id">) }))
        .filter((punch) => punch.timestamp)
        .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
      void checkBreakReminders();
    });

    const interval = window.setInterval(() => void checkBreakReminders(), BREAK_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [activeCompanyId, company, employee, user]);
}
