import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
  type DocumentData,
  type Query,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "./firebase";
import { toMillis } from "./time";
import { createLiveStore, LOADING_STATE, type LiveSource, type LiveState } from "./live-store";
import type {
  Company,
  CompanyNotice,
  Department,
  Employee,
  LeaveRequest,
  OvertimeRequest,
  Punch,
} from "./types";

export type { LiveState } from "./live-store";

/**
 * Errors that will not clear by trying again. Retrying them only spends reads,
 * and on the free plan a spent daily quota ("resource-exhausted") stays spent
 * until tomorrow.
 */
const PERMANENT_ERRORS = new Set([
  "permission-denied",
  "unauthenticated",
  "invalid-argument",
  "failed-precondition",
  "not-found",
  "resource-exhausted",
]);

/** The one store behind every live read in the app. */
export const liveStore = createLiveStore({
  // Every listener that starts again reads all its documents again, and each
  // read counts against the daily quota. Keeping one open a few minutes after
  // its page closes costs nothing unless its documents change, and moving
  // between admin pages then reads nothing twice.
  keepAliveMs: 5 * 60_000,
  retryDelaysMs: [2_000, 10_000, 30_000, 60_000],
  retryable: (error) => !PERMANENT_ERRORS.has((error as { code?: string }).code ?? ""),
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The window every always-on admin read shares: the dashboard's today, the
 * late count, the late log's today and automatic punch-out. Three days covers
 * overnight shifts and every timezone; screens that look further back ask for
 * their own window only while they are open.
 */
export const RECENT_PUNCH_DAYS = 3;

/**
 * How far back an employee's own screens read their punches. Their status,
 * breaks and recent activity need days, not their whole history, which grows
 * without end and was read in full on every visit.
 */
export const EMPLOYEE_PUNCH_DAYS = 14;

/** A document as the app uses it: its fields, then its id, which always wins. */
export function readDoc<T>(snapshot: QueryDocumentSnapshot<DocumentData>): T {
  return { ...snapshot.data({ serverTimestamps: "estimate" }), id: snapshot.id } as T;
}

/**
 * Listens to a query, reusing the previous object for every document that did
 * not change so memoised views downstream only recompute for real changes.
 */
export function querySource<T>(
  build: () => Query,
  map: (snapshot: QueryDocumentSnapshot<DocumentData>) => T = readDoc,
): LiveSource<T[]> {
  return (emit, fail) => {
    let previous = new Map<string, T>();
    let previousList: T[] | null = null;
    return onSnapshot(
      build(),
      { includeMetadataChanges: true },
      (snapshot) => {
        const changes = snapshot.docChanges({ includeMetadataChanges: true });
        // Only the sync state moved (cache to server): same documents, same list,
        // so nothing downstream recomputes.
        if (previousList && changes.length === 0 && previousList.length === snapshot.size) {
          emit(previousList, snapshot.metadata);
          return;
        }
        const changed = new Set(changes.map((change) => change.doc.id));
        const next = new Map<string, T>();
        const list = snapshot.docs.map((item) => {
          const kept = previous.get(item.id);
          const value = kept !== undefined && !changed.has(item.id) ? kept : map(item);
          next.set(item.id, value);
          return value;
        });
        previous = next;
        previousList = list;
        emit(list, snapshot.metadata);
      },
      (error) => fail(error),
    );
  };
}

function isMissingIndex(error: Error): boolean {
  return (error as { code?: string }).code === "failed-precondition";
}

/**
 * Tries a narrow query first. If Firestore has no index for it yet (see
 * firestore.indexes.json), it falls back to the wider one, which is always
 * correct and only costs more reads, so the app never breaks on a missing index.
 */
export function withIndexFallback<T>(narrow: LiveSource<T>, wide: LiveSource<T>): LiveSource<T> {
  return (emit, fail) => {
    let stop = narrow(emit, (error) => {
      if (!isMissingIndex(error)) return fail(error);
      console.warn(
        "A Firestore index is missing, so a wider query is used. Deploy firestore.indexes.json to read less.",
        error.message,
      );
      stop = wide(emit, fail);
    });
    return () => stop();
  };
}

const IDLE_SUBSCRIBE = () => () => {};
const IDLE_SNAPSHOT = () => LOADING_STATE;

/**
 * Reads a shared live query. `key` names it: every caller using the same key
 * shares one listener, so pick keys that describe the query exactly. A null key
 * reads nothing, for data that depends on something not known yet.
 */
export function useLiveQuery<T>(
  key: string | null,
  createSource: () => LiveSource<T>,
): LiveState<T> {
  const sourceRef = useRef(createSource);
  sourceRef.current = createSource;
  const subscribe = useCallback(
    (listener: () => void) =>
      key ? liveStore.subscribe<T>(key, () => sourceRef.current(), listener) : () => {},
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? liveStore.getState<T>(key) : (LOADING_STATE as LiveState<T>)),
    [key],
  );
  return useSyncExternalStore(
    key ? subscribe : IDLE_SUBSCRIBE,
    key ? getSnapshot : (IDLE_SNAPSHOT as () => LiveState<T>),
    IDLE_SNAPSHOT as () => LiveState<T>,
  );
}

const EMPTY: never[] = [];

/** The list, or an empty one until it loads. Stable while nothing changes. */
export function listOf<T>(state: LiveState<T[]>): T[] {
  return state.data ?? (EMPTY as T[]);
}

/** Loaded from the server, with nothing of ours still waiting to be confirmed. */
export function isSettled(...states: LiveState<unknown>[]): boolean {
  return states.every((state) => state.status === "ready" && !state.syncing);
}

/** The first error among several reads, as a message for the page. */
export function liveError(...states: LiveState<unknown>[]): string {
  const failed = states.find((state) => state.status === "error");
  return failed?.error ? failed.error.message : "";
}

// ---------------------------------------------------------------------------
// Shared collections. Admin screens read these whole; Firestore rules decide
// who may.
// ---------------------------------------------------------------------------

/** A whole collection. `enabled: false` reads nothing, for hooks that must always run. */
export function useCollectionLive<T>(name: string, enabled = true): LiveState<T[]> {
  return useLiveQuery<T[]>(enabled ? name : null, () =>
    querySource<T>(() => collection(db(), name)),
  );
}

export const useEmployeesLive = (enabled = true) =>
  useCollectionLive<Employee>("employees", enabled);
export const useCompaniesLive = (enabled = true) =>
  useCollectionLive<Company>("companies", enabled);
export const useDepartmentsLive = (enabled = true) =>
  useCollectionLive<Department>("departments", enabled);
export const useLeaveRequestsLive = (enabled = true) =>
  useCollectionLive<LeaveRequest>("leaveRequests", enabled);
export const useOvertimeRequestsLive = (enabled = true) =>
  useCollectionLive<OvertimeRequest>("overtimeRequests", enabled);

/**
 * The newest notices. Every leave decision, holiday and automatic punch-out adds
 * one, and employee screens used to read them all on every visit.
 */
export const LATEST_NOTICES = 200;
export function useLatestNoticesLive(count = LATEST_NOTICES): LiveState<CompanyNotice[]> {
  return useLiveQuery<CompanyNotice[]>(`notices:latest:${count}`, () =>
    querySource<CompanyNotice>(() =>
      query(collection(db(), "notices"), orderBy("createdAt", "desc"), limit(count)),
    ),
  );
}

/** Documents whose `field` equals `value`, shared by every reader asking the same. */
export function useWhereEqualLive<T>(
  name: string,
  field: string,
  value: string | null,
): LiveState<T[]> {
  return useLiveQuery<T[]>(value === null ? null : `${name}:${field}=${value}`, () =>
    querySource<T>(() => query(collection(db(), name), where(field, "==", value))),
  );
}

// ---------------------------------------------------------------------------
// Punches
// ---------------------------------------------------------------------------

/** Day-aligned, so screens asking for the same window share it all day. */
function windowStartKey(days: number, nowMs = Date.now()): string {
  return new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
}

/** Punches on or after a date (UTC midnight), shared by everyone asking for it. */
export function usePunchesSinceLive(dateKey: string | null): LiveState<Punch[]> {
  const valid = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : null;
  return useLiveQuery<Punch[]>(valid ? `punches:since:${valid}` : null, () =>
    querySource<Punch>(() =>
      query(
        collection(db(), "punches"),
        where("timestamp", ">=", Timestamp.fromDate(new Date(`${valid}T00:00:00Z`))),
      ),
    ),
  );
}

/** Punches from one date (UTC midnight) up to, not including, another. */
export function usePunchesBetweenLive(
  fromKey: string | null,
  toKey: string | null,
): LiveState<Punch[]> {
  const valid =
    fromKey && toKey && /^\d{4}-\d{2}-\d{2}$/.test(fromKey) && /^\d{4}-\d{2}-\d{2}$/.test(toKey);
  return useLiveQuery<Punch[]>(valid ? `punches:between:${fromKey}:${toKey}` : null, () =>
    querySource<Punch>(() =>
      query(
        collection(db(), "punches"),
        where("timestamp", ">=", Timestamp.fromDate(new Date(`${fromKey}T00:00:00Z`))),
        where("timestamp", "<", Timestamp.fromDate(new Date(`${toKey}T00:00:00Z`))),
      ),
    ),
  );
}

/** The date `days` before today, as the start of a recent window. */
export function recentWindowStart(days = RECENT_PUNCH_DAYS, nowMs = Date.now()): string {
  return windowStartKey(days, nowMs);
}

/**
 * Punches from roughly the last `days` days. The window is fixed when the
 * reader mounts, so a page left open never flips back to loading at midnight.
 */
export function useRecentPunchesLive(days = RECENT_PUNCH_DAYS, enabled = true): LiveState<Punch[]> {
  const since = useMemo(() => windowStartKey(days), [days]);
  return usePunchesSinceLive(enabled ? since : null);
}

/** Every id a person's records can be filed under: their profile and their login. */
export function employeeRecordIds(
  employee: Pick<Employee, "id" | "authUid"> | null | undefined,
): string[] {
  if (!employee) return [];
  return [
    ...new Set([employee.id, employee.authUid].filter((id): id is string => Boolean(id))),
  ].sort();
}

function byEmployeeIds(name: string, ids: string[]): Query {
  return ids.length > 1
    ? query(collection(db(), name), where("employeeId", "in", ids.slice(0, 10)))
    : query(collection(db(), name), where("employeeId", "==", ids[0]));
}

/**
 * One person's punches, under their profile id and login uid alike, from the
 * last `days` days (null: their whole history, for the admin's profile page).
 * The punch page, the header, reminders and automatic punch-out all read the
 * same window, so none of them can miss a punch the others see.
 */
export function useEmployeePunchesLive(
  employee: Pick<Employee, "id" | "authUid"> | null | undefined,
  days: number | null = EMPLOYEE_PUNCH_DAYS,
): LiveState<Punch[]> {
  const ids = employeeRecordIds(employee);
  const since = useMemo(() => (days === null ? null : windowStartKey(days)), [days]);
  const key = ids.length
    ? `punches:employee:${ids.join(",")}${since ? `:since:${since}` : ""}`
    : null;
  return useLiveQuery<Punch[]>(key, () => {
    const whole = querySource<Punch>(() => byEmployeeIds("punches", ids));
    if (!since) return whole;
    return withIndexFallback(
      querySource<Punch>(() =>
        query(
          byEmployeeIds("punches", ids),
          where("timestamp", ">=", Timestamp.fromDate(new Date(`${since}T00:00:00Z`))),
        ),
      ),
      whole,
    );
  });
}

/**
 * Leave that ends on or after a date, for screens that only judge recent days
 * (the dashboard, the late count). The whole leave history grows every month.
 */
export function useLeavesEndingSinceLive(dateKey: string | null): LiveState<LeaveRequest[]> {
  const valid = dateKey && /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : null;
  return useLiveQuery<LeaveRequest[]>(valid ? `leaveRequests:dateTo>=${valid}` : null, () =>
    querySource<LeaveRequest>(() =>
      query(collection(db(), "leaveRequests"), where("dateTo", ">=", valid)),
    ),
  );
}

/** Overtime requests dated within a period, for a report over that period. */
export function useOvertimeBetweenLive(
  fromKey: string | null,
  toKey: string | null,
): LiveState<OvertimeRequest[]> {
  const valid =
    fromKey && toKey && /^\d{4}-\d{2}-\d{2}$/.test(fromKey) && /^\d{4}-\d{2}-\d{2}$/.test(toKey);
  return useLiveQuery<OvertimeRequest[]>(
    valid ? `overtimeRequests:date:${fromKey}:${toKey}` : null,
    () =>
      querySource<OvertimeRequest>(() =>
        query(
          collection(db(), "overtimeRequests"),
          where("date", ">=", fromKey),
          where("date", "<=", toKey),
        ),
      ),
  );
}

/** One person's leave requests, under either of their ids. */
export function useEmployeeLeavesLive(
  employee: Pick<Employee, "id" | "authUid"> | null | undefined,
): LiveState<LeaveRequest[]> {
  const ids = employeeRecordIds(employee);
  const key = ids.length ? `leaveRequests:employee:${ids.join(",")}` : null;
  return useLiveQuery<LeaveRequest[]>(key, () =>
    querySource<LeaveRequest>(() => byEmployeeIds("leaveRequests", ids)),
  );
}

/** One person's overtime requests, under either of their ids. */
export function useEmployeeOvertimeLive(
  employee: Pick<Employee, "id" | "authUid"> | null | undefined,
): LiveState<OvertimeRequest[]> {
  const ids = employeeRecordIds(employee);
  const key = ids.length ? `overtimeRequests:employee:${ids.join(",")}` : null;
  return useLiveQuery<OvertimeRequest[]>(key, () =>
    querySource<OvertimeRequest>(() => byEmployeeIds("overtimeRequests", ids)),
  );
}

/** Sorted oldest first, without voided corrections or unstamped drafts. */
export function activePunchesInOrder(punches: Punch[]): Punch[] {
  return punches
    .filter((punch) => !punch.voidedAt && punch.timestamp)
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
}
