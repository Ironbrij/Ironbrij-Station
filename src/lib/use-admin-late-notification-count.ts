import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import type { Company, Employee, LeaveRequest, Punch } from "./types";
import { buildAdminLateAlerts, LATE_ALERT_READ_EVENT, readLateAlertIds } from "./late-alerts";

export function useAdminLateNotificationCount({
  enabled,
  company,
}: {
  enabled: boolean;
  company: Company | null;
}): number {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [punches, setPunches] = useState<Punch[]>([]);
  const [leaves, setLeaves] = useState<LeaveRequest[]>([]);
  const [readIds, setReadIds] = useState<Set<string>>(() => readLateAlertIds());
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(new Date()), 30000);
    const unsubscribeEmployees = onSnapshot(collection(db(), "employees"), (snapshot) =>
      setEmployees(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Employee, "id">),
        })),
      ),
    );
    const unsubscribePunches = onSnapshot(collection(db(), "punches"), (snapshot) =>
      setPunches(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<Punch, "id">),
        })),
      ),
    );
    const unsubscribeLeaves = onSnapshot(collection(db(), "leaveRequests"), (snapshot) =>
      setLeaves(
        snapshot.docs.map((item) => ({
          id: item.id,
          ...(item.data() as Omit<LeaveRequest, "id">),
        })),
      ),
    );

    return () => {
      window.clearInterval(timer);
      unsubscribeEmployees();
      unsubscribePunches();
      unsubscribeLeaves();
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const syncReadIds = () => setReadIds(readLateAlertIds());
    syncReadIds();
    window.addEventListener(LATE_ALERT_READ_EVENT, syncReadIds);
    window.addEventListener("storage", syncReadIds);
    return () => {
      window.removeEventListener(LATE_ALERT_READ_EVENT, syncReadIds);
      window.removeEventListener("storage", syncReadIds);
    };
  }, [enabled]);

  const alerts = useMemo(
    () => buildAdminLateAlerts({ employees, punches, leaves, company, now }),
    [employees, punches, leaves, company, now],
  );

  if (!enabled) return 0;
  return alerts.filter((alert) => !readIds.has(alert.id)).length;
}
