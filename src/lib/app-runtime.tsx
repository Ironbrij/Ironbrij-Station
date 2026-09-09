import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { APP_VERSION } from "./app-version";
import { calibrateAttendanceClock } from "./attendance-clock";

type Runtime = { ready: boolean; message: string; refreshRequired: boolean };
const initial: Runtime = { ready: false, message: "Connecting to attendance server…", refreshRequired: false };
const Context = createContext<Runtime>(initial);
export const useAppRuntime = () => useContext(Context);

export function AppRuntimeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initial);
  useEffect(() => {
    let active = true;
    let checking = false;
    let refreshRequired = false;
    let controller: AbortController | undefined;
    async function check() {
      if (checking || !active) return;
      checking = true;
      const requestController = new AbortController();
      controller = requestController;
      const timeout = window.setTimeout(() => requestController.abort(), 10000);
      try {
        const started = performance.now();
        const response = await fetch(`/api/app-health?t=${Date.now()}`, { cache: "no-store", signal: requestController.signal });
        if (!response.ok) throw new Error("Attendance server unavailable");
        const data = await response.json();
        if (!Number.isFinite(data.serverTime) || typeof data.version !== "string") throw new Error("Invalid server response");
        if (!active) return;
        calibrateAttendanceClock(data.serverTime, performance.now() - started);
        refreshRequired ||= data.version !== APP_VERSION;
        setState({ ready: !refreshRequired, refreshRequired,
          message: refreshRequired ? "A newer attendance app is available. Refresh before recording attendance." : "" });
      } catch {
        if (active) setState({ ready: false, refreshRequired,
          message: "Connection unavailable. Attendance changes are disabled until we reconnect." });
      } finally { window.clearTimeout(timeout); checking = false; }
    }
    // Retire an older offline worker only for this app's root scope. Keep login data.
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        for (const registration of registrations) {
          if (!active || registration.scope !== `${location.origin}/`) continue;
          const removed = await registration.unregister();
          if (removed && navigator.serviceWorker.controller && active) {
            refreshRequired = true;
            setState({ ready: false, refreshRequired: true,
              message: "An older offline app was found. Refresh to load the current attendance app." });
          }
        }
      }).catch(() => {});
    }
    const staleChunk = () => {
      refreshRequired = true;
      setState({ ready: false, refreshRequired: true, message: "The app was updated. Refresh to load the latest version." });
    };
    window.addEventListener("vite:preloadError", staleChunk);
    const offline = () => setState({ ready: false, refreshRequired, message: "You are offline. Reconnect before recording attendance." });
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    const timer = window.setInterval(() => void check(), 60000);
    window.addEventListener("online", check); window.addEventListener("offline", offline);
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("vite:preloadError", staleChunk);
      active = false; controller?.abort(); window.clearInterval(timer);
      window.removeEventListener("online", check); window.removeEventListener("offline", offline);
      window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return <Context.Provider value={state}>
    {state.message && <div role="status" className="border-b bg-amber-50 px-4 py-3 text-sm text-amber-950">
      {state.message}{state.refreshRequired && <button className="ml-3 font-semibold underline" onClick={() => location.reload()}>Refresh app</button>}
    </div>}
    {children}
  </Context.Provider>;
}
