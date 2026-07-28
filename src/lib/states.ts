import type { CountryCode } from "./types";

export const STATE_NOT_APPLICABLE = "N/A";

const STATE_OPTIONS: Record<CountryCode, string[]> = {
  AU: ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"],
  NP: ["Bagmati", "Gandaki", "Karnali", "Koshi", "Lumbini", "Madhesh", "Sudurpashchim"],
  PH: ["Metro Manila", "Luzon", "Visayas", "Mindanao"],
};

export function getStateOptions(country?: CountryCode): string[] {
  return [
    STATE_NOT_APPLICABLE,
    ...(country ? STATE_OPTIONS[country] : Object.values(STATE_OPTIONS).flat()),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

export function normalizeState(value?: string): string {
  return value?.trim() || STATE_NOT_APPLICABLE;
}
