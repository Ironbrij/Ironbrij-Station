import { attendanceNow } from "./attendance-clock";
import { useEffect, useMemo, useState } from "react";
import type { Company } from "./types";
import { buildAdminLateAlerts, LATE_ALERT_READ_EVENT, readLateAlertIds } from "./late-alerts";
import {
  listOf,
  recentWindowStart,
  useEmployeesLive,
  useLeavesEndingSinceLive,
  useRecentPunchesLive,
} from "./live-data";

export function useAdminLateNotificationCount({
  enabled,
  company,
}: {
  enabled: boolean;
  company: Company | null;
}): number {
  // The same live records the dashboard and late log read, so the badge counts
  // exactly what those pages list.
  const employees = listOf(useEmployeesLive(enabled));
  const punches = listOf(useRecentPunchesLive(undefined, enabled));
  // Only approved leave excuses an absence; the dashboard reads the same query.
  const leaveData = useLeavesEndingSinceLive(enabled ? recentWindowStart() : null).data;
  const leaves = useMemo(
    () => (leaveData ?? []).filter((leave) => leave.status === "approved"),
    [leaveData],
  );
  const [readIds, setReadIds] = useState<Set<string>>(() => readLateAlertIds());
  const [now, setNow] = useState(() => attendanceNow());

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNow(attendanceNow()), 30000);
    return () => window.clearInterval(timer);
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
    () => (enabled ? buildAdminLateAlerts({ employees, punches, leaves, company, now }) : []),
    [enabled, employees, punches, leaves, company, now],
  );

  if (!enabled) return 0;
  return alerts.filter((alert) => !readIds.has(alert.id)).length;
}
