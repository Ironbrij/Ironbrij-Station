import { Timestamp } from "firebase/firestore";
import type { Company, CountryCode, Employee, Punch } from "./types";
import { calculateAttendanceSession } from "./attendance-calculation";

export interface DayHours {
  regularHours: number;
  overtimeHours: number;
  formattedDuration: string;
}

export const COUNTRY_TIMEZONES: Record<
  CountryCode,
  { name: string; flag: string; timezone: string; label: string }
> = {
  NP: { name: "Nepal", flag: "🇳🇵", timezone: "Asia/Kathmandu", label: "Nepal 🇳🇵 (Asia/Kathmandu)" },
  AU: {
    name: "Australia",
    flag: "🇦🇺",
    timezone: "Australia/Sydney",
    label: "Australia 🇦🇺 (Australia/Sydney)",
  },
  PH: {
    name: "Philippines",
    flag: "🇵🇭",
    timezone: "Asia/Manila",
    label: "Philippines 🇵🇭 (Asia/Manila)",
  },
};

export function formatDurationHMS(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export function computeDay(
  punches: Punch[],
  context?: { employee: Employee; company?: Company | null; now?: Date },
): DayHours {
  const sorted = [...punches].sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());
  let regularMs = 0;
  let overtimeMs = 0;
  let openIn: number | null = null;
  let openExtraIn: number | null = null;
  for (const punch of sorted) {
    const timestamp = punch.timestamp.toMillis();
    if (punch.type === "in") openIn = timestamp;
    else if (punch.type === "out" && openIn !== null) {
      if (context) {
        const result = calculateAttendanceSession({
          employee: context.employee,
          company: context.company,
          punchIn: new Date(openIn),
          punchOut: new Date(timestamp),
          now: context.now,
        });
        regularMs += result.normalWorkMinutes * 60_000;
        overtimeMs += result.overtimeMinutes * 60_000;
      } else {
        regularMs += timestamp - openIn;
      }
      openIn = null;
    } else if (punch.type === "extra_in") openExtraIn = timestamp;
    else if (punch.type === "extra_out" && openExtraIn !== null) {
      overtimeMs += timestamp - openExtraIn;
      openExtraIn = null;
    }
  }
  if (openIn !== null && context) {
    const result = calculateAttendanceSession({
      employee: context.employee,
      company: context.company,
      punchIn: new Date(openIn),
      now: context.now,
    });
    regularMs += result.normalWorkMinutes * 60_000;
  }
  return {
    regularHours: Math.max(0, regularMs / 3600000),
    overtimeHours: Math.max(0, overtimeMs / 3600000),
    formattedDuration: formatDurationHMS(regularMs + overtimeMs),
  };
}

export function ymd(value: Date | Timestamp): string {
  const date = value instanceof Timestamp ? value.toDate() : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatLocalTime(value: Date | Timestamp, timezone?: string): string {
  const date = value instanceof Timestamp ? value.toDate() : value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date);
}

export function computeLateness(
  punchTimestamp: Date | Timestamp,
  shiftStartTime = "09:00",
  country: CountryCode = "NP",
) {
  const date = punchTimestamp instanceof Timestamp ? punchTimestamp.toDate() : punchTimestamp;
  const timezone = COUNTRY_TIMEZONES[country].timezone;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  const [scheduledHour, scheduledMinute] = shiftStartTime.split(":").map(Number);
  const difference =
    read("hour") * 60 + read("minute") - ((scheduledHour || 0) * 60 + (scheduledMinute || 0));
  return {
    isLate: difference > 1,
    isEarly: difference < -1,
    minutes: Math.abs(difference),
    dateStr: `${read("year")}-${String(read("month")).padStart(2, "0")}-${String(read("day")).padStart(2, "0")}`,
  };
}
