import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { zonedDateTimeToDate } from "../src/lib/attendance.ts";
import { clockBallState } from "../src/lib/clock-ball.ts";
import type { Employee, Punch } from "../src/lib/types.ts";

const emp = {
  id: "va",
  name: "VA",
  companyId: "alpha",
  companyIds: ["alpha"],
  shiftStartTime: "06:00",
  shiftEndTime: "14:00",
  shiftTimezone: "Australia/Sydney",
} as Employee;
const at = (time: string) => zonedDateTimeToDate("2026-08-10", time, "Australia/Sydney");
const ms = (time: string) => at(time).getTime();
const punch = (type: Punch["type"], time: string): Punch => ({
  id: type + time,
  employeeId: emp.id,
  companyId: "alpha",
  type,
  timestamp: { seconds: ms(time) / 1000, nanoseconds: 0 } as Punch["timestamp"],
});

// The extension's own file, loaded the way Chrome loads it.
const ball = vm.createContext({});
vm.runInContext(
  readFileSync(new URL("../extension/savytime-clock-ball/shared.js", import.meta.url), "utf8"),
  ball,
);
const view = (shift: object, time: string) => ball.clockBallView(shift, ms(time));

test("a running shift counts from clock-in and ends at the shift end", () => {
  const state = clockBallState([punch("in", "06:00")], emp, at("08:00"));
  assert.equal(state.active, true);
  assert.equal(state.countFrom, ms("06:00"));
  assert.equal(state.endsAt, ms("14:00"));
  assert.equal(state.pausedAt, 0);
  assert.equal(view(state, "08:14").time, "2:14:00");
  assert.equal(view(state, "14:00"), null);
});

test("a finished break is not counted and pushes the end out", () => {
  const punches = [
    punch("in", "06:00"),
    punch("lunch_start", "09:00"),
    punch("lunch_end", "09:30"),
  ];
  const state = clockBallState(punches, emp, at("10:00"));
  assert.equal(state.countFrom, ms("06:30"));
  assert.equal(state.endsAt, ms("14:30"));
  assert.equal(view(state, "10:00").time, "3:30:00");
  assert.ok(view(state, "14:20"));
});

test("a break holds the count still", () => {
  const punches = [punch("in", "06:00"), punch("lunch_start", "09:00")];
  const state = clockBallState(punches, emp, at("09:20"));
  assert.equal(state.pausedAt, ms("09:00"));
  assert.equal(view(state, "09:20").time, "3:00:00");
  assert.equal(view(state, "09:20").paused, true);
  // Twenty minutes of break so far: the shift runs twenty minutes later.
  assert.ok(view(state, "14:10"));
});

test("stopping work hides the ball", () => {
  const state = clockBallState([punch("in", "06:00"), punch("out", "11:00")], emp, at("11:05"));
  assert.equal(state.active, false);
  assert.equal(view(state, "11:05"), null);
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
  const net = { tokenStatus: 200, queries: [] as string[] };
  const context = vm.createContext({
    console,
    URLSearchParams,
    chrome: {
      storage: { local: area(local), session: area(session) },
      alarms: { create() {}, onAlarm: listener },
      runtime: { onInstalled: listener, onStartup: listener, onMessage: listener },
    },
    importScripts: () =>
      vm.runInContext(
        readFileSync(
          new URL("../extension/savytime-clock-ball/shared.js", import.meta.url),
          "utf8",
        ),
        context,
      ),
    fetch: async (url: string, init: { body: string }) => {
      if (url.startsWith("https://securetoken.googleapis.com/")) {
        return new Response(JSON.stringify({ id_token: "id", expires_in: "3600" }), {
          status: net.tokenStatus,
        });
      }
      const since = JSON.parse(init.body).structuredQuery.where.compositeFilter.filters[1]
        .fieldFilter.value.timestampValue;
      net.queries.push(since);
      const rows = db
        .filter(
          (doc) => (doc.fields.timestamp as { timestampValue: string }).timestampValue > since,
        )
        .map((doc) => ({ document: { name: `projects/p/documents/punches/${doc.id}`, ...doc } }));
      return new Response(JSON.stringify(rows.length ? rows : [{ readTime: "now" }]));
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("../extension/savytime-clock-ball/background.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  local.set("link", {
    refreshToken: "refresh",
    apiKey: "key",
    projectId: "p",
    employeeIds: ["va"],
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

test("the extension finds a punch-in in the database on its own", async () => {
  const end = new Date(Date.now() + 60 * 60e3).toISOString();
  const worker = backgroundWorker([stored("in", 120, { scheduledShiftEnd: { stringValue: end } })]);
  await worker.sync();
  const shift = worker.local.get("shift") as {
    active: boolean;
    countFrom: number;
    endsAt: number;
    company: string;
  };
  assert.equal(shift.active, true);
  assert.equal(shift.endsAt, Date.parse(end));
  assert.equal(shift.company, "Ironbrij");
  assert.ok(Math.abs(Date.now() - 120 * 60e3 - shift.countFrom) < 2000);
});

test("a punch-out made elsewhere, with no SavyTime tab open, hides the ball", async () => {
  const db = [stored("in", 120)];
  const worker = backgroundWorker(db);
  await worker.sync();
  assert.equal((worker.local.get("shift") as { active: boolean }).active, true);
  db.push(stored("out", 0));
  await worker.sync();
  assert.equal((worker.local.get("shift") as { active: boolean }).active, false);
  // The second check only asked for punches after the last one it had.
  assert.equal(
    worker.net.queries[1],
    (db[0].fields.timestamp as { timestampValue: string }).timestampValue,
  );
});

test("breaks, voided punches and other companies are read like SavyTime reads them", () => {
  const p = (type: string, at: number, extra = {}) => ({
    id: type + at,
    type,
    company: "alpha",
    companyName: "",
    at,
    endsAt: 0,
    voided: false,
    ...extra,
  });
  const state = ball.clockBallFromPunches([
    p("in", 1000, { endsAt: 9000 }),
    p("lunch_start", 2000),
    p("lunch_end", 2500),
    p("out", 3000, { voided: true }),
    p("out", 3100, { company: "beta" }),
    p("lunch_start", 4000),
  ]);
  assert.equal(state.active, true);
  assert.equal(state.countFrom, 1500);
  assert.equal(state.endsAt, 9500);
  assert.equal(state.pausedAt, 4000);
  assert.equal(ball.clockBallFromPunches([p("in", 1), p("out", 2)]).active, false);
});

test("a sign-in that no longer works is forgotten", async () => {
  const worker = backgroundWorker([stored("in", 10)]);
  worker.net.tokenStatus = 400;
  await worker.sync();
  assert.equal(worker.local.has("link"), false);
});
