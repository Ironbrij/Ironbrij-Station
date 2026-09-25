import {
  collection,
  deleteField,
  doc,
  getDocsFromServer,
  query,
  runTransaction,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "./firebase";
import { attendanceNow } from "./attendance-clock";
import { getShiftTimezone } from "./attendance";
import {
  calculateAttendanceSession,
  formatWorkMinutes,
  type AttendanceCalculation,
} from "./attendance-calculation";
import { planManualClockIn } from "./manual-clock-in";
import { planOvertimeReconciliation } from "./overtime-reconcile";
import { AttendanceConflictError } from "./punch-session";
import { employeeRecordIds } from "./live-data";
import type { Company, Employee, OvertimeRequest, Punch } from "./types";

export interface PunchCorrectionInput {
  /** Company-scoped employee whose shift is being corrected. */
  employee: Employee;
  /** Profile the punch is filed under, for its id and name. */
  profile: Employee;
  companyId: string;
  companyName?: string;
  company?: Company | null;
  /**
   * What the screen had loaded. Only a fallback: the correction is planned
   * against the employee's punches as saved, read fresh from the server.
   */
  punches?: Punch[];
  punchIn: Date;
  punchOut?: Date | null;
  now?: Date;
  /** Void automatic clock-outs so a live shift reopens. Ignored with a punchOut. */
  reopen?: boolean;
  actor?: string;
  note?: string;
  timezoneUsed?: string;
}

export interface PunchCorrectionResult {
  dateKey: string;
  punchInId: string;
  punchOutId?: string;
  voidedCount: number;
  calculation: AttendanceCalculation | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The employee's saved punches around the shift being fixed, from the server
 * rather than any local copy. Three days either side covers overnight shifts
 * and their automatic clock-outs without reading their whole history; without
 * the composite index (firestore.indexes.json) it reads the whole history, which
 * is only slower.
 */
async function loadSavedPunches(ids: string[], around: Date): Promise<Punch[]> {
  const byEmployee = where("employeeId", "in", ids.slice(0, 10));
  let snapshot;
  try {
    snapshot = await getDocsFromServer(
      query(
        collection(db(), "punches"),
        byEmployee,
        where("timestamp", ">=", Timestamp.fromDate(new Date(around.getTime() - 3 * DAY_MS))),
        where("timestamp", "<=", Timestamp.fromDate(new Date(around.getTime() + 3 * DAY_MS))),
      ),
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "failed-precondition") throw error;
    snapshot = await getDocsFromServer(query(collection(db(), "punches"), byEmployee));
  }
  return snapshot.docs.map((item) => ({ ...item.data(), id: item.id }) as Punch);
}

/** Only the overtime filed for this shift's own punches. */
async function loadLinkedOvertime(inId?: string, outId?: string): Promise<OvertimeRequest[]> {
  const reads = [
    inId ? where("punchInId", "==", inId) : null,
    outId ? where("punchOutId", "==", outId) : null,
  ]
    .filter((clause) => clause !== null)
    .map((clause) => getDocsFromServer(query(collection(db(), "overtimeRequests"), clause)));
  const found = new Map<string, OvertimeRequest>();
  for (const snapshot of await Promise.all(reads)) {
    for (const item of snapshot.docs) {
      found.set(item.id, { ...item.data(), id: item.id } as OvertimeRequest);
    }
  }
  return [...found.values()];
}

/**
 * Writes one shift's corrected clock-in, and clock-out when given, as real punch
 * records. Every screen that lets an admin fix a punch goes through here, so a
 * correction made in the report lands the same way as one made in the late log
 * or on the employee's profile.
 *
 * The correction is planned against the punches as saved, not against whatever
 * window the calling screen happened to load, so fixing an older day corrects
 * that day's punches instead of adding a second clock-in beside them. It is
 * written in one transaction that re-reads what it replaces, and the overtime
 * waiting for approval on that shift is brought in line with the new times.
 */
export async function applyPunchCorrection({
  employee,
  profile,
  companyId,
  companyName,
  company,
  punchIn,
  punchOut = null,
  now = attendanceNow(),
  reopen = false,
  actor = "admin",
  note,
  timezoneUsed,
}: PunchCorrectionInput): Promise<PunchCorrectionResult> {
  const ids = [...new Set([...employeeRecordIds(profile), ...employeeRecordIds(employee)])];
  const saved = await loadSavedPunches(ids, punchIn);
  const punches = saved.filter((punch) => !punch.voidedAt);

  const plan = planManualClockIn(employee, punches, punchIn, now, reopen, punchOut);
  const savedOvertime = await loadLinkedOvertime(plan.existing?.id, plan.existingOut?.id);
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = plan.dateKey;
  const stamp = now.toISOString();
  // Stored totals have to follow the corrected times, or reports and payroll
  // keep reading the session as it was before the fix.
  const isOffShiftDay = Boolean(plan.existing?.isOffShiftDay);
  const calculation = punchOut
    ? calculateAttendanceSession({
        employee,
        company,
        punchIn,
        punchOut,
        now,
        punches,
        isOffShiftDay,
      })
    : null;

  const shared = {
    employeeId: plan.existing?.employeeId || profile.id,
    employeeName: profile.name,
    companyId,
    ...(companyName ? { companyName } : {}),
    date: dateKey,
    attendanceDate: dateKey,
    source: "app" as const,
    shiftTimezone,
    ...(timezoneUsed ? { manualTimezoneUsed: timezoneUsed } : {}),
    addedByAdmin: actor,
    correctedAt: stamp,
    scheduledShiftStart: plan.shift.start.toISOString(),
    scheduledShiftEnd: plan.shift.end.toISOString(),
  };

  const punchRef = plan.existing
    ? doc(db(), "punches", plan.existing.id)
    : doc(collection(db(), "punches"));
  const outRef = punchOut
    ? plan.existingOut
      ? doc(db(), "punches", plan.existingOut.id)
      : doc(collection(db(), "punches"))
    : null;

  const overtime = planOvertimeReconciliation({
    requests: savedOvertime,
    punchInId: punchRef.id,
    punchOutId: outRef?.id,
    overtimeMinutes: calculation ? calculation.overtimeMinutes : null,
    normalWorkMinutes: calculation?.normalWorkMinutes ?? 0,
    earlyMinutes: Math.floor((plan.shift.start.getTime() - punchIn.getTime()) / 60_000),
    dateKey,
    employeeId: shared.employeeId,
    employeeName: profile.name,
    companyId,
    isOffShiftDay,
    stamp,
    describe: formatWorkMinutes,
  });

  await runTransaction(db(), async (transaction) => {
    // Everything this correction replaces is re-read: if another admin, the
    // employee or automatic punch-out changed it since it was planned, stop.
    const replaced = [plan.existing, plan.existingOut, ...plan.voided].filter(
      (punch): punch is Punch => Boolean(punch),
    );
    const current = await Promise.all(
      replaced.map((punch) => transaction.get(doc(db(), "punches", punch.id))),
    );
    const overtimeCurrent = await Promise.all(
      [
        ...overtime.updates.map((item) => item.id),
        ...overtime.deletes,
        ...overtime.creates.map((item) => item.id),
      ].map((id) => transaction.get(doc(db(), "overtimeRequests", id))),
    );
    replaced.forEach((punch, index) => {
      const snapshot = current[index];
      const data = snapshot.data() as Punch | undefined;
      if (!snapshot.exists() || data?.voidedAt) {
        throw new AttendanceConflictError(
          "These punches were changed while you were fixing them. Check the latest times and try again.",
        );
      }
      if (
        punch === plan.existing &&
        (data?.closedByPunchId ?? null) !== (punch.closedByPunchId ?? null)
      ) {
        throw new AttendanceConflictError(
          "This shift was ended or reopened while you were fixing it. Check the latest times and try again.",
        );
      }
    });
    // An overtime request decided in the meantime is a decision on record.
    const stillPending = (index: number) => {
      const snapshot = overtimeCurrent[index];
      return snapshot.exists() && (snapshot.data() as OvertimeRequest).status === "pending";
    };

    const reopening = plan.voided.length > 0;
    transaction.set(
      punchRef,
      {
        ...shared,
        type: "in",
        timestamp: Timestamp.fromDate(punchIn),
        attendanceStatus: calculation ? calculation.status : "in_progress",
        manualNote: note || "Clock-in corrected by admin",
        createdAt: plan.existing?.createdAt || stamp,
        // The shift's marks follow the correction, so every writer agrees on
        // whether it is open.
        ...(outRef
          ? { closedByPunchId: outRef.id, closedAt: stamp, breakPunchId: null }
          : reopening
            ? { closedByPunchId: null, closedAt: null }
            : {}),
      },
      { merge: true },
    );

    if (outRef && punchOut) {
      transaction.set(
        outRef,
        {
          ...shared,
          type: "out",
          timestamp: Timestamp.fromDate(punchOut),
          punchInId: punchRef.id,
          // An admin-entered time is a real record, never an automatic one.
          isAuto: false,
          autoReason: deleteField(),
          manualNote: note || "Clock-out corrected by admin",
          createdAt: plan.existingOut?.createdAt || stamp,
          ...(calculation
            ? {
                normalWorkMinutes: calculation.normalWorkMinutes,
                overtimeMinutes: calculation.overtimeMinutes,
                totalEligibleMinutes: calculation.totalEligibleMinutes,
                attendanceStatus: calculation.status,
              }
            : {}),
        },
        { merge: true },
      );
    }

    for (const punch of plan.voided) {
      transaction.update(doc(db(), "punches", punch.id), {
        voidedAt: stamp,
        voidedBy: actor,
        correctionPunchId: punchRef.id,
      });
    }

    let index = 0;
    for (const item of overtime.updates) {
      if (stillPending(index++)) {
        transaction.update(doc(db(), "overtimeRequests", item.id), item.data);
      }
    }
    for (const id of overtime.deletes) {
      if (stillPending(index++)) transaction.delete(doc(db(), "overtimeRequests", id));
    }
    for (const item of overtime.creates) {
      if (!overtimeCurrent[index++].exists()) {
        transaction.set(doc(db(), "overtimeRequests", item.id), item.data);
      }
    }
  });

  return {
    dateKey,
    punchInId: punchRef.id,
    punchOutId: outRef?.id,
    voidedCount: plan.voided.length,
    calculation,
  };
}
