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
  // A new version may accept a sign-in an older one refused.
  chrome.storage.local.remove("refused");
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
chrome.alarms.onAlarm.addListener(() => sync(true));
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message === "sync") sync();
  // The ball was clicked: SavyTime itself opens beside the page. Called at once,
  // while Chrome still counts the click as the employee's.
  if (message === "panel" && sender.tab) chrome.sidePanel.open({ tabId: sender.tab.id });
});

async function idToken(link) {
  const { token } = await chrome.storage.session.get("token");
  if (token && token.refreshToken === link.refreshToken && token.expiresAt > Date.now() + 60e3) {
    return token.value;
  }
  const firebase = link.firebase || CLOCK_BALL_FIREBASE;
  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${firebase.apiKey}`,
    {
      method: "POST",
      headers: clockBallAuthHeaders(firebase, "application/x-www-form-urlencoded"),
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: link.refreshToken }),
    },
  );
  if (!response.ok) {
    // Google's own reason, shown in the popup so a failed sign-in can be told apart.
    const reason = (await response.json().catch(() => null))?.error?.message || response.status;
    // 400 means the sign-in was revoked or the password changed: sign out.
    throw Object.assign(new Error(`Google didn't accept the sign-in (${reason}).`), {
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

/**
 * Without the (employee, time) index the database refuses punchesSince. Every
 * punch SavyTime writes carries its shift's `date`, and equality lookups need
 * no special index, so read the few days around today instead.
 * shortcut: reads those days in full every minute (about 10 reads); creating the
 * index from firestore.indexes.json brings it back to 1 read when nothing changed.
 */
function punchesAroundToday(link, token, now) {
  const days = [-2, -1, 0, 1].map((d) => new Date(now + d * 86400e3).toISOString().slice(0, 10));
  const any = (values) => ({ arrayValue: { values: values.map((v) => ({ stringValue: v })) } });
  return clockBallQuery(
    token,
    {
      from: [{ collectionId: "punches" }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "employeeId" },
                op: "IN",
                value: any(link.employeeIds),
              },
            },
            { fieldFilter: { field: { fieldPath: "date" }, op: "IN", value: any(days) } },
          ],
        },
      },
    },
    link.firebase,
  ).then((docs) => docs.map(clockBallPunch));
}

function punchesSince(link, token, since) {
  return clockBallQuery(
    token,
    {
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
    },
    link.firebase,
  ).then((docs) => docs.map(clockBallPunch));
}

// While clocked in the minute alarm checks every time, so a punch-out made
// anywhere hides the ball within a minute. Otherwise it checks every 5 minutes
// to spare the database's daily reads; a punch on SavyTime in this browser
// still checks at once (it sends "sync"), and the ball hides itself exactly at
// the shift's end without any check.
const IDLE_CHECK_MS = 5 * 60 * 1000;

let syncing = null;
/** `routine` is the minute alarm; everything else (punches, sign-in, start-up) checks now. */
function sync(routine = false) {
  syncing ??= runSync(routine).finally(() => (syncing = null));
  return syncing;
}

async function runSync(routine) {
  const { link, cache, shift, synced } = await chrome.storage.local.get([
    "link",
    "cache",
    "shift",
    "synced",
  ]);
  if (!link) return;
  const now = Date.now();
  if (routine && !shift?.active && synced && now - synced.at < IDLE_CHECK_MS) return;
  try {
    const token = await idToken(link);
    const who = link.employeeIds.join();
    const full = !cache || cache.who !== who || now - cache.fullAt > FULL_READ_MS;
    const since = full ? now - LOOKBACK_MS : cache.lastAt;
    const known = new Map(full ? [] : cache.punches.map((p) => [p.id, p]));
    const fresh = await punchesSince(link, token, since).catch((error) => {
      if (!error.needsIndex) throw error;
      return punchesAroundToday(link, token, now);
    });
    for (const punch of fresh) known.set(punch.id, punch);
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
      // Remembered so SavyTime doesn't hand the same refused sign-in over again.
      await chrome.storage.local.set({ shift: { active: false }, refused: link.refreshToken });
    }
    // Otherwise (offline, SavyTime unreachable) the ball keeps its last known state.
    await chrome.storage.local.set({ synced: { at: now, error: String(error.message || error) } });
  }
}
