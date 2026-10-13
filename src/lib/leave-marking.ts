import type { LeaveRequest } from "./types.ts";

/** Longest stretch one mark may cover, so a mistyped year cannot approve months of leave. */
export const MAX_MARKED_LEAVE_DAYS = 60;

/**
 * What an admin can record for a day the employee was away:
 * paid leave (uses their leave credits), unpaid leave, or a holiday, which is
 * simply a day off and uses neither credits nor counts as leave taken.
 */
export type LeaveMarkKind = "paid" | "unpaid" | "holiday";

export interface LeaveMarkInput {
  /** Profile id, the same one the employee's own leave requests are filed under. */
  employeeId: string;
  companyId: string;
  dateFrom: string;
  /** Last day off. Blank means the one day. */
  dateTo?: string;
  reason: string;
  kind: LeaveMarkKind;
  actor: string;
  decidedAt: string;
}

/** Everything of a leave request except the id and the server's creation time. */
export type MarkedLeave = Omit<LeaveRequest, "id" | "createdAt">;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A day marked as a holiday for one person: a day off, not leave taken. */
export function isHolidayLeave(
  leave: Pick<LeaveRequest, "leaveCategory"> | null | undefined,
): boolean {
  return leave?.leaveCategory === "holiday";
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000,
  );
}

/** Why the mark cannot be saved, or null when it can. */
export function leaveMarkProblem(
  input: Pick<LeaveMarkInput, "employeeId" | "dateFrom" | "dateTo" | "reason" | "kind">,
): string | null {
  if (!input.employeeId) return "Choose the employee.";
  if (!DATE_KEY.test(input.dateFrom)) return "Choose the date they are away.";
  if (input.dateTo) {
    if (!DATE_KEY.test(input.dateTo)) return "Choose the last day they are away.";
    if (input.dateTo < input.dateFrom) return "The last day is before the first day.";
    if (daysBetween(input.dateFrom, input.dateTo) + 1 > MAX_MARKED_LEAVE_DAYS)
      return `Mark at most ${MAX_MARKED_LEAVE_DAYS} days at a time.`;
  }
  if (!input.reason.trim())
    return input.kind === "holiday" ? "Add which holiday it is." : "Add the reason for the leave.";
  return null;
}

/**
 * An already approved full-day leave, for a VA who is away but never filed it.
 * It goes in the same collection as the leave a VA files themselves, so the late
 * log, dashboard, reports and daily report all read it with no extra wiring, and
 * "Revoke Leave" on the leave requests screen undoes it.
 *
 * A holiday is filed as category "holiday": reports show it as a holiday and the
 * leave credits ignore it, where paid leave would be charged to the credits.
 */
export function buildMarkedLeave(input: LeaveMarkInput): MarkedLeave {
  const reason = input.reason.trim();
  const holiday = input.kind === "holiday";
  return {
    employeeId: input.employeeId,
    companyId: input.companyId,
    leaveType: "full_day",
    leaveCategory: holiday ? "holiday" : "other",
    paymentStatus: input.kind === "unpaid" ? "unpaid" : "paid",
    dateFrom: input.dateFrom,
    dateTo: input.dateTo && input.dateTo > input.dateFrom ? input.dateTo : input.dateFrom,
    reason,
    remarks: reason,
    status: "approved",
    decidedAt: input.decidedAt,
    decidedBy: input.actor,
    decisionSource: "admin",
    decisionReason: holiday
      ? "Marked as a holiday from the late log"
      : "Marked on leave from the late log",
    markedFromLateLog: true,
  };
}
