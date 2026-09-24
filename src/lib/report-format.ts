/** Formatting shared by the report screen and its email, in the client sheet's style. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return { year, month: MONTHS[month - 1] || "", day };
}

/** 40 -> "40", 17.5 -> "17.5", 5.515 -> "5.52": no trailing zeros. */
export function formatAmount(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** "8 hours", "1 hour". */
export function formatHours(hours: number): string {
  const amount = formatAmount(hours);
  return `${amount} ${amount === "1" || amount === "-1" ? "hour" : "hours"}`;
}

/**
 * "5.51 Days (44.12 hours)", "1 Day (8 hours)". Zero reads as "0" by default,
 * which is how the sheet shows a column with nothing used.
 */
export function formatDaysAndHours(days: number, hoursPerDay: number, zero = "0"): string {
  if (!Number.isFinite(days) || Math.abs(days) < 0.005) return zero;
  const amount = formatAmount(days);
  const dayLabel = amount === "1" || amount === "-1" ? "Day" : "Days";
  return `${amount} ${dayLabel} (${formatHours(days * hoursPerDay)})`;
}

/** The period a report covers: "Sep 14 - 20, 2026", "Aug 31 - Sep 4, 2026". */
export function formatCovered(from: string, to: string): string {
  const start = parts(from);
  const end = parts(to);
  if (from === to) return `${start.month} ${start.day}, ${start.year}`;
  if (start.year !== end.year) {
    return `${start.month} ${start.day}, ${start.year} - ${end.month} ${end.day}, ${end.year}`;
  }
  if (start.month !== end.month) {
    return `${start.month} ${start.day} - ${end.month} ${end.day}, ${end.year}`;
  }
  return `${start.month} ${start.day} - ${end.day}, ${end.year}`;
}

/** "14-Sep-26", the date style used in the sheet's remarks. */
export function formatShortDate(dateKey: string): string {
  const { year, month, day } = parts(dateKey);
  return `${String(day).padStart(2, "0")}-${month}-${String(year).slice(-2)}`;
}
