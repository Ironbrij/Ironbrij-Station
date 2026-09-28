/**
 * The holiday calendar, and the public holidays of Australia, New Zealand and
 * the United Kingdom that an admin can add to it with one click.
 *
 * Every holiday is saved on the main company, but each screen reads holidays
 * from the company it is showing: a client, or "All Companies". Those never saw
 * the main company's list, so a holiday only counted where the main company was
 * open. `shareHolidays` gives every company the one saved calendar; which
 * company a holiday is for is then decided per holiday, by its `companyIds`.
 */

import { COMPANY_ID, type Company, type CompanyHoliday, type Employee } from "./types.ts";

export const AU_STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
export type AuState = (typeof AU_STATES)[number];

export type HolidayCountry = "AU" | "NZ" | "GB";

export interface Region {
  /** Australian states keep their short code ("NSW"); others use ISO codes ("NZ-AUK"). */
  code: string;
  label: string;
}

export interface HolidayCountryInfo {
  code: HolidayCountry;
  name: string;
  /** What the country calls the areas its holidays follow. */
  regionWord: string;
  regions: Region[];
}

export const HOLIDAY_COUNTRIES: HolidayCountryInfo[] = [
  {
    code: "AU",
    name: "Australia",
    regionWord: "state",
    regions: AU_STATES.map((code) => ({ code, label: code })),
  },
  {
    code: "NZ",
    name: "New Zealand",
    regionWord: "region",
    regions: [
      { code: "NZ-AUK", label: "Auckland" },
      { code: "NZ-BOP", label: "Bay of Plenty" },
      { code: "NZ-CAN", label: "Canterbury" },
      { code: "NZ-CIT", label: "Chatham Islands" },
      { code: "NZ-GIS", label: "Gisborne" },
      { code: "NZ-HKB", label: "Hawke's Bay" },
      { code: "NZ-MBH", label: "Marlborough" },
      { code: "NZ-MWT", label: "Manawatū-Whanganui" },
      { code: "NZ-NSN", label: "Nelson" },
      { code: "NZ-NTL", label: "Northland" },
      { code: "NZ-OTA", label: "Otago" },
      { code: "NZ-STL", label: "Southland" },
      { code: "NZ-TAS", label: "Tasman" },
      { code: "NZ-TKI", label: "Taranaki" },
      { code: "NZ-WGN", label: "Wellington" },
      { code: "NZ-WKO", label: "Waikato" },
      { code: "NZ-WTC", label: "West Coast" },
    ],
  },
  {
    code: "GB",
    name: "United Kingdom",
    regionWord: "country",
    regions: [
      { code: "GB-ENG", label: "England" },
      { code: "GB-NIR", label: "Northern Ireland" },
      { code: "GB-SCT", label: "Scotland" },
      { code: "GB-WLS", label: "Wales" },
    ],
  },
];

const REGIONS = new Map(
  HOLIDAY_COUNTRIES.flatMap((country) =>
    country.regions.map((region) => [region.code, { ...region, country: country.code }] as const),
  ),
);

export function countryInfo(country: HolidayCountry): HolidayCountryInfo {
  return HOLIDAY_COUNTRIES.find((item) => item.code === country) ?? HOLIDAY_COUNTRIES[0];
}

export function regionCodes(country: HolidayCountry): string[] {
  return countryInfo(country).regions.map((region) => region.code);
}

/** "NSW", "Auckland", "Scotland"; unknown codes as they are. */
export function regionLabel(code: string): string {
  return REGIONS.get(code)?.label ?? code;
}

export function regionCountry(code: string): HolidayCountry | null {
  return REGIONS.get(code)?.country ?? null;
}

/** "NSW, VIC", "Auckland, Wellington", or "New Zealand" when it is all of them. */
export function describeRegions(codes: string[]): string {
  const picked = new Set(codes);
  const whole = HOLIDAY_COUNTRIES.filter((country) =>
    country.regions.every((region) => picked.has(region.code)),
  );
  const covered = new Set(whole.flatMap((country) => regionCodes(country.code)));
  return [
    ...whole.map((country) => country.name),
    ...codes.filter((code) => !covered.has(code)).map(regionLabel),
  ].join(", ");
}

function isMainCompany(company: Company): boolean {
  return company.id === COMPANY_ID || Boolean(company.isMain);
}

/** The company holding the saved holiday calendar. */
export function findHolidaySource(companies: Company[]): Company | null {
  return companies.find(isMainCompany) ?? null;
}

/** One company with the saved calendar added to any holidays of its own. */
export function withSharedHolidays<T extends Company>(company: T, source: Company | null | undefined): T {
  if (!source || company === source) return company;
  const own = company.holidayAssignments ?? [];
  const ownIds = new Set(own.map((holiday) => holiday.id));
  return {
    ...company,
    holidays: [...new Set([...(source.holidays ?? []), ...(company.holidays ?? [])])],
    holidayAssignments: [
      ...(source.holidayAssignments ?? []).filter((holiday) => !ownIds.has(holiday.id)),
      ...own,
    ],
  };
}

