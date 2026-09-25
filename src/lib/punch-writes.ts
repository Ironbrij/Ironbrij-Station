import { collection, doc, runTransaction, writeBatch, type Transaction } from "firebase/firestore";
import { db } from "./firebase";
import {
  applyAutoClose,
  applyEmployeePunch,
  applyEmployeePunchUnchecked,
  type AutoClosePlan,
  type DocTx,
  type EmployeePunchPlan,
} from "./punch-session";
import { toMillis } from "./time";

/** Adapts a Firestore transaction to the shared attendance protocol. */
export function firestoreDocTx(transaction: Transaction): DocTx {
  return {
    async get(path) {
      const snapshot = await transaction.get(doc(db(), path));
      return snapshot.exists() ? (snapshot.data() as Record<string, unknown>) : undefined;
    },
    set(path, data) {
      transaction.set(doc(db(), path), data);
    },
    update(path, data) {
      transaction.update(doc(db(), path), data);
    },
  };
}

/** A fresh punch id, chosen before writing so related records can name it. */
export function newPunchId(): string {
  return doc(collection(db(), "punches")).id;
}

/** The free plan's daily reads (or writes) are spent until midnight Pacific time. */
export function isQuotaExceeded(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "resource-exhausted";
}

/**
 * Records a punch the employee made, together with everything it implies, in
 * one transaction checked against the saved shift. Nothing is written when the
 * shift changed underneath the screen (AttendanceConflictError).
 *
 * When the day's reads are spent the check cannot run, but writes may still go
 * through, so the punch is then saved without it rather than not at all.
 * Resolves to whether the check ran.
 */
export async function recordEmployeePunch(plan: EmployeePunchPlan): Promise<{ checked: boolean }> {
  try {
    await runTransaction(db(), (transaction) =>
      applyEmployeePunch(firestoreDocTx(transaction), plan),
    );
    return { checked: true };
  } catch (error) {
    if (!isQuotaExceeded(error)) throw error;
    const batch = writeBatch(db());
    applyEmployeePunchUnchecked(
      {
        set: (path, data) => batch.set(doc(db(), path), data),
        update: (path, data) => batch.update(doc(db(), path), data),
      },
      plan,
    );
    await batch.commit();
    return { checked: false };
  }
}

/** Closes a shift nobody closed. False when someone else already did. */
export function autoCloseSession(plan: AutoClosePlan): Promise<boolean> {
  return runTransaction(db(), (transaction) =>
    applyAutoClose(firestoreDocTx(transaction), plan, toMillis),
  );
}
