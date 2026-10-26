import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const extensionFile = (name: string) =>
  readFileSync(new URL(`../extension/savytime-clock-ball/${name}`, import.meta.url), "utf8");

// The extension's shared file, loaded the way Chrome loads it.
const ball = vm.createContext({});
vm.runInContext(extensionFile("shared.js"), ball);

const HOUR = 3600e3;
// Times in these tests count from this moment.
const T = Date.parse("2026-10-26T00:00:00Z");
const p = (type: string, at: number, extra: { endsAt?: number } = {}) => ({
  id: type + at,
  type,
  company: "alpha",
  companyName: "Ironbrij",
  at: T + at,
  voided: false,
  ...extra,
  endsAt: extra.endsAt ? T + extra.endsAt : 0,
});
const viewAt = (shift: object, at: number) => ball.clockBallView(shift, T + at);

test("a running shift counts from clock-in and hides at the shift end", () => {
  const shift = ball.clockBallFromPunches([p("in", 0, { endsAt: 8 * HOUR })]);
  assert.equal(shift.active, true);
  assert.equal(viewAt(shift, 2 * HOUR + 14 * 60e3 + 9e3).time, "2:14:09");
  assert.equal(viewAt(shift, 8 * HOUR), null);
});

test("breaks pause the count and push the end out", () => {
  const onBreak = ball.clockBallFromPunches([
    p("in", 0, { endsAt: 8 * HOUR }),
    p("lunch_start", 3 * HOUR),
  ]);
  const view = viewAt(onBreak, 3 * HOUR + 20 * 60e3);
  assert.equal(view.time, "3:00:00");
  assert.equal(view.paused, true);
  // Twenty minutes of break so far: the shift runs twenty minutes later.
  assert.ok(viewAt(onBreak, 8 * HOUR + 10 * 60e3));

  const back = ball.clockBallFromPunches([
    p("in", 0, { endsAt: 8 * HOUR }),
    p("lunch_start", 3 * HOUR),
    p("lunch_end", 3.5 * HOUR),
  ]);
  assert.equal(viewAt(back, 4 * HOUR).time, "3:30:00");
  assert.equal(back.endsAt, T + 8.5 * HOUR);
});

test("voided punches and other companies are read like SavyTime reads them", () => {
  const shift = ball.clockBallFromPunches([
    p("in", 1000),
    p("out", 3000, { voided: true }),
    p("out", 3100, { company: "beta" }),
  ]);
  assert.equal(shift.active, true);
  assert.equal(ball.clockBallFromPunches([p("in", 1), p("out", 2)]).active, false);
  // Voided only when the field has a value, as the app judges it.
  const doc = (voidedAt: object) => ({
    name: "x/punches/1",
    fields: { type: { stringValue: "in" }, voidedAt },
  });
  assert.equal(ball.clockBallPunch(doc({ stringValue: "" })).voided, false);
  assert.equal(ball.clockBallPunch(doc({ nullValue: null })).voided, false);
  assert.equal(ball.clockBallPunch(doc({ stringValue: "2026-10-26T00:00:00Z" })).voided, true);
});

