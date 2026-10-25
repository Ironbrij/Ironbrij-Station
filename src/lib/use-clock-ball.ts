import { useEffect, useState } from "react";
import { attendanceNow } from "./attendance-clock";
import { useAppRuntime } from "./app-runtime";
import { CLOCK_BALL_MESSAGE, CLOCK_BALL_REPLY, clockBallState } from "./clock-ball";
import { activePunchesInOrder, isSettled, useEmployeePunchesLive } from "./live-data";
import type { Company, Employee } from "./types";

/**
 * Tells the Clock Ball extension, when installed, whether this employee is
 * clocked in. The extension listens on this page only and keeps the ball
 * going on every other tab from what it was last told.
 */
export function useClockBallBridge({
  employee,
  companies,
}: {
  employee: Employee | null;
  companies: Company[];
}) {
  const { ready } = useAppRuntime();
  // The same punches the punch page and automatic punch-out read.
  const punchesLive = useEmployeePunchesLive(ready ? employee : null);
  const punches = isSettled(punchesLive) ? punchesLive.data : undefined;

  useEffect(() => {
    if (!employee || !punches) return;
    const now = attendanceNow();
    window.postMessage(
      {
        source: CLOCK_BALL_MESSAGE,
        state: clockBallState(activePunchesInOrder(punches), employee, now, companies),
        // The ball counts on the computer's clock; this corrects it to SavyTime's.
        clockOffset: now.getTime() - Date.now(),
      },
      window.location.origin,
    );
  }, [employee, punches, companies]);
}

/** Whether the Clock Ball extension answers on this page; null while still asking. */
export function useClockBallInstalled(): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source === window && event.data?.source === CLOCK_BALL_REPLY) setInstalled(true);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: CLOCK_BALL_MESSAGE, ping: true }, window.location.origin);
    // The extension answers within milliseconds; silence means it is not there.
    const timer = window.setTimeout(() => setInstalled((value) => value ?? false), 600);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, []);
  return installed;
}
