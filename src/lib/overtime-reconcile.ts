/**
 * Overtime requests are copies of numbers worked out from punches: minutes past
 * the shift, or minutes started early. When an admin corrects the punches, the
 * copies still waiting for a decision have to follow, or the Overtime page and
 * every report keep showing overtime the corrected shift no longer has.
 *
 * A request someone already approved or rejected is a decision on record and is
 * never changed here.
 */

import type { OvertimeRequest } from "./types.ts";
import { overtimeRequestId } from "./punch-session.ts";

export interface OvertimeReconcileInput {
  /** The employee's overtime requests, as saved. */
  requests: OvertimeRequest[];
  /** The corrected shift's clock-in. */
  punchInId: string;
  /** Its clock-out, when the correction set one. */
  punchOutId?: string;
  /** Minutes past the shift after the correction; null when no clock-out was set. */
  overtimeMinutes: number | null;
  normalWorkMinutes: number;
  /** Minutes started before the shift after the correction; null when not applicable. */
  earlyMinutes: number | null;
  dateKey: string;
  employeeId: string;
  employeeName: string;
  companyId: string;
  isOffShiftDay: boolean;
  stamp: string;
  describe: (minutes: number) => string;
}

export interface OvertimeReconcilePlan {
  creates: { id: string; data: Record<string, unknown> }[];
  updates: { id: string; data: Record<string, unknown> }[];
  deletes: string[];
}

export function planOvertimeReconciliation(input: OvertimeReconcileInput): OvertimeReconcilePlan {
  const plan: OvertimeReconcilePlan = { creates: [], updates: [], deletes: [] };
  const pending = (request: OvertimeRequest) => request.status === "pending";

  if (input.punchOutId && input.overtimeMinutes !== null) {
    const minutes = Math.max(0, Math.round(input.overtimeMinutes));
    const linked = input.requests.filter(
      (request) =>
        request.punchOutId === input.punchOutId && request.requestType !== "early_clock_in",
    );
    const reason = input.isOffShiftDay
      ? `Worked ${input.describe(minutes)} on an off-shift day (corrected by admin)`
      : `Worked ${input.describe(minutes)} past shift hours (corrected by admin)`;
    for (const request of linked.filter(pending)) {
      if (minutes > 0) {
        plan.updates.push({
          id: request.id,
          data: {
            overtimeMinutes: minutes,
            normalWorkMinutes: input.normalWorkMinutes,
            date: input.dateKey,
            reason,
            correctedAt: input.stamp,
          },
        });
      } else {
        plan.deletes.push(request.id);
      }
    }
    if (minutes > 0 && linked.length === 0) {
      plan.creates.push({
        id: overtimeRequestId("out", input.punchOutId),
        data: {
          employeeId: input.employeeId,
          employeeName: input.employeeName,
          companyId: input.companyId,
          date: input.dateKey,
          requestType: input.isOffShiftDay ? "off_shift_work" : "overtime",
          punchOutId: input.punchOutId,
          punchInId: input.punchInId,
          overtimeMinutes: minutes,
          normalWorkMinutes: input.normalWorkMinutes,
          isOffShiftDay: input.isOffShiftDay,
          reason,
          status: "pending",
          createdAt: input.stamp,
        },
      });
    }
  }

  // An early start is the employee's choice, so a correction never files one,
  // but one already waiting must match the corrected clock-in.
  const early =
    input.isOffShiftDay || input.earlyMinutes === null ? 0 : Math.max(0, input.earlyMinutes);
  for (const request of input.requests) {
    if (request.requestType !== "early_clock_in" || request.punchInId !== input.punchInId) continue;
    if (!pending(request)) continue;
    if (early >= 1) {
      plan.updates.push({
        id: request.id,
        data: {
          overtimeMinutes: early,
          date: input.dateKey,
          reason: `Early clock-in: started work ${input.describe(early)} before the shift (corrected by admin)`,
          correctedAt: input.stamp,
        },
      });
    } else {
      plan.deletes.push(request.id);
    }
  }

  return plan;
}