// The extension's background worker, with Chrome and the network faked.
function backgroundWorker(db: { id: string; fields: Record<string, unknown> }[]) {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const area = (store: Map<string, unknown>) => ({
    get: async (keys: string | string[]) =>
      Object.fromEntries([keys].flat().map((key) => [key, store.get(key)])),
    set: async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) store.set(key, structuredClone(value));
    },
    remove: async (keys: string | string[]) => [keys].flat().forEach((key) => store.delete(key)),
  });
  const listener = { addListener() {} };
  const net = {
    tokenStatus: 200,
    queries: [] as string[],
    employeeIds: [] as string[],
    urls: [] as string[],
    appIds: [] as string[],
    noIndex: false,
  };
  const context = vm.createContext({
    console,
    URLSearchParams,
    chrome: {
      storage: { local: area(local), session: area(session) },
      alarms: { create() {}, onAlarm: listener },
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener },
    },
    importScripts: () => vm.runInContext(extensionFile("shared.js"), context),
    fetch: async (url: string, init: { body: string; headers: Record<string, string> }) => {
      net.urls.push(url);
      net.appIds.push(init.headers["X-Firebase-gmpid"]);
      if (url.startsWith("https://securetoken.googleapis.com/")) {
        const body =
          net.tokenStatus === 200
            ? { id_token: "id", expires_in: "3600" }
            : { error: { message: "INVALID_REFRESH_TOKEN" } };
        return new Response(JSON.stringify(body), {
          status: net.tokenStatus,
        });
      }
      const filters = JSON.parse(init.body).structuredQuery.where.compositeFilter.filters;
      net.employeeIds = filters[0].fieldFilter.value.arrayValue.values.map(
        (value: { stringValue: string }) => value.stringValue,
      );
      const asRows = (docs: typeof db) =>
        new Response(
          JSON.stringify(
            docs.length
              ? docs.map((doc) => ({
                  document: { name: `projects/p/documents/punches/${doc.id}`, ...doc },
                }))
              : [{ readTime: "now" }],
          ),
        );
      const stamp = (doc: (typeof db)[number]) =>
        (doc.fields.timestamp as { timestampValue: string }).timestampValue;
      // The index-free lookup by the shift's date.
      if (filters[1].fieldFilter.field.fieldPath === "date") {
        const days = filters[1].fieldFilter.value.arrayValue.values.map(
          (value: { stringValue: string }) => value.stringValue,
        );
        net.queries.push(`days:${days.join(",")}`);
        return asRows(db.filter((doc) => days.includes(stamp(doc).slice(0, 10))));
      }
      if (net.noIndex) {
        return new Response(
          JSON.stringify([
            {
              error: {
                code: 400,
                message: "The query requires an index. You can create it here: …",
              },
            },
          ]),
          { status: 400 },
        );
      }
      const since = filters[1].fieldFilter.value.timestampValue;
      net.queries.push(since);
      return asRows(db.filter((doc) => stamp(doc) > since));
    },
  });
  vm.runInContext(extensionFile("background.js"), context);
  local.set("link", {
    refreshToken: "refresh",
    email: "va@x.com",
    employeeIds: ["va", "va-login"],
  });
  return {
    sync: () => context.sync() as Promise<void>,
    // The minute alarm.
    tick: () => context.sync(true) as Promise<void>,
    local,
    net,
  };
}

const stored = (type: string, minutesAgo: number, extra: Record<string, unknown> = {}) => ({
  id: `${type}-${minutesAgo}`,
  fields: {
    type: { stringValue: type },
    companyId: { stringValue: "alpha" },
    companyName: { stringValue: "Ironbrij" },
    timestamp: { timestampValue: new Date(Date.now() - minutesAgo * 60e3).toISOString() },
    ...extra,
  },
});
const shiftOf = (worker: ReturnType<typeof backgroundWorker>) =>
  worker.local.get("shift") as { active: boolean; countFrom: number; endsAt: number };

test("the extension reads only the signed-in employee's punches", async () => {
  const end = new Date(Date.now() + 60 * 60e3).toISOString();
  const worker = backgroundWorker([stored("in", 120, { scheduledShiftEnd: { stringValue: end } })]);
  await worker.sync();
  assert.deepEqual(worker.net.employeeIds, ["va", "va-login"]);
  assert.equal(shiftOf(worker).active, true);
  assert.equal(shiftOf(worker).endsAt, Date.parse(end));
  assert.ok(Math.abs(Date.now() - 120 * 60e3 - shiftOf(worker).countFrom) < 2000);
  assert.equal((worker.local.get("synced") as { error: string }).error, "");
});

