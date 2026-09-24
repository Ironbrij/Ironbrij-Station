import { zonedDateKey } from "./attendance.ts";

export interface ReportWeek {
  /** Monday, YYYY-MM-DD. */
  from: string;
  /** Friday, YYYY-MM-DD. */
  to: string;
  /** "Mon 15 Sep - Fri 19 Sep 2026", for the subject line and the email body. */
  label: string;
}

function shiftDays(dateKey: string, days: number): string {
  const next = new Date(`${dateKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// Spelled out rather than localised: the label goes in a client's subject line,
// and runtimes disagree on whether September abbreviates to Sep or Sept.
function readableDate(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  return `${DAY_NAMES[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

/**
 * The working week a report covers: the most recent Monday to Friday that has
 * finished. A run on Saturday or Sunday reports the week just gone; a run on a
 * weekday reports the previous week, because this week is still being worked.
 *
 * `weeksAgo` steps further back, so a missed send can be replayed.
 */
export function resolveReportWeek(now: Date, timezone = "UTC", weeksAgo = 0): ReportWeek {
  const today = zonedDateKey(now, timezone);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay(); // 0=Sun
  const thisMonday = shiftDays(today, -((weekday + 6) % 7));
  // On Saturday or Sunday this week's Friday has been worked, so the week just
  // gone is the one to report. On a weekday it has not, so report the week before.
  const finishedWeek = weekday === 0 || weekday === 6 ? thisMonday : shiftDays(thisMonday, -7);
  const from = shiftDays(finishedWeek, -weeksAgo * 7);
  const to = shiftDays(from, 4);
  const year = to.slice(0, 4);
  return { from, to, label: `${readableDate(from)} - ${readableDate(to)} ${year}` };
}

/** True when today is the day a weekly report should go out. */
export function isReportSendDay(now: Date, timezone = "UTC", sendDay = 6): boolean {
  const today = zonedDateKey(now, timezone);
  return new Date(`${today}T12:00:00Z`).getUTCDay() === sendDay;
}
