import { useEffect, useMemo, useState } from "react";
import { addDoc, collection } from "firebase/firestore";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";
import {
  australianPublicHolidays,
  countryInfo,
  describeRegions,
  HOLIDAY_COUNTRIES,
  regionCodes,
  regionLabel,
  type HolidayCountry,
  companyState,
  employeeWorkStates,
  holidaysOnDate,
  isNationalHoliday,
  loadPublicHolidays,
  type PublicHoliday,
  type PublicHolidayList,
} from "@/lib/holidays";
import { MultiStateBadge } from "@/components/MultiStateBadge";
import {
  COMPANY_ID,
  type Company,
  type CompanyHoliday,
  type Department,
  type Employee,
} from "@/lib/types";

type HolidayChange = (
  holidays: string[],
  assignments: CompanyHoliday[],
) => { holidays: string[]; assignments: CompanyHoliday[] };

interface HolidayPlannerProps {
  /** The main company, which holds the saved holiday calendar. */
  calendar: Company;
  companies: Company[];
  departments: Department[];
  employees: Employee[];
  todayStr: string;
  updateHolidays: (change: HolidayChange) => Promise<boolean>;
}

/** "Everyone" means every state, and people with no state set too. */
const EVERYONE = "everyone";
type Audience = "states" | "departments";