test("a punch-out made elsewhere, with no SavyTime tab open, hides the ball", async () => {
  const db = [stored("in", 120)];
  const worker = backgroundWorker(db);
  await worker.sync();
  assert.equal(shiftOf(worker).active, true);
  db.push(stored("out", 0));
  await worker.sync();
  assert.equal(shiftOf(worker).active, false);
  // The second check only asked for punches after the last one it had.
  assert.equal(
    worker.net.queries[1],
    (db[0].fields.timestamp as { timestampValue: string }).timestampValue,
  );
});

test("a sign-in that no longer works signs the extension out and hides the ball", async () => {
  const worker = backgroundWorker([stored("in", 10)]);
  worker.net.tokenStatus = 400;
  await worker.sync();
  assert.equal(worker.local.has("link"), false);
  assert.equal(shiftOf(worker).active, false);
  assert.equal(
    (worker.local.get("synced") as { error: string }).error,
    "Google didn't accept the sign-in (INVALID_REFRESH_TOKEN).",
  );
  // So SavyTime's side panel can't hand the same sign-in over again and again.
  assert.equal(worker.local.get("refused"), "refresh");
});

test("a fresh install wears the Ironbrij logo, and each pick overrides only itself", () => {
  const fresh = ball.clockBallLook({});
  assert.equal(fresh.face, "logo");
  assert.equal(fresh.blink, true);
  assert.equal(fresh.jokes, true);
  const picked = ball.clockBallLook({ face: "robot", jokes: false });
  assert.equal(picked.face, "robot");
  assert.equal(picked.jokes, false);
  assert.equal(picked.size, "medium");
  assert.ok(ball.CLOCK_BALL_JOKES.length >= 10);
});

test("the sign-in is checked against the Firebase project it came from", async () => {
  // Email and password, or anything without its own settings: the live SavyTime project.
  const live = backgroundWorker([stored("in", 10)]);
  await live.sync();
  assert.ok(live.net.urls[0].endsWith("key=AIzaSyBytpwetTMCahmXnEc-Dv1qNhEINX9T9Uw"));
  // The app ID tells Google the project, as Firebase's own code does.
  assert.equal(live.net.appIds[0], "1:1094579363471:web:87518314d7de1779d85afa");
  assert.match(live.net.urls[1], /\/projects\/ironbrij-timestation\//);

  // Handed over by a SavyTime running on another project (a developer's copy).
  const local = backgroundWorker([stored("in", 10)]);
  local.local.set("link", {
    ...(local.local.get("link") as object),
    firebase: { apiKey: "dev-key", projectId: "dev-project", appId: "1:42:web:abc" },
  });
  await local.sync();
  assert.ok(local.net.urls[0].endsWith("key=dev-key"));
  assert.equal(local.net.appIds[0], "1:42:web:abc");
  assert.match(local.net.urls[1], /\/projects\/dev-project\//);
});

test("without the database index the extension still finds the punch-in, by date", async () => {
  const db = [stored("in", 120)];
  const worker = backgroundWorker(db);
  worker.net.noIndex = true;
  await worker.sync();
  assert.equal(shiftOf(worker).active, true);
  assert.equal((worker.local.get("synced") as { error: string }).error, "");
  assert.match(worker.net.queries.at(-1)!, /^days:/);
  // And it still notices the punch-out made elsewhere.
  db.push(stored("out", 0));
  await worker.sync();
  assert.equal(shiftOf(worker).active, false);
});

test("while clocked in every minute is checked; otherwise every 5 minutes", async () => {
  const db = [stored("in", 30)];
  const working = backgroundWorker(db);
  await working.sync();
  const asked = working.net.queries.length;
  await working.tick();
  // Clocked in: the next minute checks again, so a punch-out elsewhere shows within a minute.
  assert.equal(working.net.queries.length, asked + 1);

  const idle = backgroundWorker([stored("in", 300), stored("out", 120)]);
  await idle.sync();
  const before = idle.net.queries.length;
  await idle.tick();
  // Not clocked in and checked moments ago: the minute alarm waits.
  assert.equal(idle.net.queries.length, before);
  // A punch made on SavyTime ("sync") still checks at once.
  await idle.sync();
  assert.equal(idle.net.queries.length, before + 1);
});
