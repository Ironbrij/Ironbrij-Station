/**
 * One live listener per query, shared by every screen and background hook that
 * asks for it.
 *
 * Screens used to open their own Firestore listener for the same data, often
 * with a slightly different query, so two parts of the app could disagree about
 * the same punch or leave. Everything now reads a named entry here: the first
 * reader starts the listener, later readers get the same snapshot, and the
 * listener outlives the last reader briefly so moving between pages does not
 * reload what is already on screen.
 *
 * Kept free of Firebase so the lifecycle can be tested on its own.
 */

export type LiveStatus = "loading" | "ready" | "error";

export interface LiveState<T> {
  data: T | undefined;
  status: LiveStatus;
  /**
   * True while the data is only the local cache's copy or carries writes the
   * server has not confirmed. Nothing should be written on the strength of it.
   */
  syncing: boolean;
  error: Error | null;
  /** When the last snapshot arrived, in ms. 0 before the first one. */
  updatedAt: number;
}

export interface LiveMeta {
  fromCache: boolean;
  hasPendingWrites: boolean;
}

/** Starts listening and returns how to stop. */
export type LiveSource<T> = (
  emit: (data: T, meta: LiveMeta) => void,
  fail: (error: Error) => void,
) => () => void;

export interface LiveStoreOptions {
  /** How long a listener stays open after its last reader leaves. */
  keepAliveMs?: number;
  /** Delays before each retry after a listener fails; the last one repeats. */
  retryDelaysMs?: number[];
  /**
   * Whether an error is worth retrying on its own. A refused permission or a
   * spent daily quota will not fix itself, and retrying it only spends more.
   */
  retryable?: (error: Error) => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Entry {
  state: LiveState<unknown>;
  listeners: Set<() => void>;
  source: LiveSource<unknown> | null;
  stop: (() => void) | null;
  keepAliveTimer: unknown;
  retryTimer: unknown;
  attempts: number;
  /** Bumped on every start so a stopped listener's late callbacks are ignored. */
  generation: number;
}

export const LOADING_STATE: LiveState<never> = Object.freeze({
  data: undefined,
  status: "loading",
  syncing: true,
  error: null,
  updatedAt: 0,
}) as LiveState<never>;

export function createLiveStore(options: LiveStoreOptions = {}) {
  const keepAliveMs = options.keepAliveMs ?? 60_000;
  const retryable = options.retryable ?? (() => true);
  const retryDelays = options.retryDelaysMs?.length
    ? options.retryDelaysMs
    : [1_000, 3_000, 10_000, 30_000];
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const entries = new Map<string, Entry>();

  function notify(entry: Entry) {
    for (const listener of [...entry.listeners]) listener();
  }

  function setState(entry: Entry, state: LiveState<unknown>) {
    entry.state = state;
    notify(entry);
  }

  function stopSource(entry: Entry) {
    entry.generation += 1;
    const stop = entry.stop;
    entry.stop = null;
    if (stop) {
      try {
        stop();
      } catch {
        // A listener that fails to detach has nothing left to tell us.
      }
    }
  }

  function start(key: string, entry: Entry) {
    if (!entry.source || entry.stop) return;
    const generation = ++entry.generation;
    const current = () => entries.get(key) === entry && entry.generation === generation;
    const stop = entry.source(
      (data, meta) => {
        if (!current()) return;
        entry.attempts = 0;
        setState(entry, {
          data,
          status: "ready",
          syncing: meta.fromCache || meta.hasPendingWrites,
          error: null,
          updatedAt: now(),
        });
      },
      (error) => {
        if (!current()) return;
        // Firestore ends a listener after an error, so start a fresh one later.
        stopSource(entry);
        setState(entry, { ...entry.state, status: "error", syncing: true, error });
        scheduleRetry(key, entry);
      },
    );
    // A source can fail synchronously, which already detached it.
    if (entry.generation === generation) entry.stop = stop;
    else stop();
  }

  function scheduleRetry(key: string, entry: Entry) {
    if (entry.listeners.size === 0) return;
    if (entry.state.error && !retryable(entry.state.error)) return;
    const delay = retryDelays[Math.min(entry.attempts, retryDelays.length - 1)];
    entry.attempts += 1;
    entry.retryTimer = setTimer(() => {
      entry.retryTimer = undefined;
      if (entries.get(key) === entry && entry.listeners.size > 0) start(key, entry);
    }, delay);
  }

  function dispose(key: string, entry: Entry) {
    if (entry.retryTimer !== undefined) clearTimer(entry.retryTimer);
    if (entry.keepAliveTimer !== undefined) clearTimer(entry.keepAliveTimer);
    entry.retryTimer = undefined;
    entry.keepAliveTimer = undefined;
    stopSource(entry);
    if (entries.get(key) === entry) entries.delete(key);
  }

  return {
    /** Reads the current state; the same object until something changes. */
    getState<T>(key: string): LiveState<T> {
      return (entries.get(key)?.state ?? LOADING_STATE) as LiveState<T>;
    },

    /**
     * Adds a reader. The first reader starts `createSource()`; later readers
     * share it. Returns how to remove the reader.
     */
    subscribe<T>(key: string, createSource: () => LiveSource<T>, listener: () => void): () => void {
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          state: LOADING_STATE,
          listeners: new Set(),
          source: null,
          stop: null,
          keepAliveTimer: undefined,
          retryTimer: undefined,
          attempts: 0,
          generation: 0,
        };
        entries.set(key, entry);
      }
      const active = entry;
      if (active.keepAliveTimer !== undefined) {
        clearTimer(active.keepAliveTimer);
        active.keepAliveTimer = undefined;
      }
      active.listeners.add(listener);
      if (!active.source) active.source = createSource() as LiveSource<unknown>;
      if (!active.stop && active.retryTimer === undefined) start(key, active);

      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        active.listeners.delete(listener);
        if (active.listeners.size > 0 || entries.get(key) !== active) return;
        active.keepAliveTimer = setTimer(() => {
          active.keepAliveTimer = undefined;
          if (active.listeners.size === 0) dispose(key, active);
        }, keepAliveMs);
      };
    },

    /** Starts a failed listener again now instead of waiting for its next retry. */
    retry(key: string) {
      const entry = entries.get(key);
      if (!entry || entry.stop) return;
      if (entry.retryTimer !== undefined) clearTimer(entry.retryTimer);
      entry.retryTimer = undefined;
      entry.attempts = 0;
      setState(entry, {
        ...entry.state,
        status: entry.state.data === undefined ? "loading" : entry.state.status,
      });
      start(key, entry);
    },

    /**
     * Drops every cached result, for a sign-in change: nothing read under one
     * account may be shown under another. Readers still on screen reload.
     */
    reset() {
      for (const [key, entry] of [...entries]) {
        if (entry.retryTimer !== undefined) clearTimer(entry.retryTimer);
        entry.retryTimer = undefined;
        stopSource(entry);
        if (entry.listeners.size === 0) {
          dispose(key, entry);
          continue;
        }
        entry.attempts = 0;
        setState(entry, LOADING_STATE);
        start(key, entry);
      }
    },

    /** Keys with an open listener, for tests and diagnostics. */
    activeKeys(): string[] {
      return [...entries].filter(([, entry]) => entry.stop).map(([key]) => key);
    },
  };
}

export type LiveStore = ReturnType<typeof createLiveStore>;