/** The state or region a company is in ("NSW", "NZ-AUK", "GB-ENG"), or "". */
export function companyState(company: Pick<Company, "state"> | null | undefined): string {
  const state = company?.state?.trim() || "";
  return REGIONS.has(state) ? state : "";
}

/**
 * The saved calendar, with each state holiday naming the companies located in
 * its states, so "All Companies" screens can tell whose work it closes.
 */
export function sharedCalendar(companies: Company[], source?: Company | null): Company | null {
  const main = source ?? findHolidaySource(companies);
  if (!main) return null;
  const inState = (states: string[]) =>
    companies
      .filter((company) => states.includes(companyState(company)))
      .map((company) => company.id || COMPANY_ID);
  return {
    ...main,
    holidayAssignments: (main.holidayAssignments ?? []).map((holiday) =>
      holiday.targetType === "states"
        ? { ...holiday, stateCompanyIds: inState(holiday.stateCodes ?? []) }
        : holiday,
    ),
  };
}

/** Every company with the saved calendar, so each screen sees the same holidays. */
export function shareHolidays<T extends Company>(companies: T[], source?: Company | null): T[] {
  const calendar = sharedCalendar(companies, source);
  if (!calendar) return companies;
  return companies.map((company) =>
    (company.id || COMPANY_ID) === (calendar.id || COMPANY_ID)
      ? { ...company, holidayAssignments: calendar.holidayAssignments }
      : withSharedHolidays(company, calendar),
  );
}

/**
 * The states someone works in, from the companies they work for. More than one
 * means a state holiday may close one of their companies and not another.
 */
export function employeeWorkStates(
  employee: Pick<Employee, "companyId" | "companyIds">,
  companies: Company[],
): string[] {
  const ids = [employee.companyId || COMPANY_ID, ...(employee.companyIds || [])];
  return [
    ...new Set(
      companies
        .filter((company) => ids.includes(company.id || COMPANY_ID))
        .map(companyState)
        .filter(Boolean),
    ),
  ].sort();
}

/** "NSW · Auckland", or a prompt to set the companies' states. */
export function describeWorkStates(states: string[]): string {
  return states.length > 0 ? states.map(regionLabel).join(" · ") : "No state set on their companies";
}

// ---------------------------------------------------------------------------
// Public holidays
// ---------------------------------------------------------------------------

export interface PublicHoliday {
  date: string; // YYYY-MM-DD
  name: string;
  country: HolidayCountry;
  /** The states or regions that take the day off; all of them for a national holiday. */
  states: string[];
}

const ALL: string[] = [...AU_STATES];

function key(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toISOString().slice(0, 10);
}

function weekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** The nth Monday (or other weekday) of a month; n = -1 is the last one. */
function nthWeekday(year: number, month: number, day: number, n: number): string {
  if (n > 0) {
    const first = weekday(year, month, 1);
    return key(year, month, 1 + ((day - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = weekday(year, month, lastDate);
  return key(year, month, lastDate - ((last - day + 7) % 7));
}

/** Easter Sunday (Gregorian calendar). */
function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function shift(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The year's Australian public holidays, worked out from each state's rules,
 * with the Monday or Tuesday given when a holiday falls on a weekend. Days set
 * by proclamation each year (the AFL Grand Final eve, show days) are left out.
 */
export function australianPublicHolidays(year: number): PublicHoliday[] {
  const list: PublicHoliday[] = [];
  const add = (date: string, name: string, states: string[] = ALL) =>
    list.push({ date, name, country: "AU", states });

  add(key(year, 1, 1), "New Year's Day");
  const newYear = weekday(year, 1, 1);
  if (newYear === 6) add(key(year, 1, 3), "New Year's Day (observed)");
  if (newYear === 0) add(key(year, 1, 2), "New Year's Day (observed)");

  const australiaDay = weekday(year, 1, 26);
  if (australiaDay === 6) add(key(year, 1, 28), "Australia Day (observed)");
  else if (australiaDay === 0) add(key(year, 1, 27), "Australia Day (observed)");
  else add(key(year, 1, 26), "Australia Day");

  add(nthWeekday(year, 3, 1, 1), "Labour Day", ["WA"]);
  add(nthWeekday(year, 3, 1, 2), "Labour Day", ["VIC"]);
  add(nthWeekday(year, 3, 1, 2), "Eight Hours Day", ["TAS"]);
  add(nthWeekday(year, 3, 1, 2), "Canberra Day", ["ACT"]);
  add(nthWeekday(year, 3, 1, 2), "Adelaide Cup Day", ["SA"]);

  const easter = easterSunday(year);
  const easterKey = key(year, easter.month, easter.day);
  add(shift(easterKey, -2), "Good Friday");
  add(shift(easterKey, -1), "Easter Saturday", ["ACT", "NSW", "NT", "QLD", "SA", "VIC"]);
  add(easterKey, "Easter Sunday", ["ACT", "NSW", "QLD", "VIC", "WA"]);
  add(shift(easterKey, 1), "Easter Monday");

  add(key(year, 4, 25), "Anzac Day");
  const anzac = weekday(year, 4, 25);
  if (anzac === 6 || anzac === 0) {
    add(key(year, 4, anzac === 6 ? 27 : 26), "Anzac Day (observed)", ["WA"]);
  }

  add(nthWeekday(year, 5, 1, 1), "Labour Day", ["QLD"]);
  add(nthWeekday(year, 5, 1, 1), "May Day", ["NT"]);
  // Reconciliation Day: the Monday on or after 27 May.
  add(key(year, 5, 27 + ((1 - weekday(year, 5, 27) + 7) % 7)), "Reconciliation Day", ["ACT"]);
  add(nthWeekday(year, 6, 1, 1), "Western Australia Day", ["WA"]);
  add(nthWeekday(year, 6, 1, 2), "King's Birthday", ["ACT", "NSW", "NT", "SA", "TAS", "VIC"]);
  add(nthWeekday(year, 8, 1, 1), "Picnic Day", ["NT"]);
  add(nthWeekday(year, 9, 1, -1), "King's Birthday", ["WA"]);
  add(nthWeekday(year, 10, 1, 1), "Labour Day", ["ACT", "NSW", "SA"]);
  add(nthWeekday(year, 10, 1, 1), "King's Birthday", ["QLD"]);
  add(nthWeekday(year, 11, 2, 1), "Melbourne Cup Day", ["VIC"]);

  add(key(year, 12, 25), "Christmas Day");
  add(key(year, 12, 26), "Boxing Day");
  const christmas = weekday(year, 12, 25);
  if (christmas === 6) {
    add(key(year, 12, 27), "Christmas Day (observed)");
    add(key(year, 12, 28), "Boxing Day (observed)");
  } else if (christmas === 0) {
    add(key(year, 12, 27), "Christmas Day (observed)");
  } else if (christmas === 5) {
    add(key(year, 12, 28), "Boxing Day (observed)");
  }

  return list.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

interface NagerHoliday {
  date: string;
  localName?: string;
  name?: string;
  counties?: string[] | null;
  types?: string[];
}

export interface PublicHolidayList {
  holidays: PublicHoliday[];
  /**
   * "nager" from date.nager.at; "built-in" when it could not be reached and the
   * Australian rules stood in; "unavailable" when there is nothing to stand in.
   */
  source: "nager" | "built-in" | "unavailable";
}

const nagerCache = new Map<string, Promise<PublicHolidayList>>();

/** Nager.Date's list, as the planner shows it: one row per day and states. */
export function fromNager(list: NagerHoliday[], country: HolidayCountry = "AU"): PublicHoliday[] {
  const known = new Set(regionCodes(country));
  return list
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .filter((item) => !item.types || item.types.includes("Public"))
    .map((item) => {
      const states = (item.counties ?? [])
        .map((county) => (country === "AU" ? county.replace(/^AU-/, "") : county))
        .filter((state) => known.has(state));
      return {
        date: item.date,
        name: item.localName || item.name || "Public holiday",
        country,
        states: item.counties?.length ? [...new Set(states)].sort() : [...known],
      };
    })
    .filter((item) => item.states.length > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/**
 * A country's public holidays for the year from Nager.Date (it includes days
 * set by proclamation). For Australia the built-in rules stand in when it
 * cannot be reached.
 */
export function loadPublicHolidays(
  year: number,
  country: HolidayCountry,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicHolidayList> {
  const cacheKey = `${country}-${year}`;
  const cached = nagerCache.get(cacheKey);
  if (cached) return cached;
  const loading = (async (): Promise<PublicHolidayList> => {
    try {
      const response = await fetchImpl(
        `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`,
      );
      if (!response.ok) throw new Error(String(response.status));
      const holidays = fromNager((await response.json()) as NagerHoliday[], country);
      if (holidays.length === 0) throw new Error("empty");
      return { holidays, source: "nager" };
    } catch {
      nagerCache.delete(cacheKey);
      return country === "AU"
        ? { holidays: australianPublicHolidays(year), source: "built-in" }
        : { holidays: [], source: "unavailable" };
    }
  })();
  nagerCache.set(cacheKey, loading);
  return loading;
}

export function loadAustralianPublicHolidays(
  year: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicHolidayList> {
  return loadPublicHolidays(year, "AU", fetchImpl);
}

/** Every state or region of its country takes the day off. */
export function isNationalHoliday(holiday: Pick<PublicHoliday, "states"> & { country?: HolidayCountry }): boolean {
  return holiday.states.length === regionCodes(holiday.country ?? "AU").length;
}

/** The saved holidays on a date, the legacy everyone-list included. */
export function holidaysOnDate(
  company: Pick<Company, "holidays" | "holidayAssignments"> | null | undefined,
  dateKey: string,
): CompanyHoliday[] {
  const found: CompanyHoliday[] = [];
  if (company?.holidays?.includes(dateKey)) {
    found.push({ id: `legacy-${dateKey}`, date: dateKey, name: "Company Holiday", targetType: "all" });
  }
  for (const holiday of company?.holidayAssignments ?? []) {
    if (holiday.date === dateKey) found.push(holiday);
  }
  return found;
}
