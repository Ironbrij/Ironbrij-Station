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
  const net = { tokenStatus: 200, queries: [] as string[], employeeIds: [] as string[] };
  const context = vm.createContext({
    console,
    URLSearchParams,
    chrome: {
      storage: { local: area(local), session: area(session) },
      alarms: { create() {}, onAlarm: listener },
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener },
    },
    importScripts: () => vm.runInContext(extensionFile("shared.js"), context),
    fetch: async (url: string, init: { body: string }) => {
      if (url.startsWith("https://securetoken.googleapis.com/")) {
        return new Response(JSON.stringify({ id_token: "id", expires_in: "3600" }), {
          status: net.tokenStatus,
        });
      }
      const filters = JSON.parse(init.body).structuredQuery.where.compositeFilter.filters;
      net.employeeIds = filters[0].fieldFilter.value.arrayValue.values.map(
        (value: { stringValue: string }) => value.stringValue,
      );
      const since = filters[1].fieldFilter.value.timestampValue;
      net.queries.push(since);
      const rows = db
        .filter(
          (doc) => (doc.fields.timestamp as { timestampValue: string }).timestampValue > since,
        )
        .map((doc) => ({ document: { name: `projects/p/documents/punches/${doc.id}`, ...doc } }));
      return new Response(JSON.stringify(rows.length ? rows : [{ readTime: "now" }]));
    },
  });
  vm.runInContext(extensionFile("background.js"), context);
  local.set("link", {
    refreshToken: "refresh",
    email: "va@x.com",
    employeeIds: ["va", "va-login"],
  });
  return { sync: () => context.sync() as Promise<void>, local, net };
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
  assert.match((worker.local.get("synced") as { error: string }).error, /sign in again/);
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
