import { collection, doc, runTransaction, type Transaction } from "firebase/firestore";
import { db } from "./firebase";
import {
  applyAutoClose,
  applyEmployeePunch,
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

/**
 * Records a punch the employee made, together with everything it implies, in
 * one transaction checked against the saved shift. Nothing is written when the
 * shift changed underneath the screen (AttendanceConflictError).
 */
export function recordEmployeePunch(plan: EmployeePunchPlan): Promise<void> {
  return runTransaction(db(), (transaction) =>
    applyEmployeePunch(firestoreDocTx(transaction), plan),
  );
}

/** Closes a shift nobody closed. False when someone else already did. */
export function autoCloseSession(plan: AutoClosePlan): Promise<boolean> {
  return runTransaction(db(), (transaction) =>
    applyAutoClose(firestoreDocTx(transaction), plan, toMillis),
  );
}
