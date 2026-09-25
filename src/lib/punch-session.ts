/**
 * How every writer of attendance agrees on a shift's state.
 *
 * A punch used to be one blind write decided from whatever the writing screen
 * last saw. Two devices, a tab left open, or automatic punch-out could each
 * decide a shift was open and each write a clock-out (or a clock-in), and the
 * records then disagreed with each other forever.
 *
 * Now the shift's clock-in document is the lock. Whoever closes the shift marks
 * it (`closedByPunchId`), whoever starts the next one marks the punch it follows
 * (`nextPunchInId`), and a break marks the clock-in while it runs
 * (`breakPunchId`). Every write happens in a transaction that reads those marks
 * first, so the second of two racing writers sees the first one's mark and is
 * turned away instead of writing a duplicate.
 *
 * Kept free of Firebase: callers hand in a transaction and the field values.
 */

import type { Punch } from "./types.ts";

/** The document written when a shift is closed for the employee. */
export function sessionCloseId(punchInId: string): string {
  return `shift-timeout-${encodeURIComponent(punchInId)}`;
}

/**
 * Overtime requests are named after the punch they come from, so the same
 * overtime can never be filed twice, whichever screen files it.
 */
export function overtimeRequestId(kind: "out" | "early" | "extra", punchId: string): string {
  const prefix = kind === "out" ? "ot" : `ot-${kind}`;
  return `${prefix}-${encodeURIComponent(punchId)}`;
}

/** Raised when the saved attendance no longer matches what the screen showed. */
export class AttendanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttendanceConflictError";
  }
}

export function isAttendanceConflict(error: unknown): error is AttendanceConflictError {
  return (
    error instanceof AttendanceConflictError ||
    (error instanceof Error && error.name === "AttendanceConflictError")
  );
}

type Data = Record<string, unknown>;

/** The part of a Firestore transaction this protocol uses. Reads come first. */
export interface DocTx {
  get(path: string): Promise<Data | undefined>;
  set(path: string, data: Data): void;
  update(path: string, data: Data): void;
}

const STARTS = new Set(["in", "extra_in"]);
const CLOSES = new Set(["out", "extra_out"]);

/**
 * What the device believes about the employee's shifts, read from its punches:
 * the open shift at each company and the last shift that was closed.
 */
export function readSessionContext(punches: Punch[], companyOf: (punch: Punch) => string) {
  const ordered = punches
    .filter((punch) => !punch.voidedAt)
    .slice()
    .sort((a, b) => millis(a) - millis(b));
  const open = new Map<string, { in: Punch; breakPunch: Punch | null }>();
  let lastClose: Punch | null = null;
  for (const punch of ordered) {
    const company = companyOf(punch);
    if (STARTS.has(punch.type)) {
      open.set(company, { in: punch, breakPunch: null });
    } else if (CLOSES.has(punch.type)) {
      open.delete(company);
      lastClose = punch;
    } else if (punch.type === "lunch_start") {
      const session = open.get(company);
      if (session) session.breakPunch = punch;
    } else if (punch.type === "lunch_end") {
      const session = open.get(company);
      if (session) session.breakPunch = null;
    }
  }
  return { open, lastClose };
}

/**
 * The punch a new shift follows: the last clock-out, or a later clock-in that
 * was never closed (a forgotten punch-out from an earlier day).
 */
export function latestShiftBoundary(context: ReturnType<typeof readSessionContext>): Punch | null {
  let latest = context.lastClose;
  for (const session of context.open.values()) {
    if (!latest || millis(session.in) > millis(latest)) latest = session.in;
  }
  return latest;
}

