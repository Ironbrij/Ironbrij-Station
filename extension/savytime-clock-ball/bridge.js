// Runs on SavyTime only. Carries the page's clock-in state into the
// extension's storage, where the ball on every tab reads it, and answers the
// page's "is the extension installed?" ping.
window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== window || !data || data.source !== "savytime-clock-ball") return;
  try {
    if (data.ping) {
      const version = chrome.runtime.getManifest().version;
      window.postMessage({ source: "savytime-clock-ball-extension", version }, location.origin);
      return;
    }
    const state = data.state;
    if (!state || typeof state.active !== "boolean") return;
    chrome.storage.local.set({
      shift: {
        active: state.active,
        countFrom: Number(state.countFrom) || 0,
        pausedAt: Number(state.pausedAt) || 0,
        endsAt: Number(state.endsAt) || 0,
        company: String(state.company || "").slice(0, 80),
        clockOffset: Number(data.clockOffset) || 0,
      },
    });
  } catch {
    // The extension was reloaded or updated; refreshing SavyTime reconnects it.
  }
});
