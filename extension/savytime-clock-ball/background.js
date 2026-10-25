// Keeps the ball true to the database for the account signed in to the
// extension. Once a minute, when Chrome starts, and the moment SavyTime says a
// punch was made, it reads that employee's new punches, so a punch-in or
// punch-out made anywhere (another device, an admin, automatic punch-out)
// shows up with or without a SavyTime tab open.
importScripts("shared.js");

const SAVYTIME = [`${CLOCK_BALL_SITE}/*`, "http://localhost:5173/*"];
const LOOKBACK_MS = 36 * 60 * 60 * 1000;
// New punches are read every minute (1 read when nothing changed). The whole
// recent window is re-read now and then to catch corrected or voided punches.
const FULL_READ_MS = 15 * 60 * 1000;

function schedule() {
  chrome.alarms.create("sync", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  schedule();
  if (reason !== "install" && reason !== "update") return;
  // Content scripts only reach pages opened after install, so give the tabs
  // already open the ball and SavyTime's punch notices straight away.
  const inject = (tab, files) =>
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files }).catch(() => {
      // Pages Chrome keeps to itself (web store, settings) refuse; that's fine.
    });
  for (const tab of await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] })) {
    inject(tab, ["shared.js", "ball.js"]);
  }
  for (const tab of await chrome.tabs.query({ url: SAVYTIME })) inject(tab, ["bridge.js"]);
  if (reason === "install") chrome.tabs.create({ url: "popup.html?welcome" });
});
chrome.runtime.onStartup.addListener(() => {
  schedule();
  sync();
});
chrome.alarms.onAlarm.addListener(() => sync());
chrome.runtime.onMessage.addListener((message) => {
  if (message === "sync") sync();
});

async function idToken(link) {
  const { token } = await chrome.storage.session.get("token");
  if (token && token.refreshToken === link.refreshToken && token.expiresAt > Date.now() + 60e3) {
    return token.value;
  }
  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${CLOCK_BALL_FIREBASE.apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: link.refreshToken }),
    },
  );
  if (!response.ok) {
    // 400 means the sign-in was revoked or the password changed: sign out.
    throw Object.assign(new Error("Your sign-in has expired. Please sign in again."), {
      signedOut: response.status === 400,
    });
  }
  const body = await response.json();
  await chrome.storage.session.set({
    token: {
      value: body.id_token,
      refreshToken: link.refreshToken,
      expiresAt: Date.now() + Number(body.expires_in) * 1000,
    },
  });
  return body.id_token;
}

function punchesSince(link, token, since) {
  return clockBallQuery(token, {
    from: [{ collectionId: "punches" }],
    where: {
      compositeFilter: {
        op: "AND",
        filters: [
          {
            fieldFilter: {
              field: { fieldPath: "employeeId" },
              op: "IN",
              value: {
                arrayValue: { values: link.employeeIds.map((id) => ({ stringValue: id })) },
              },
            },
          },
          {
            fieldFilter: {
              field: { fieldPath: "timestamp" },
              op: "GREATER_THAN",
              value: { timestampValue: new Date(since).toISOString() },
            },
          },
        ],
      },
    },
    orderBy: [{ field: { fieldPath: "timestamp" }, direction: "ASCENDING" }],
  }).then((docs) => docs.map(clockBallPunch));
}

let syncing = null;
function sync() {
  syncing ??= runSync().finally(() => (syncing = null));
  return syncing;
}

async function runSync() {
  const { link, cache, shift } = await chrome.storage.local.get(["link", "cache", "shift"]);
  if (!link) return;
  const now = Date.now();
  try {
    const token = await idToken(link);
    const who = link.employeeIds.join();
    const full = !cache || cache.who !== who || now - cache.fullAt > FULL_READ_MS;
    const since = full ? now - LOOKBACK_MS : cache.lastAt;
    const known = new Map(full ? [] : cache.punches.map((p) => [p.id, p]));
    for (const punch of await punchesSince(link, token, since)) known.set(punch.id, punch);
    const punches = [...known.values()]
      .filter((p) => p.at > now - LOOKBACK_MS)
      .sort((a, b) => a.at - b.at);
    const next = clockBallFromPunches(punches);
    await chrome.storage.local.set({
      cache: {
        who,
        fullAt: full ? now : cache.fullAt,
        lastAt: Math.max(since, ...punches.map((p) => p.at)),
        punches,
      },
      synced: { at: now, error: "" },
      // Rewritten only on a change, so tabs aren't woken every minute for nothing.
      ...(JSON.stringify(next) !== JSON.stringify(shift) ? { shift: next } : {}),
    });
  } catch (error) {
    if (error.signedOut) {
      await chrome.storage.local.remove(["link", "cache"]);
      await chrome.storage.local.set({ shift: { active: false } });
    }
    // Otherwise (offline, SavyTime unreachable) the ball keeps its last known state.
    await chrome.storage.local.set({ synced: { at: now, error: String(error.message || error) } });
  }
}