function millis(punch: Punch): number {
  const value = punch.timestamp as unknown;
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "object" && value && "toMillis" in value) {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (typeof value === "object" && value && "seconds" in value) {
    return Number((value as { seconds: number }).seconds) * 1000;
  }
  const parsed = new Date(value as string).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface OvertimeWrite {
  id: string;
  data: Data;
  /**
   * "create" files the request once and never touches it again. "pending"
   * also refreshes a request still waiting for a decision, for overtime whose
   * minutes are only known when the session ends.
   */
  mode?: "create" | "pending";
  /** Where to file it instead when the named request was already decided. */
  fallbackId?: string;
}

export interface EmployeePunchPlan {
  /** The new punch's id, chosen before the transaction. */
  punchId: string;
  /** The new punch's fields. */
  punch: Data & { type: Punch["type"] };
  /** The open shift this punch ends, pauses or resumes. */
  sessionInId?: string;
  /**
   * For a new shift: the latest shift boundary this device knew about, the
   * last clock-out or a clock-in nobody ever closed. It is what two racing
   * starts both claim. An unclosed one is left open for an admin to fix.
   */
  followsPunchId?: string;
  /**
   * A shift at another company that this start ends. Its clock-in is what two
   * racing starts both claim, so `followsPunchId` is not used with it.
   */
  switchFrom?: { inId: string; close: Data };
  overtime?: OvertimeWrite[];
  /** ISO time, for the marks. */
  stamp: string;
}

/**
 * Writes one punch the employee made, and everything that follows from it, as
 * one transaction. Throws AttendanceConflictError when the shift is no longer
 * in the state the screen showed.
 */
export async function applyEmployeePunch(tx: DocTx, plan: EmployeePunchPlan): Promise<void> {
  const type = plan.punch.type;
  const starting = STARTS.has(type);
  const closing = CLOSES.has(type);
  const onBreak = type === "lunch_start" || type === "lunch_end";

  // Firestore wants every read before the first write.
  const sessionIn = plan.sessionInId ? await tx.get(`punches/${plan.sessionInId}`) : undefined;
  const followsPunchId = starting && !plan.switchFrom ? plan.followsPunchId : undefined;
  const followed = followsPunchId ? await tx.get(`punches/${followsPunchId}`) : undefined;
  const switchIn = plan.switchFrom ? await tx.get(`punches/${plan.switchFrom.inId}`) : undefined;
  const overtime = plan.overtime ?? [];
  const overtimeCurrent = await Promise.all(
    overtime.map((item) => tx.get(`overtimeRequests/${item.id}`)),
  );

  if (closing || onBreak) {
    if (!plan.sessionInId) {
      throw new AttendanceConflictError("There is no open shift to end. Check your latest status.");
    }
    if (!sessionIn || sessionIn.voidedAt) {
      throw new AttendanceConflictError(
        "This shift was changed by an administrator. Check your latest status and try again.",
      );
    }
    if (sessionIn.closedByPunchId) {
      throw new AttendanceConflictError(
        "This shift has already ended, on another device or automatically.",
      );
    }
    if (type === "lunch_start" && sessionIn.breakPunchId) {
      throw new AttendanceConflictError("A break is already running for this shift.");
    }
    // null means a break was ended; missing means the shift predates break marks.
    if (type === "lunch_end" && sessionIn.breakPunchId === null) {
      throw new AttendanceConflictError("This break has already ended.");
    }
  }

  let writeSwitchClose = false;
  if (starting) {
    if (followed?.nextPunchInId && followed.nextPunchInId !== plan.punchId) {
      throw new AttendanceConflictError(
        "Work was already started on another device or tab. Check your latest status.",
      );
    }
    if (followed?.voidedAt) {
      throw new AttendanceConflictError(
        "Your last shift was reopened by an administrator. Check your latest status.",
      );
    }
    if (plan.switchFrom && switchIn && !switchIn.voidedAt) {
      if (switchIn.nextPunchInId && switchIn.nextPunchInId !== plan.punchId) {
        throw new AttendanceConflictError(
          "Work was already started on another device or tab. Check your latest status.",
        );
      }
      writeSwitchClose = !switchIn.closedByPunchId;
    }
  }

  tx.set(`punches/${plan.punchId}`, {
    ...plan.punch,
    ...(closing && plan.sessionInId ? { punchInId: plan.sessionInId } : {}),
  });

  if (closing) {
    tx.update(`punches/${plan.sessionInId}`, {
      closedByPunchId: plan.punchId,
      closedAt: plan.stamp,
      breakPunchId: null,
    });
  } else if (type === "lunch_start") {
    tx.update(`punches/${plan.sessionInId}`, { breakPunchId: plan.punchId });
  } else if (type === "lunch_end") {
    tx.update(`punches/${plan.sessionInId}`, { breakPunchId: null });
  }

  if (starting) {
    if (followed && followsPunchId) {
      tx.update(`punches/${followsPunchId}`, { nextPunchInId: plan.punchId });
    }
    if (plan.switchFrom && switchIn && !switchIn.voidedAt) {
      const closeId = sessionCloseId(plan.switchFrom.inId);
      if (writeSwitchClose) {
        tx.set(`punches/${closeId}`, { ...plan.switchFrom.close, punchInId: plan.switchFrom.inId });
      }
      tx.update(`punches/${plan.switchFrom.inId}`, {
        ...(writeSwitchClose
          ? { closedByPunchId: closeId, closedAt: plan.stamp, breakPunchId: null }
          : {}),
        nextPunchInId: plan.punchId,
      });
    }
  }

  overtime.forEach((item, index) => {
    const current = overtimeCurrent[index];
    if (!current) {
      tx.set(`overtimeRequests/${item.id}`, item.data);
    } else if (item.mode === "pending" && current.status === "pending") {
      tx.update(`overtimeRequests/${item.id}`, item.data);
    } else if (item.mode === "pending" && item.fallbackId) {
      tx.set(`overtimeRequests/${item.fallbackId}`, item.data);
    }
  });
}

export interface AutoClosePlan {
  sessionInId: string;
  /** What the reconciler saw, to make sure the shift was not corrected since. */
  expected: { timestampMs: number; correctedAt?: string };
  close: Data;
  /** The start at another company that caused this close, when there is one. */
  nextPunchInId?: string;
  stamp: string;
}

/**
 * Closes a shift nobody closed: at its end, or when work started elsewhere.
 * Returns false, writing nothing, when someone already closed or changed it.
 */
export async function applyAutoClose(
  tx: DocTx,
  plan: AutoClosePlan,
  readMillis: (value: unknown) => number,
): Promise<boolean> {
  const closeId = sessionCloseId(plan.sessionInId);
  const existingClose = await tx.get(`punches/${closeId}`);
  const sessionIn = await tx.get(`punches/${plan.sessionInId}`);
  if (!sessionIn || sessionIn.voidedAt || sessionIn.closedByPunchId) return false;
  if (((sessionIn.correctedAt as string) || "") !== (plan.expected.correctedAt || "")) return false;
  if (readMillis(sessionIn.timestamp) !== plan.expected.timestampMs) return false;
  if (existingClose && !existingClose.voidedAt) return false;

  tx.set(`punches/${closeId}`, { ...plan.close, punchInId: plan.sessionInId });
  tx.update(`punches/${plan.sessionInId}`, {
    closedByPunchId: closeId,
    closedAt: plan.stamp,
    breakPunchId: null,
    ...(plan.nextPunchInId ? { nextPunchInId: plan.nextPunchInId } : {}),
  });
  return true;
}
