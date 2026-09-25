import test from "node:test";
import assert from "node:assert/strict";
import { createLiveStore, type LiveMeta, type LiveSource } from "../src/lib/live-store.ts";

/** A fake listener the test can push snapshots and errors through. */
function fakeSource<T>() {
  const calls = { started: 0, stopped: 0 };
  let emit: ((data: T, meta: LiveMeta) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const source: LiveSource<T> = (onData, onError) => {
    calls.started += 1;
    emit = onData;
    fail = onError;
    return () => {
      calls.stopped += 1;
      emit = null;
      fail = null;
    };
  };
  return {
    source,
    calls,
    push(data: T, meta: Partial<LiveMeta> = {}) {
      emit?.(data, { fromCache: false, hasPendingWrites: false, ...meta });
    },
    error(message = "unavailable") {
      fail?.(new Error(message));
    },
    fail(error: Error) {
      fail?.(error);
    },
  };
}

/** Timers the test fires by hand. */
function manualTimers() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  return {
    setTimer: (callback: () => void, ms: number) => {
      const id = nextId++;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimer: (id: unknown) => {
      pending.delete(id as number);
    },
    runAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, timer] of due) timer.callback();
    },
    delays: () => [...pending.values()].map((timer) => timer.ms),
    count: () => pending.size,
  };
}

test("every reader of one key shares a single listener and sees the same snapshot", () => {
  const timers = manualTimers();
  const store = createLiveStore(timers);
  const fake = fakeSource<string[]>();
  let dashboardRenders = 0;
  let lateLogRenders = 0;
  store.subscribe(
    "punches",
    () => fake.source,
    () => (dashboardRenders += 1),
  );
  store.subscribe(
    "punches",
    () => fake.source,
    () => (lateLogRenders += 1),
  );

  assert.equal(fake.calls.started, 1);
  assert.equal(store.getState("punches").status, "loading");

  fake.push(["in-1"]);
  assert.deepEqual(store.getState("punches").data, ["in-1"]);
  assert.equal(dashboardRenders, 1);
  assert.equal(lateLogRenders, 1);

  // A write made in one tab reaches every screen reading the query.
  fake.push(["in-1", "out-1"]);
  assert.deepEqual(store.getState("punches").data, ["in-1", "out-1"]);
  assert.equal(dashboardRenders, 2);
  assert.equal(lateLogRenders, 2);
});

test("the state object only changes when a snapshot arrives", () => {
  const store = createLiveStore(manualTimers());
  const fake = fakeSource<number>();
  store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  fake.push(1);
  const first = store.getState("k");
  assert.equal(store.getState("k"), first);
  fake.push(2);
  assert.notEqual(store.getState("k"), first);
});

test("cached or unconfirmed data is marked as still syncing", () => {
  const store = createLiveStore(manualTimers());
  const fake = fakeSource<string>();
  store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  fake.push("cached", { fromCache: true });
  assert.equal(store.getState("k").status, "ready");
  assert.equal(store.getState("k").syncing, true);
  fake.push("pending", { hasPendingWrites: true });
  assert.equal(store.getState("k").syncing, true);
  fake.push("confirmed");
  assert.equal(store.getState("k").syncing, false);
});

test("a failed listener keeps the last good data, reports the error and retries", () => {
  const timers = manualTimers();
  const store = createLiveStore({ ...timers, retryDelaysMs: [100, 500] });
  const fake = fakeSource<string>();
  store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  fake.push("before outage");
  fake.error("network");

  const failed = store.getState<string>("k");
  assert.equal(failed.status, "error");
  assert.equal(failed.error?.message, "network");
  assert.equal(failed.data, "before outage", "never blank the screen on a dropped listener");
  assert.equal(fake.calls.stopped, 1);
  assert.deepEqual(timers.delays(), [100]);

  timers.runAll();
  assert.equal(fake.calls.started, 2, "retried on its own");
  fake.error("still down");
  assert.deepEqual(timers.delays(), [500], "backs off");
  timers.runAll();
  fake.push("after outage");
  assert.equal(store.getState("k").status, "ready");
  assert.equal(store.getState("k").error, null);
});

