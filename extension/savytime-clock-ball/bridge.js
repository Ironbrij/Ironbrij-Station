// Runs on SavyTime only. Carries the page's clock-in state (and its sign-in,
// so the extension can check punches itself after the tab is closed) into the
// extension. It says hello on arrival, so a page that was already open when the
// extension was installed sends its state again, and answers the page's ping.
function announce() {
  const version = chrome.runtime.getManifest().version;
  window.postMessage({ source: "savytime-clock-ball-extension", version }, location.origin);
}

const text = (value, max) => (typeof value === "string" && value.length <= max ? value : "");

window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== window || !data || data.source !== "savytime-clock-ball") return;
  try {
    if (data.ping) {
      announce();
      return;
    }
    if (data.signedOut) {
      chrome.storage.local.remove(["link", "cache"]);
      chrome.storage.local.set({ shift: { active: false } });
      return;
    }
    const state = data.state;
    if (!state || typeof state.active !== "boolean") return;
    const saved = {
      shift: {
        active: state.active,
        countFrom: Number(state.countFrom) || 0,
        pausedAt: Number(state.pausedAt) || 0,
        endsAt: Number(state.endsAt) || 0,
        company: text(state.company, 200).slice(0, 80),
        clockOffset: Number(data.clockOffset) || 0,
      },
    };
    const link = data.link || {};
    const employeeIds = Array.isArray(link.employeeIds)
      ? link.employeeIds.filter((id) => text(id, 200)).slice(0, 10)
      : [];
    if (text(link.refreshToken, 4000) && text(link.apiKey, 200) && text(link.projectId, 200)) {
      if (employeeIds.length) {
        saved.link = {
          refreshToken: link.refreshToken,
          apiKey: link.apiKey,
          projectId: link.projectId,
          employeeIds,
        };
      }
    }
    chrome.storage.local.set(saved, () => chrome.runtime.sendMessage("sync").catch(() => {}));
  } catch {
    // The extension was reloaded or updated; the new copy takes over.
  }
});

announce();
