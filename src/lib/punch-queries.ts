import { collection, query, Timestamp, where, type Query } from "firebase/firestore";
import { db } from "./firebase";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Punches from the last `days` days only.
 *
 * Every document a listener matches is billed as a read, and each admin page
 * used to listen to the whole punch history. Ask only for the window a screen
 * actually shows; a single-field range needs no composite index.
 */
export function recentPunchesQuery(days: number): Query {
  return punchesSinceQuery(new Date(Date.now() - days * DAY_MS));
}

export function punchesSinceQuery(since: Date): Query {
  return query(collection(db(), "punches"), where("timestamp", ">=", Timestamp.fromDate(since)));
}

/** One person's whole history: their punches are stored under their id or login uid. */
export function employeePunchesQuery(ids: string[]): Query {
  return query(collection(db(), "punches"), where("employeeId", "in", ids.slice(0, 10)));
}
