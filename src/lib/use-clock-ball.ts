import { useEffect, useState } from "react";
import { attendanceNow } from "./attendance-clock";
import { useAppRuntime } from "./app-runtime";
import { CLOCK_BALL_MESSAGE, CLOCK_BALL_REPLY, clockBallState } from "./clock-ball";
import { auth, firebaseConfig } from "./firebase";
import {
  activePunchesInOrder,
  employeeRecordIds,
  isSettled,
  useEmployeePunchesLive,
} from "./live-data";
import type { Company, Employee } from "./types";

/**
 * Tells the Clock Ball extension, when installed, whether this employee is
 * clocked in, straight away. It also hands over this sign-in, so the extension
 * can keep checking the punches itself once this tab is closed: a punch-out
 * from the phone, an admin or automatic punch-out still hides the ball.
 * The extension listens on this page only.
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
    const ordered = activePunchesInOrder(punches);
    function send() {
      const now = attendanceNow();
      window.postMessage(
        {
          source: CLOCK_BALL_MESSAGE,
          state: clockBallState(ordered, employee, now, companies),
          // The ball counts on the computer's clock; this corrects it to SavyTime's.
          clockOffset: now.getTime() - Date.now(),
          link: {
            refreshToken: auth().currentUser?.refreshToken,
            apiKey: firebaseConfig.apiKey,
            projectId: firebaseConfig.projectId,
            employeeIds: employeeRecordIds(employee),
          },
        },
        window.location.origin,
      );
    }
    // An extension installed while this page is open says hello: tell it now.
    function onMessage(event: MessageEvent) {
      if (event.source === window && event.data?.source === CLOCK_BALL_REPLY) send();
    }
    send();
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
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
