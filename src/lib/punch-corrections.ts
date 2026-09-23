import { collection, deleteField, doc, Timestamp, writeBatch } from "firebase/firestore";
import { db } from "./firebase";
import { attendanceNow } from "./attendance-clock";
import { getShiftTimezone } from "./attendance";
import { calculateAttendanceSession, type AttendanceCalculation } from "./attendance-calculation";
import { planManualClockIn } from "./manual-clock-in";
import type { Company, Employee, Punch } from "./types";

export interface PunchCorrectionInput {
  /** Company-scoped employee whose shift is being corrected. */
  employee: Employee;
  /** Profile the punch is filed under, for its id and name. */
  profile: Employee;
  companyId: string;
  companyName?: string;
  company?: Company | null;
  punches: Punch[];
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

/**
 * Writes one shift's corrected clock-in, and clock-out when given, as real punch
 * records. Every screen that lets an admin fix a punch goes through here, so a
 * correction made in the report lands the same way as one made in the late log.
 */
export async function applyPunchCorrection({
  employee,
  profile,
  companyId,
  companyName,
  company,
  punches,
  punchIn,
  punchOut = null,
  now = attendanceNow(),
  reopen = false,
  actor = "admin",
  note,
  timezoneUsed,
}: PunchCorrectionInput): Promise<PunchCorrectionResult> {
  const plan = planManualClockIn(employee, punches, punchIn, now, reopen, punchOut);
  const shiftTimezone = getShiftTimezone(employee);
  const dateKey = plan.dateKey;
  const stamp = now.toISOString();
  // Stored totals have to follow the corrected times, or reports and payroll
  // keep reading the session as it was before the fix.
  const calculation = punchOut
    ? calculateAttendanceSession({
        employee,
        company,
        punchIn,
        punchOut,
        now,
        punches,
        isOffShiftDay: Boolean(plan.existing?.isOffShiftDay),
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

  const batch = writeBatch(db());
  const punchRef = plan.existing
    ? doc(db(), "punches", plan.existing.id)
    : doc(collection(db(), "punches"));
  batch.set(
    punchRef,
    {
      ...shared,
      type: "in",
      timestamp: Timestamp.fromDate(punchIn),
      attendanceStatus: calculation ? calculation.status : "in_progress",
      manualNote: note || "Clock-in corrected by admin",
      createdAt: plan.existing?.createdAt || stamp,
    },
    { merge: true },
  );

  let punchOutId: string | undefined;
  if (punchOut) {
    const outRef = plan.existingOut
      ? doc(db(), "punches", plan.existingOut.id)
      : doc(collection(db(), "punches"));
    punchOutId = outRef.id;
    batch.set(
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
    batch.update(doc(db(), "punches", punch.id), {
      voidedAt: stamp,
      voidedBy: actor,
      correctionPunchId: punchRef.id,
    });
  }

  await batch.commit();
  return {
    dateKey,
    punchInId: punchRef.id,
    punchOutId,
    voidedCount: plan.voided.length,
    calculation,
  };
}