test("retry() restarts a failed listener at once", () => {
  const timers = manualTimers();
  const store = createLiveStore({ ...timers, retryDelaysMs: [60_000] });
  const fake = fakeSource<string>();
  store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  fake.error();
  store.retry("k");
  assert.equal(fake.calls.started, 2);
  assert.equal(timers.count(), 0, "the scheduled retry is cancelled");
});

test("a listener outlives its last reader briefly, so navigating back is instant", () => {
  const timers = manualTimers();
  const store = createLiveStore({ ...timers, keepAliveMs: 60_000 });
  const fake = fakeSource<string>();
  const leave = store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  fake.push("data");
  leave();
  assert.equal(fake.calls.stopped, 0);
  assert.deepEqual(timers.delays(), [60_000]);

  // The next page reads the same key before the grace runs out.
  store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  assert.equal(fake.calls.started, 1, "no second listener");
  assert.equal(store.getState("k").data, "data");
  assert.equal(timers.count(), 0);
});

test("once nobody reads a key for the whole grace period its listener stops", () => {
  const timers = manualTimers();
  const store = createLiveStore(timers);
  const fake = fakeSource<string>();
  const leave = store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  fake.push("data");
  leave();
  leave();
  timers.runAll();
  assert.equal(fake.calls.stopped, 1);
  assert.deepEqual(store.activeKeys(), []);
  assert.equal(store.getState("k").status, "loading");
});

test("a sign-in change drops cached data and reloads what is still on screen", () => {
  const timers = manualTimers();
  const store = createLiveStore(timers);
  const onScreen = fakeSource<string>();
  const offScreen = fakeSource<string>();
  store.subscribe(
    "visible",
    () => onScreen.source,
    () => {},
  );
  const leave = store.subscribe(
    "idle",
    () => offScreen.source,
    () => {},
  );
  onScreen.push("first account");
  offScreen.push("first account");
  leave();

  store.reset();
  assert.equal(store.getState("visible").data, undefined, "nothing from the old account shows");
  assert.equal(store.getState("visible").status, "loading");
  assert.equal(onScreen.calls.started, 2, "the screen still showing reloads");
  assert.equal(offScreen.calls.stopped, 1);
  assert.deepEqual(store.activeKeys(), ["visible"]);

  // Late callbacks from the listener that was stopped are ignored.
  onScreen.push("second account");
  assert.equal(store.getState("visible").data, "second account");
});

test("callbacks from a stopped listener never overwrite newer data", () => {
  const timers = manualTimers();
  const store = createLiveStore(timers);
  let staleEmit: ((data: string, meta: LiveMeta) => void) | null = null;
  let started = 0;
  const source: LiveSource<string> = (emit) => {
    started += 1;
    if (started === 1) staleEmit = emit;
    else emit("fresh", { fromCache: false, hasPendingWrites: false });
    return () => {};
  };
  store.subscribe(
    "k",
    () => source,
    () => {},
  );
  store.reset();
  assert.equal(store.getState("k").data, "fresh");
  staleEmit!("stale", { fromCache: false, hasPendingWrites: false });
  assert.equal(store.getState("k").data, "fresh");
});

test("an error that will not clear by itself is not retried, so it spends no more reads", () => {
  const timers = manualTimers();
  const store = createLiveStore({
    ...timers,
    retryable: (error) => (error as { code?: string }).code !== "resource-exhausted",
  });
  const fake = fakeSource<string>();
  store.subscribe(
    "k",
    () => fake.source,
    () => {},
  );
  fake.push("before the quota ran out");
  // A spent daily quota will not come back by asking again every 30 seconds.
  fake.fail(Object.assign(new Error("Quota exceeded."), { code: "resource-exhausted" }));
  assert.equal(store.getState("k").status, "error");
  assert.equal(store.getState("k").data, "before the quota ran out");
  assert.equal(timers.count(), 0, "no retry scheduled");
  // Asking explicitly still works, for a Retry button or the next day.
  store.retry("k");
  assert.equal(fake.calls.started, 2);
});
