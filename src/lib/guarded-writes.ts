import { doc, runTransaction, type DocumentData, type Transaction } from "firebase/firestore";
import { db } from "./firebase";
import { changedFields } from "./stale-check";

export { changedFields } from "./stale-check";

/**
 * Raised when a record changed after the screen showed it, so the write was not
 * made. The live data on screen already shows what changed.
 */
export class StaleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleWriteError";
  }
}

export function isStaleWrite(error: unknown): error is StaleWriteError {
  return (
    error instanceof StaleWriteError || (error instanceof Error && error.name === "StaleWriteError")
  );
}

type Status = string;

function describeDecision(data: DocumentData): string {
  const who = typeof data.decidedBy === "string" && data.decidedBy ? ` by ${data.decidedBy}` : "";
  return `${data.status}${who}`;
}

/**
 * Moves a leave or overtime request to a new status only if it still has one of
 * the statuses the screen showed. Two admins deciding the same request, or an
 * admin approving what the employee just cancelled, used to be decided by
 * whoever wrote last. Now the second one is told instead.
 */
export async function decideRequest({
  collectionName,
  id,
  expected,
  update,
  alsoWrite,
}: {
  collectionName: "leaveRequests" | "overtimeRequests";
  id: string;
  expected: Status[];
  update: Record<string, unknown>;
  /** Further writes that must happen with the decision or not at all. */
  alsoWrite?: (transaction: Transaction, current: DocumentData) => void;
}): Promise<DocumentData> {
  const ref = doc(db(), collectionName, id);
  return runTransaction(db(), async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new StaleWriteError("This request no longer exists.");
    const current = snapshot.data();
    if (!expected.includes(current.status)) {
      throw new StaleWriteError(`This request was already ${describeDecision(current)}.`);
    }
    transaction.update(ref, update);
    alsoWrite?.(transaction, current);
    return current;
  });
}

/**
 * Decides many requests in one transaction, skipping any whose status changed
 * since the screen listed them. Returns how many were decided and skipped.
 */
export async function decideRequests({
  collectionName,
  ids,
  expected,
  update,
}: {
  collectionName: "leaveRequests" | "overtimeRequests";
  ids: string[];
  expected: Status[];
  update: Record<string, unknown>;
}): Promise<{ decided: number; skipped: number }> {
  let decided = 0;
  let skipped = 0;
  // A transaction holds at most 500 writes; stay well inside it.
  for (let start = 0; start < ids.length; start += 200) {
    const chunk = ids.slice(start, start + 200);
    const result = await runTransaction(db(), async (transaction) => {
      const snapshots = await Promise.all(
        chunk.map((id) => transaction.get(doc(db(), collectionName, id))),
      );
      let chunkDecided = 0;
      snapshots.forEach((snapshot) => {
        if (snapshot.exists() && expected.includes(snapshot.data().status)) {
          transaction.update(snapshot.ref, update);
          chunkDecided += 1;
        }
      });
      return chunkDecided;
    });
    decided += result;
    skipped += chunk.length - result;
  }
  return { decided, skipped };
}

/**
 * Creates a document under a name derived from what it is about, unless it
 * already exists. Run twice, from two tabs or two admins, it files one record.
 */
export async function createIfAbsent(
  path: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const ref = doc(db(), path);
  return runTransaction(db(), async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (snapshot.exists()) return false;
    transaction.set(ref, data);
    return true;
  });
}

/**
 * Saves an edit form only if the fields it shows are still what they were when
 * the form opened. Another admin's change in the meantime is reported instead
 * of being overwritten with the older values the form still holds.
 */
export async function updateIfUnchanged({
  path,
  baseline,
  watched,
  update,
  what = "This record",
}: {
  path: string;
  baseline: Record<string, unknown>;
  watched: readonly string[];
  update: Record<string, unknown>;
  what?: string;
}): Promise<void> {
  const ref = doc(db(), path);
  await runTransaction(db(), async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists()) throw new StaleWriteError(`${what} was deleted.`);
    const changed = changedFields(baseline, snapshot.data(), watched);
    if (changed.length > 0) {
      throw new StaleWriteError(
        `${what} was changed by someone else while you were editing (${changed.join(", ")}). ` +
          "Close this form and open it again to see the latest details.",
      );
    }
    transaction.update(ref, update);
  });
}