interface Draft {
  items: { date: string; name: string }[];
  /** The country whose states or regions are offered. */
  country: HolidayCountry;
  /** EVERYONE, or the AU states that get the holiday. */
  states: string[];
  /** Empty means every company. */
  companyIds: string[];
  audience: Audience;
  departmentIds: string[];
  /** Narrow the states' holiday to some of the people in them. */
  onlySome: boolean;
  employeeIds: string[];
  search: string;
  notify: boolean;
  showMore: boolean;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function monthKey(year: number, month: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

function dayLabel(dateKey: string, options: Intl.DateTimeFormatOptions) {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString("en-AU", {
    timeZone: "UTC",
    ...options,
  });
}

function companyKey(company: Company) {
  return company.id || COMPANY_ID;
}

export function HolidayPlanner({
  calendar,
  companies,
  departments,
  employees,
  todayStr,
  updateHolidays,
}: HolidayPlannerProps) {
  const [view, setView] = useState(() => {
    const [year, month] = todayStr.split("-").map(Number);
    return { year: year || new Date().getFullYear(), month: (month || 1) - 1 };
  });
  const [country, setCountry] = useState<HolidayCountry>("AU");
  const [stateFilter, setStateFilter] = useState("all");
  const [showPast, setShowPast] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const { user } = useAuth();

  const activeCompanies = useMemo(
    () => companies.filter((company) => !company.archived && company.status !== "archived"),
    [companies],
  );
  // Nager.Date first; for Australia the built-in rules while it loads or if it
  // cannot be reached.
  const [loaded, setLoaded] = useState<{
    year: number;
    country: HolidayCountry;
    list: PublicHolidayList;
  } | null>(null);
  useEffect(() => {
    let current = true;
    void loadPublicHolidays(view.year, country).then((list) => {
      if (current) setLoaded({ year: view.year, country, list });
    });
    return () => {
      current = false;
    };
  }, [view.year, country]);
  const isLoaded = loaded?.year === view.year && loaded.country === country;
  const publicSource = isLoaded ? loaded.list.source : null;
  const publicHolidays = useMemo(
    () =>
      isLoaded
        ? loaded.list.holidays
        : country === "AU"
          ? australianPublicHolidays(view.year)
          : [],
    [isLoaded, loaded, view.year, country],
  );
  const countryDetails = countryInfo(country);
  const shownPublicHolidays = useMemo(
    () =>
      publicHolidays.filter(
        (holiday) => stateFilter === "all" || holiday.states.includes(stateFilter),
      ),
    [publicHolidays, stateFilter],
  );

  const saved = useMemo(() => {
    const legacy: CompanyHoliday[] = (calendar.holidays ?? []).map((date) => ({
      id: `legacy-${date}`,
      date,
      name: "Company Holiday",
      targetType: "all",
    }));
    return [...legacy, ...(calendar.holidayAssignments ?? [])].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }, [calendar.holidays, calendar.holidayAssignments]);
  const upcoming = saved.filter((holiday) => showPast || holiday.date >= todayStr);
  const pastCount = saved.length - saved.filter((holiday) => holiday.date >= todayStr).length;

  function isAdded(holiday: PublicHoliday) {
    return holidaysOnDate(calendar, holiday.date).some(
      (item) =>
        item.id.startsWith("legacy-") ||
        (item.name || "").toLowerCase() === holiday.name.toLowerCase(),
    );
  }

  /** The companies a state holiday closes: those in its states, of the ones picked. */
  function companiesInStates(states: string[], picked: string[]) {
    return activeCompanies.filter(
      (company) =>
        states.includes(companyState(company)) &&
        (picked.length === 0 || picked.includes(companyKey(company))),
    );
  }

  /** The companies a draft closes: those in its states, or the ones picked for Everyone. */
  function draftCompanies(current: Draft): Company[] {
    if (current.states.includes(EVERYONE)) {
      return current.companyIds.length === 0
        ? activeCompanies
        : activeCompanies.filter((company) => current.companyIds.includes(companyKey(company)));
    }
    return companiesInStates(current.states, current.companyIds);
  }

  /** The people a draft can reach: active and working for one of its companies. */
  function draftPeople(current: Draft): Employee[] {
    const ids = draftCompanies(current).map(companyKey);
    return employees
      .filter((employee) => employee.status === "active")
      .filter((employee) =>
        [employee.companyId || COMPANY_ID, ...(employee.companyIds || [])].some((id) =>
          ids.includes(id),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function companyNames(ids?: string[]) {
    if (!ids || ids.length === 0) return "All companies";
    return ids
      .map((id) => companies.find((company) => companyKey(company) === id)?.name || id)
      .join(", ");
  }

  function whoLabel(holiday: CompanyHoliday) {
    if (holiday.targetType === "all" || holiday.targetType === "companies") return "Everyone";
    if (holiday.targetType === "states")
      return `${describeRegions(holiday.stateCodes ?? []) || "Selected"} companies`;
    if (holiday.targetType === "departments") {
      const names = departments
        .filter((department) => holiday.departmentIds?.includes(department.id))
        .map((department) => department.name);
      return names.length ? names.join(", ") : "Selected departments";
    }
    const names = employees
      .filter(
        (employee) =>
          holiday.employeeIds?.includes(employee.id) ||
          Boolean(employee.authUid && holiday.employeeIds?.includes(employee.authUid)),
      )
      .map((employee) => employee.name);
    const who = names.length ? names.join(", ") : "Selected people";
    return holiday.stateCodes?.length ? `${who} (${describeRegions(holiday.stateCodes)})` : who;
  }

  function openDraft(
    items: { date: string; name: string }[],
    states: string[],
    draftCountry: HolidayCountry = country,
  ) {
    setDraft({
      items,
      country: draftCountry,
      states,
      companyIds: [],
      audience: "states",
      departmentIds: [],
      onlySome: false,
      employeeIds: [],
      search: "",
      notify: true,
      showMore: false,
    });
  }

  function openPublicHoliday(holiday: PublicHoliday) {
    openDraft([{ date: holiday.date, name: holiday.name }], holiday.states, holiday.country);
  }

  function openDay(dateKey: string) {
    const match =
      publicHolidays.find(
        (holiday) =>
          holiday.date === dateKey && (stateFilter === "all" || holiday.states.includes(stateFilter)),
      ) || publicHolidays.find((holiday) => holiday.date === dateKey);
    if (match) openPublicHoliday(match);
    else openDraft([{ date: dateKey, name: "" }], [EVERYONE]);
  }

  function openAllRemaining() {
    const remaining = shownPublicHolidays.filter(
      (holiday) =>
        !isAdded(holiday) &&
        (stateFilter !== "all" || isNationalHoliday(holiday)),
    );
    if (remaining.length === 0) {
      toast.info("Those holidays are already on the calendar.");
      return;
    }
    openDraft(
      remaining.map((holiday) => ({ date: holiday.date, name: holiday.name })),
      stateFilter === "all" ? regionCodes(country) : [stateFilter],
    );
  }

  function toggle(list: string[], value: string) {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  }

  async function saveDraft() {
    if (!draft) return;
    const items = draft.items
      .map((item) => ({ date: item.date, name: item.name.trim() || "Company Holiday" }))
      .filter((item) => item.date);
    if (items.length === 0) {
      toast.error("Pick a date.");
      return;
    }
    const everyone = draft.states.includes(EVERYONE);
    if (draft.audience === "states" && !everyone && draft.states.length === 0) {
      toast.error("Pick at least one state, or Everyone.");
      return;
    }
    if (draft.audience === "departments" && draft.departmentIds.length === 0) {
      toast.error("Pick at least one department.");
      return;
    }
    // Only people still in the picked states and companies count.
    const inScope = new Set(draftPeople(draft).map((employee) => employee.id));
    const pickedPeople = draft.employeeIds.filter((id) => inScope.has(id));
    const someOnly = draft.audience === "states" && draft.onlySome;
    const closing = draftCompanies(draft).map(companyKey);
    if (someOnly && closing.length === 0) {
      toast.error(
        `No company is set to ${describeRegions(draft.states)} yet. Set the company's state first.`,
      );
      return;
    }
    if (someOnly && pickedPeople.length === 0) {
      toast.error("Pick at least one person.");
      return;
    }

    const employeeIds = [
      ...new Set(
        employees
          .filter((employee) => pickedPeople.includes(employee.id))
          .flatMap((employee) => [employee.id, employee.authUid].filter(Boolean) as string[]),
      ),
    ];
    const stamp = Date.now();
    const added: CompanyHoliday[] = items.map((item, index) => ({
      id: `${item.date}-${stamp}-${index}`,
      date: item.date,
      name: item.name,
      ...(draft.audience === "departments"
        ? { targetType: "departments" as const, departmentIds: draft.departmentIds }
        : someOnly
          ? {
              targetType: "employees" as const,
              employeeIds,
              // Their work for these companies only: a person who also works in
              // another state keeps working there.
              ...(everyone ? {} : { stateCodes: draft.states, companyIds: closing }),
            }
          : everyone
            ? { targetType: "all" as const }
            : { targetType: "states" as const, stateCodes: draft.states }),
      ...(draft.companyIds.length > 0 && !(someOnly && !everyone)
        ? { companyIds: draft.companyIds }
        : {}),
    }));

    setSaving(true);
    const ok = await updateHolidays((holidays, assignments) => ({
      holidays,
      assignments: [...assignments, ...added],
    }));
    setSaving(false);
    if (!ok) return;
    toast.success(items.length === 1 ? `${items[0].name} added.` : `${items.length} holidays added.`);

    if (draft.notify) {
      const target =
        draft.audience === "departments"
          ? { targetType: "dept" as const, targetDeptIds: draft.departmentIds }
          : someOnly
            ? { targetType: "employee" as const, targetEmployeeIds: pickedPeople }
            : !everyone
              ? companiesInStates(draft.states, draft.companyIds).length > 0
                ? {
                    targetType: "companies" as const,
                    targetCompanyIds: companiesInStates(draft.states, draft.companyIds).map(
                      companyKey,
                    ),
                  }
                : { targetType: "states" as const, targetStateCodes: draft.states }
              : draft.companyIds.length > 0
                ? { targetType: "companies" as const, targetCompanyIds: draft.companyIds }
                : { targetType: "all" as const };
      const lines = items.map(
        (item) => `${item.name}: ${dayLabel(item.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}`,
      );
      try {
        const now = new Date().toISOString();
        await addDoc(collection(db(), "notices"), {
          title: items.length === 1 ? items[0].name : "Upcoming holidays",
          message: `${lines.join("\n")}\n\nYou do not need to punch in on ${items.length === 1 ? "this day" : "these days"}.`,
          priority: "info",
          ...target,
          createdAt: now,
          publishAt: now,
          authorName: "Admin",
        });
      } catch (error) {
        console.error(error);
        toast.error("The holiday was saved, but the notice could not be sent.");
      }
    }
    if (draft.notify) void emailHolidays(added.map((holiday) => holiday.id));
    setDraft(null);
  }

  /** Emails each person given one of these holidays, through the n8n webhook. */
  async function emailHolidays(holidayIds: string[]) {
    if (!user) return;
    try {
      const response = await fetch("/api/holiday-notification", {
        method: "POST",
        headers: {
          authorization: `Bearer ${await user.getIdToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ holidayIds }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        sent?: number;
        failed?: number;
        clients?: number;
      };
      if (!response.ok) {
        toast.warning("Holiday saved, but the emails could not be sent.");
      } else if (result.sent || result.clients) {
        toast.success(
          `Emailed ${result.sent ?? 0} ${result.sent === 1 ? "person" : "people"}` +
            (result.clients
              ? ` and ${result.clients} ${result.clients === 1 ? "client" : "clients"}`
              : "") +
            (result.failed ? ` (${result.failed} could not be sent)` : ""),
        );
      } else {
        toast.info("Nobody with an email address gets this holiday yet.");
      }
    } catch {
      toast.warning("Holiday saved, but the emails could not be sent.");
    }
  }

  async function remove(holiday: CompanyHoliday) {
    const ok = await updateHolidays((holidays, assignments) =>
      holiday.id.startsWith("legacy-")
        ? { holidays: holidays.filter((date) => date !== holiday.date), assignments }
        : { holidays, assignments: assignments.filter((item) => item.id !== holiday.id) },
    );
    if (ok) toast.success(`${holiday.name || "Holiday"} removed.`);
  }

  // The month grid, Monday first.
  const cells = useMemo(() => {
    const first = new Date(Date.UTC(view.year, view.month, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(view.year, view.month + 1, 0)).getUTCDate();
    const out: (string | null)[] = Array.from({ length: lead }, () => null);
    for (let day = 1; day <= days; day++) {
      out.push(`${monthKey(view.year, view.month)}-${String(day).padStart(2, "0")}`);
    }
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [view]);

  function moveMonth(step: number) {
    setView((current) => {
      const next = new Date(Date.UTC(current.year, current.month + step, 1));
      return { year: next.getUTCFullYear(), month: next.getUTCMonth() };
    });
  }

  const draftDayHolidays =
    draft && draft.items.length === 1 ? holidaysOnDate(calendar, draft.items[0].date) : [];

  return (
    <div className="rounded-xl border bg-card p-5 sm:p-6 shadow-lift space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-primary flex items-center gap-2">
            <CalendarDays className="h-4 w-4" /> Holidays
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Click a day, or add a public holiday for Australia, New Zealand or the UK. Pick the
            states or regions that get it off:
            it closes the companies in those states.
          </p>
        </div>
        <button
          type="button"
          onClick={() => openDraft([{ date: todayStr, name: "" }], [EVERYONE])}
          className="btn-lift shrink-0 rounded-md bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" /> Add a holiday
        </button>
      </div>

      <div className="grid gap-5 md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        {/* Mini calendar */}
        <div className="rounded-lg border bg-background p-3">
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => moveMonth(-1)}
              className="rounded p-1 hover:bg-muted"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-bold">
              {new Date(Date.UTC(view.year, view.month, 1)).toLocaleDateString("en-AU", {
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              })}
            </span>
            <button
              type="button"
              onClick={() => moveMonth(1)}
              className="rounded p-1 hover:bg-muted"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WEEKDAYS.map((day) => (
              <div key={day} className="text-[10px] font-bold text-muted-foreground py-1">
                {day.slice(0, 2)}
              </div>
            ))}
            {cells.map((dateKey, index) => {
              if (!dateKey) return <div key={`blank-${index}`} />;
              const scheduled = holidaysOnDate(calendar, dateKey);
              const publicDay = publicHolidays.filter(
                (holiday) =>
                  holiday.date === dateKey &&
                  (stateFilter === "all" || holiday.states.includes(stateFilter)),
              );
              const names = [
                ...scheduled.map((holiday) => `✓ ${holiday.name || "Holiday"}`),
                ...publicDay
                  .filter((holiday) => !isAdded(holiday))
                  .map(
                    (holiday) =>
                      `${holiday.name} (${isNationalHoliday(holiday) ? `${countryDetails.name}, national` : describeRegions(holiday.states)})`,
                  ),
              ];
              return (
                <button
                  key={dateKey}
                  type="button"
                  onClick={() => openDay(dateKey)}
                  title={names.join("\n") || "Add a holiday"}
                  className={`relative aspect-square rounded-md text-xs font-semibold transition-colors ${
                    scheduled.length > 0
                      ? "bg-purple-600 text-white hover:bg-purple-700"
                      : "hover:bg-muted"
                  } ${dateKey === todayStr ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""}`}
                >
                  {Number(dateKey.slice(8))}
                  {scheduled.length === 0 && publicDay.length > 0 && (
                    <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-amber-500" />
                  )}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-[10px] font-semibold text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm bg-purple-600" /> Holiday
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Public holiday
            </span>
          </div>
        </div>

        {/* Scheduled holidays, as events */}
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-bold">
              {showPast ? "All holidays" : "Coming up"} ({upcoming.length})
            </h3>
            {pastCount > 0 && (
              <button
                type="button"
                onClick={() => setShowPast((value) => !value)}
                className="text-xs font-bold text-primary hover:underline"
              >
                {showPast ? "Hide past" : `Show past (${pastCount})`}
              </button>
            )}
          </div>
          <ul className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
            {upcoming.map((holiday) => (
              <li
                key={holiday.id}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${
                  holiday.date < todayStr ? "opacity-60" : ""
                }`}
              >
                <div className="w-11 shrink-0 rounded-md bg-purple-500/10 text-center py-1 text-purple-700 dark:text-purple-300">
                  <div className="text-[9px] font-bold uppercase leading-none">
                    {dayLabel(holiday.date, { month: "short" })}
                  </div>
                  <div className="text-base font-extrabold leading-tight">
                    {Number(holiday.date.slice(8))}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate">
                    {holiday.name || "Company Holiday"}
                  </div>
                  <div className="text-[11px] text-muted-foreground truncate">
                    {dayLabel(holiday.date, { weekday: "short" })} {holiday.date.slice(0, 4)} ·{" "}
                    {whoLabel(holiday)} · {companyNames(holiday.companyIds)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => remove(holiday)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600"
                  title="Remove holiday"
                  aria-label={`Remove ${holiday.name || "holiday"}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
            {upcoming.length === 0 && (
              <li className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                No holidays coming up. Click a day on the calendar or add one below.
              </li>
            )}
          </ul>
        </div>
      </div>

      {/* Public holidays by country */}
      <div className="rounded-lg border bg-secondary/20 p-3 space-y-3">
        <div className="flex flex-wrap gap-1 rounded-lg border bg-background p-1 w-fit">
          {HOLIDAY_COUNTRIES.map((item) => (
            <button
              key={item.code}
              type="button"
              onClick={() => {
                setCountry(item.code);
                setStateFilter("all");
              }}
              className={`rounded-md px-3 py-1.5 text-xs font-bold ${
                country === item.code
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {item.name}
            </button>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <h3 className="text-sm font-bold">
            {countryDetails.name} public holidays {view.year}
          </h3>
          <button
            type="button"
            onClick={openAllRemaining}
            className="text-xs font-bold text-primary hover:underline self-start sm:self-auto"
          >
            {stateFilter === "all"
              ? "Add all national holidays"
              : `Add all ${regionLabel(stateFilter)} holidays`}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {[{ code: "all", label: `All ${countryDetails.regionWord === "country" ? "countries" : `${countryDetails.regionWord}s`}` }, ...countryDetails.regions].map((region) => (
            <button
              key={region.code}
              type="button"
              onClick={() => setStateFilter(region.code)}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${
                stateFilter === region.code
                  ? "border-primary bg-primary/10 text-primary"
                  : "bg-background text-muted-foreground"
              }`}
            >
              {region.label}
            </button>
          ))}
        </div>
        <ul className="divide-y rounded-md border bg-background">
          {shownPublicHolidays.map((holiday) => {
            const added = isAdded(holiday);
            const past = holiday.date < todayStr;
            return (
              <li
                key={`${holiday.date}-${holiday.name}-${holiday.states.join()}`}
                className={`flex items-center gap-3 px-3 py-2 ${past ? "opacity-50" : ""}`}
              >
                <span className="w-24 shrink-0 text-xs font-semibold text-muted-foreground">
                  {dayLabel(holiday.date, { weekday: "short", day: "numeric", month: "short" })}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-semibold">{holiday.name}</span>
                  <span className="ml-2 text-[10px] font-bold text-muted-foreground">
                    {isNationalHoliday(holiday)
                      ? "National"
                      : holiday.states.map(regionLabel).join(" · ")}
                  </span>
                </span>
                {added ? (
                  <span className="flex items-center gap-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                    <Check className="h-3.5 w-3.5" /> Added
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => openPublicHoliday(holiday)}
                    className="rounded-md border px-2.5 py-1 text-[11px] font-bold text-primary hover:bg-primary/10"
                  >
                    + Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] text-muted-foreground">
          {publicSource === "nager"
            ? "From Nager.Date (date.nager.at), including the days each state or region proclaims."
            : publicSource === "built-in"
              ? "Nager.Date could not be reached, so these are worked out from each state's rules. Proclaimed days (like show days) are missing; add those with Add a holiday."
              : publicSource === "unavailable"
                ? "Nager.Date could not be reached. Try again later, or add days with Add a holiday."
                : "Loading from Nager.Date…"}
        </p>
      </div>

      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border bg-card p-5 shadow-lift space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-base font-bold text-primary">
                {draft.items.length === 1 ? "Add a holiday" : `Add ${draft.items.length} holidays`}
              </h3>
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded p-1 hover:bg-muted"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {draft.items.length === 1 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="date"
                  value={draft.items[0].date}
                  onChange={(event) =>
                    setDraft({ ...draft, items: [{ ...draft.items[0], date: event.target.value }] })
                  }
                  className="rounded-md border bg-background px-3 py-2 text-sm font-medium"
                />
                <input
                  value={draft.items[0].name}
                  onChange={(event) =>
                    setDraft({ ...draft, items: [{ ...draft.items[0], name: event.target.value }] })
                  }
                  placeholder="Name, e.g. Christmas Day"
                  className="rounded-md border bg-background px-3 py-2 text-sm font-medium"
                />
              </div>
            ) : (
              <ul className="max-h-36 overflow-y-auto rounded-md border bg-background text-xs divide-y">
                {draft.items.map((item) => (
                  <li key={`${item.date}-${item.name}`} className="flex gap-3 px-3 py-1.5">
                    <span className="w-24 shrink-0 text-muted-foreground">
                      {dayLabel(item.date, { weekday: "short", day: "numeric", month: "short" })}
                    </span>
                    <span className="font-semibold">{item.name}</span>
                  </li>
                ))}
              </ul>
            )}

            {draftDayHolidays.length > 0 && (
              <div className="rounded-md bg-purple-500/10 border border-purple-500/20 p-2.5 text-xs space-y-1">
                <div className="font-bold text-purple-800 dark:text-purple-300">
                  Already on this day
                </div>
                {draftDayHolidays.map((holiday) => (
                  <div key={holiday.id} className="flex items-center justify-between gap-2">
                    <span>
                      {holiday.name || "Holiday"} · {whoLabel(holiday)} ·{" "}
                      {companyNames(holiday.companyIds)}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(holiday)}
                      className="font-bold text-rose-600 hover:underline"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {draft.audience === "states" && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-extrabold text-primary">
                    Which {countryInfo(draft.country).regionWord === "country"
                      ? "countries"
                      : `${countryInfo(draft.country).regionWord}s`}{" "}
                    get the holiday?
                  </div>
                  <div className="flex gap-1 rounded-md border bg-background p-0.5">
                    {HOLIDAY_COUNTRIES.map((item) => (
                      <button
                        key={item.code}
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            country: item.code,
                            states: draft.states.includes(EVERYONE) ? [EVERYONE] : [],
                          })
                        }
                        className={`rounded px-2 py-0.5 text-[10px] font-bold ${
                          draft.country === item.code
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground"
                        }`}
                      >
                        {item.code === "GB" ? "UK" : item.code}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setDraft({ ...draft, states: [EVERYONE] })}
                    className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                      draft.states.includes(EVERYONE)
                        ? "border-primary bg-primary text-primary-foreground"
                        : "bg-background text-muted-foreground"
                    }`}
                  >
                    Everyone
                  </button>
                  {countryInfo(draft.country).regions.map((region) => (
                    <button
                      key={region.code}
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          states: toggle(
                            draft.states.filter((item) => item !== EVERYONE),
                            region.code,
                          ),
                        })
                      }
                      className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                        draft.states.includes(region.code)
                          ? "border-primary bg-primary/10 text-primary"
                          : "bg-background text-muted-foreground"
                      }`}
                    >
                      {region.label}
                    </button>
                  ))}
                </div>
                <StateScope
                  states={draft.states}
                  closing={
                    draft.states.includes(EVERYONE)
                      ? []
                      : companiesInStates(draft.states, draft.companyIds)
                  }
                  unset={activeCompanies.filter(
                    (company) =>
                      !companyState(company) &&
                      (draft.companyIds.length === 0 ||
                        draft.companyIds.includes(companyKey(company))),
                  )}
                  employees={employees}
                  companies={activeCompanies}
                />
                <label className="flex items-center gap-2 text-xs font-bold cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={draft.onlySome}
                    onChange={(event) => setDraft({ ...draft, onlySome: event.target.checked })}
                  />
                  Only some people {draft.states.includes(EVERYONE) ? "" : "in these states"}
                </label>
                {draft.onlySome && (
                  <PeoplePicker
                    people={draftPeople(draft)}
                    companies={activeCompanies}
                    selected={draft.employeeIds}
                    search={draft.search}
                    onSearch={(search) => setDraft({ ...draft, search })}
                    onChange={(employeeIds) => setDraft({ ...draft, employeeIds })}
                  />
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-extrabold text-primary">For which companies?</div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, companyIds: [] })}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                    draft.companyIds.length === 0
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground"
                  }`}
                >
                  All companies
                </button>
                {activeCompanies.map((company) => (
                  <button
                    key={companyKey(company)}
                    type="button"
                    onClick={() =>
                      setDraft({ ...draft, companyIds: toggle(draft.companyIds, companyKey(company)) })
                    }
                    className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                      draft.companyIds.includes(companyKey(company))
                        ? "border-primary bg-primary/10 text-primary"
                        : "bg-background text-muted-foreground"
                    }`}
                  >
                    {company.name}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Someone who works for two companies only gets the holiday for the companies picked
                here. Work for any other company that day counts as a normal day.
              </p>
            </div>

            <div className="rounded-md border">
              <button
                type="button"
                onClick={() => setDraft({ ...draft, showMore: !draft.showMore })}
                className="flex w-full items-center justify-between px-3 py-2 text-xs font-bold text-muted-foreground"
              >
                More options
                <ChevronRight
                  className={`h-3.5 w-3.5 transition-transform ${draft.showMore ? "rotate-90" : ""}`}
                />
              </button>
              {draft.showMore && (
                <div className="border-t p-3 space-y-3">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(
                      [
                        ["states", "By state"],
                        ["departments", "By department"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setDraft({ ...draft, audience: value })}
                        className={`rounded-md border px-2 py-1.5 text-[11px] font-bold ${
                          draft.audience === value
                            ? "border-primary bg-primary/10 text-primary"
                            : "bg-background text-muted-foreground"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {draft.audience === "departments" && (
                    <div className="grid gap-1.5 sm:grid-cols-2 max-h-40 overflow-y-auto">
                      {departments
                        .filter(
                          (department) =>
                            draft.companyIds.length === 0 ||
                            draft.companyIds.includes(department.companyId || COMPANY_ID),
                        )
                        .map((department) => (
                          <label
                            key={department.id}
                            className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs"
                          >
                            <input
                              type="checkbox"
                              checked={draft.departmentIds.includes(department.id)}
                              onChange={() =>
                                setDraft({
                                  ...draft,
                                  departmentIds: toggle(draft.departmentIds, department.id),
                                })
                              }
                            />
                            {department.name}
                          </label>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
              <input
                type="checkbox"
                checked={draft.notify}
                onChange={(event) => setDraft({ ...draft, notify: event.target.checked })}
              />
              Tell these people now (app notice and email)
            </label>

            <div className="flex justify-end gap-2 border-t pt-3">
              <button
                type="button"
                onClick={() => setDraft(null)}
                className="rounded-md border px-4 py-2 text-xs font-bold text-muted-foreground hover:bg-secondary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={saveDraft}
                className="rounded-md bg-primary px-5 py-2 text-xs font-bold text-primary-foreground disabled:opacity-50"
              >
                {saving
                  ? "Saving…"
                  : draft.items.length === 1
                    ? "Add holiday"
                    : `Add ${draft.items.length} holidays`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Says what a state pick does: which companies close, and who works in more
 * than one state and so keeps working for their other companies.
 */
function StateScope({
  states,
  closing,
  unset,
  employees,
  companies,
}: {
  states: string[];
  closing: Company[];
  unset: Company[];
  employees: Employee[];
  companies: Company[];
}) {
  if (states.includes(EVERYONE)) {
    return (
      <p className="text-[11px] text-muted-foreground">
        Everyone in the companies below gets the holiday, whatever state they are in.
      </p>
    );
  }
  const closingIds = closing.map((company) => company.id || COMPANY_ID);
  const split = employees
    .filter((employee) => employee.status === "active")
    .map((employee) => ({ employee, states: employeeWorkStates(employee, companies) }))
    .filter(
      ({ employee, states: theirs }) =>
        theirs.length > 1 &&
        theirs.some((state) => states.includes(state)) &&
        theirs.some((state) => !states.includes(state)) &&
        [employee.companyId || COMPANY_ID, ...(employee.companyIds || [])].some((id) =>
          closingIds.includes(id),
        ),
    );
  return (
    <div className="space-y-1.5 text-[11px] text-muted-foreground">
      <p>
        {closing.length > 0 ? (
          <>
            Closes{" "}
            <strong className="text-foreground">
              {closing.map((company) => company.name).join(", ")}
            </strong>
            . Everyone&apos;s work for these companies that day counts as a holiday.
          </>
        ) : (
          <>No company is set to {describeRegions(states) || "these states"} yet.</>
        )}
      </p>
      {unset.length > 0 && (
        <p className="text-amber-700 dark:text-amber-400">
          No state set on {unset.map((company) => company.name).join(", ")}. Set it with Edit on
          the company so state holidays reach it.
        </p>
      )}
      {split.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 space-y-1">
          <p className="font-semibold text-amber-800 dark:text-amber-300">
            {split.length} {split.length === 1 ? "person works" : "people work"} in more than one
            state. They get the holiday for their {describeRegions(states)} work only and work as normal
            for their other companies:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {split.map(({ employee, states: theirs }) => (
              <span key={employee.id} className="inline-flex items-center gap-1">
                <span className="font-semibold text-foreground">{employee.name}</span>
                <MultiStateBadge states={theirs} />
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Pick people inside the chosen states, with a search and their work states. */
function PeoplePicker({
  people,
  companies,
  selected,
  search,
  onSearch,
  onChange,
}: {
  people: Employee[];
  companies: Company[];
  selected: string[];
  search: string;
  onSearch: (search: string) => void;
  onChange: (ids: string[]) => void;
}) {
  const term = search.trim().toLowerCase();
  const shown = term
    ? people.filter((employee) =>
        `${employee.name} ${employee.email}`.toLowerCase().includes(term),
      )
    : people;
  const chosen = selected.filter((id) => people.some((employee) => employee.id === id));
  return (
    <div className="rounded-md border bg-secondary/20 p-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Search people"
          className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5 text-xs"
        />
        <button
          type="button"
          onClick={() =>
            onChange([...new Set([...selected, ...shown.map((employee) => employee.id)])])
          }
          className="shrink-0 text-[11px] font-bold text-primary hover:underline"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => onChange([])}
          className="shrink-0 text-[11px] font-bold text-muted-foreground hover:underline"
        >
          Clear
        </button>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2 max-h-48 overflow-y-auto">
        {shown.map((employee) => {
          const states = employeeWorkStates(employee, companies);
          return (
            <label
              key={employee.id}
              className="flex items-start gap-2 rounded-md border bg-background px-2.5 py-1.5 text-xs cursor-pointer"
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.includes(employee.id)}
                onChange={() =>
                  onChange(
                    selected.includes(employee.id)
                      ? selected.filter((id) => id !== employee.id)
                      : [...selected, employee.id],
                  )
                }
              />
              <span className="min-w-0">
                <span className="block truncate font-semibold">{employee.name}</span>
                {states.length > 1 ? (
                  <MultiStateBadge states={states} />
                ) : (
                  <span className="text-[10px] text-muted-foreground">
                    {states[0] ? regionLabel(states[0]) : "No state set"}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {shown.length === 0 && (
          <span className="text-[11px] italic text-muted-foreground">
            {people.length === 0
              ? "Nobody works for a company in these states."
              : "Nobody matches that search."}
          </span>
        )}
      </div>
      <div className="text-[11px] font-semibold text-primary">
        {chosen.length} of {people.length} picked
      </div>
    </div>
  );
}
