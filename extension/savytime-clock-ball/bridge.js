// Runs on SavyTime only. The ball follows the account signed in to the
// extension, never whoever is signed in to this page, so this page can only:
// - say "a punch was just made", so the ball checks the database at once;
// - connect the extension to this page's account when the employee clicks
//   "Connect" (the way in for people who sign in to SavyTime with Google);
// - ask whether the extension is installed, and as whom.
async function announce() {
  const { link } = await chrome.storage.local.get("link");
  window.postMessage(
    {
      source: "savytime-clock-ball-extension",
      version: chrome.runtime.getManifest().version,
      connectedAs: link ? link.email : "",
    },
    location.origin,
  );
}

const text = (value, max) => (typeof value === "string" && value.length <= max ? value : "");

window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== window || !data || data.source !== "savytime-clock-ball") return;
  try {
    if (data.ping) announce();
    if (data.nudge) chrome.runtime.sendMessage("sync").catch(() => {});
    const connect = data.connect;
    if (connect && text(connect.refreshToken, 4000) && text(connect.email, 320)) {
      const employeeIds = (Array.isArray(connect.employeeIds) ? connect.employeeIds : [])
        .filter((id) => text(id, 200))
        .slice(0, 10);
      if (!employeeIds.length) return;
      chrome.storage.local
        .set({
          link: {
            refreshToken: connect.refreshToken,
            email: connect.email,
            name: text(connect.name, 200),
            employeeIds,
          },
        })
        .then(() => chrome.storage.local.remove("cache"))
        .then(() => chrome.runtime.sendMessage("sync"))
        .finally(announce);
    }
  } catch {
    // The extension was reloaded or updated; the new copy takes over.
  }
});

announce();
