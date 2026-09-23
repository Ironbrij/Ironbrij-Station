import type { Punch } from "./types.ts";
import { toMillis } from "./time.ts";

export function breakDurationMs(punches: Punch[], start: Date, end: Date): number {
  let open: number | null = null;
  let total = 0;
  for (const punch of [...punches].sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp))) {
    const time = toMillis(punch.timestamp);
    if (punch.voidedAt || time > end.getTime()) continue;
    if (punch.type === "lunch_start" && open === null) open = time;
    if ((punch.type === "lunch_end" || punch.type === "out" || punch.type === "extra_out") && open !== null) {
      total += Math.max(0, time - Math.max(open, start.getTime())); open = null;
    }
  }
  if (open !== null) total += Math.max(0, end.getTime() - Math.max(open, start.getTime()));
  return total;
}

/**
 * A break that was taken but never punched is still time away from work, and it
 * surfaces as a shift that ran a whole break longer than it should have.
 *
 * The charge is all or nothing: a break happens in one block, so an employee who
 * stayed a full allowance past their required hours is credited for the shift
 * rather than for the break inside it, while a shorter overrun stays real
 * overtime. Time up to the required hours is never touched.
 */
export function unloggedBreakMinutes({
  allowanceMinutes,
  loggedBreakMinutes,
  workedMinutes,
  requiredMinutes,
}: {
  allowanceMinutes: number;
  loggedBreakMinutes: number;
  workedMinutes: number;
  requiredMinutes: number;
}): number {
  const unclaimed = Math.max(0, Math.round(allowanceMinutes) - Math.round(loggedBreakMinutes));
  if (unclaimed <= 0) return 0;
  const beyondRequired = Math.max(0, Math.round(workedMinutes) - Math.max(0, requiredMinutes));
  return beyondRequired >= unclaimed ? unclaimed : 0;
}
