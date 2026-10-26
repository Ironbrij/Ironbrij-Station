import { useEffect, useState } from "react";
import { useAppRuntime } from "./app-runtime";
import { CLOCK_BALL_MESSAGE, CLOCK_BALL_REPLY } from "./clock-ball";
import { auth, firebaseConfig } from "./firebase";
import { employeeRecordIds, isSettled, useEmployeePunchesLive } from "./live-data";
import type { Employee } from "./types";

function postToExtension(message: Record<string, unknown>) {
  window.postMessage({ source: CLOCK_BALL_MESSAGE, ...message }, window.location.origin);
}

/**
 * Tells the Clock Ball extension, when installed, that this employee's punches
 * changed, so it checks the database at once instead of at its next minute.
 * The extension only ever reads punches for the account signed in to it.
 *
 * Returns true when this page is open in the extension's own side panel and the
 * extension isn't signed in yet: the page then asks the employee whether to
 * connect it to this account (how "Continue with Google" in the extension ends).
 */
export function useClockBallBridge(employee: Employee | null): boolean {
  const { ready } = useAppRuntime();
  // The same punches the punch page and automatic punch-out read.
  const punchesLive = useEmployeePunchesLive(ready ? employee : null);
  const punches = isSettled(punchesLive) ? punchesLive.data : undefined;
  useEffect(() => {
    if (punches) postToExtension({ nudge: true });
  }, [punches]);

  const [askToConnect, setAskToConnect] = useState(false);
  useEffect(() => {
    if (!employee) return;
    function onMessage(event: MessageEvent) {
      if (event.source === window && event.data?.source === CLOCK_BALL_REPLY) {
        setAskToConnect(Boolean(event.data.askToConnect));
      }
    }
    window.addEventListener("message", onMessage);
    postToExtension({ ping: true });
    return () => window.removeEventListener("message", onMessage);
  }, [employee]);
  return askToConnect;
}

/** Signs the extension in as this employee: the way in for Google sign-ins. */
export function connectClockBall(employee: Employee) {
  const user = auth().currentUser;
  if (!user?.email) return;
  postToExtension({
    connect: {
      refreshToken: user.refreshToken,
      email: user.email,
      name: employee.name,
      employeeIds: employeeRecordIds(employee),
      // The project this page signed in to; the extension's sign-in only works there.
      firebase: {
        apiKey: firebaseConfig.apiKey,
        projectId: firebaseConfig.projectId,
        appId: firebaseConfig.appId,
      },
    },
  });
}

/**
 * The extension on this browser: null while still asking, false when it is not
 * installed, otherwise who it is signed in as ("" when nobody).
 */
export function useClockBallExtension(): { connectedAs: string } | false | null {
  const [extension, setExtension] = useState<{ connectedAs: string } | false | null>(null);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source === window && event.data?.source === CLOCK_BALL_REPLY) {
        setExtension({ connectedAs: String(event.data.connectedAs || "") });
      }
    }
    window.addEventListener("message", onMessage);
    postToExtension({ ping: true });
    // The extension answers within milliseconds; silence means it is not there.
    const timer = window.setTimeout(() => setExtension((value) => value ?? false), 600);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
    };
  }, []);
  return extension;
}
