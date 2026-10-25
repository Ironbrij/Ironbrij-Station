/**
 * What the SavyTime Clock Ball browser extension shows.
 *
 * The page posts this to the extension, which keeps the ball counting after
 * the site is closed and after Chrome restarts. So it carries the moments to
 * count from, never a running total that would freeze with the tab.
 */

import { getActiveWorkingSession, getShiftCompletion } from "./attendance.ts";
import { getEmployeeForCompany, getPunchCompanyId } from "./company-context.ts";
import { toMillis } from "./time.ts";
import type { Company, Employee, Punch } from "./types.ts";

/** Page → extension messages carry this as `source`. */
export const CLOCK_BALL_MESSAGE = "savytime-clock-ball";
/** The extension's replies carry this as `source`. */
export const CLOCK_BALL_REPLY = "savytime-clock-ball-extension";
export const CLOCK_BALL_DOWNLOAD = "/downloads/savytime-clock-ball.zip";

export interface ClockBallState {
  active: boolean;
  /** Worked time is now minus this; breaks already taken push it later. */
  countFrom: number;
  /** Set while on a break: the count stands still from this moment. */
  pausedAt: number;
  /** When the shift ends with its breaks added; 0 when it has no set end. */
  endsAt: number;
  company: string;
}

const IDLE: ClockBallState = { active: false, countFrom: 0, pausedAt: 0, endsAt: 0, company: "" };

export function clockBallState(
  punches: Punch[],
  employee: Employee | null | undefined,
  now: Date,
  companies: Company[] = [],
): ClockBallState {
  const session = getActiveWorkingSession(punches, employee, now, companies);
  if (!employee || !session.activeCompanyId) return IDLE;

  const companyPunches = punches
    .filter(
      (punch) =>
        !punch.voidedAt &&
        getPunchCompanyId(punch, employee, companies) === session.activeCompanyId,
    )
    .sort((a, b) => toMillis(a.timestamp) - toMillis(b.timestamp));
  let startIndex = companyPunches.length - 1;
  while (startIndex >= 0 && !["in", "extra_in"].includes(companyPunches[startIndex].type)) {
    startIndex--;
  }
  if (startIndex < 0) return IDLE;

  const start = companyPunches[startIndex];
  const startedAt = toMillis(start.timestamp);
  let breakMs = 0;
  let pausedAt = 0;
  for (const punch of companyPunches.slice(startIndex + 1)) {
    const at = toMillis(punch.timestamp);
    if (punch.type === "lunch_start") pausedAt = at;
    else if (punch.type === "lunch_end" && pausedAt) {
      breakMs += at - pausedAt;
      pausedAt = 0;
    }
  }

  // The same end automatic punch-out closes the shift at; overtime has none.
  let endsAt = 0;
  if (start.type === "in") {
    const companyEmployee = getEmployeeForCompany(employee, session.activeCompanyId);
    const end = getShiftCompletion(companyEmployee, new Date(startedAt)).shift.end.getTime();
    if (end > startedAt) endsAt = end + breakMs;
  }

  return {
    active: true,
    countFrom: startedAt + breakMs,
    pausedAt,
    endsAt,
    company: session.activeCompanyName || "",
  };
}
